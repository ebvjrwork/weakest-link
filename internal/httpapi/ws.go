package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"

	wsconn "weakestlink/internal/ws"
)

const (
	heartbeatInterval = 25 * time.Second
	heartbeatTimeout  = 10 * time.Second
)

// handleWS upgrades the connection and attaches it to a room. Role and
// identity come entirely from query params — there's no WS-level
// "join"/"joinController" handshake message, because the server already
// knows who's connecting: players present the playerId+token issued by
// POST /api/rooms/{code}/players, and controller/host only need the room code.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	rm, ok := s.Rooms.Get(code)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	var role wsconn.Role
	var playerID, token string
	switch r.URL.Query().Get("role") {
	case "player":
		role = wsconn.RolePlayer
		playerID = r.URL.Query().Get("playerId")
		token = r.URL.Query().Get("token")
		if playerID == "" || token == "" {
			http.Error(w, "missing playerId/token", http.StatusBadRequest)
			return
		}
	case "controller":
		role = wsconn.RoleController
		// A separate secret from the room code — see room.State.ControllerKey.
		token = r.URL.Query().Get("key")
	case "host":
		role = wsconn.RoleHost
	default:
		http.Error(w, "invalid role", http.StatusBadRequest)
		return
	}

	// Same-origin only by default (Accept's built-in Origin check) — the
	// frontend is always served from this same binary, so no cross-origin
	// WebSocket access is ever legitimate here.
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn := wsconn.NewConn(c, role, code, playerID)

	res := rm.Attach(conn, token)
	if !res.OK {
		// No write pump is running yet, so a JSON error message would never
		// actually be flushed — the close frame's reason string is the only
		// channel available here, and the browser exposes it as CloseEvent.reason.
		c.Close(websocket.StatusPolicyViolation, res.Reason)
		return
	}

	// The request's context is cancelled as soon as this handler returns, so
	// the pumps run against their own context, torn down together via cancel
	// once any one of them exits (read error, write error, or a missed heartbeat).
	connCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go wsconn.HeartbeatPump(connCtx, conn, heartbeatInterval, heartbeatTimeout)
	go wsconn.WritePump(connCtx, conn)
	wsconn.ReadPump(connCtx, conn,
		func(data []byte) { rm.HandleClientMessage(conn, data) },
		func() { rm.Detach(conn); cancel() },
	)
}
