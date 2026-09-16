// Package ws provides a thin WebSocket connection wrapper: framing, a
// buffered outbound queue, read/write pumps, and heartbeat. It knows nothing
// about the game — internal/room imports this package (not the other way
// around) to track per-room connection registries and broadcast state.
package ws

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

type Role string

const (
	RolePlayer     Role = "player"
	RoleController Role = "controller"
	RoleHost       Role = "host"
)

const sendBuffer = 32

// Conn wraps one WebSocket connection with a buffered outbound queue, so a
// single slow/locked-screen client can never block a broadcast to everyone
// else in the room — sends beyond the buffer are dropped, not queued forever.
type Conn struct {
	WS       *websocket.Conn
	Role     Role
	RoomCode string
	PlayerID string // set only for Role == RolePlayer

	send   chan []byte
	closed chan struct{}
}

func NewConn(wsConn *websocket.Conn, role Role, roomCode, playerID string) *Conn {
	return &Conn{
		WS: wsConn, Role: role, RoomCode: roomCode, PlayerID: playerID,
		send: make(chan []byte, sendBuffer), closed: make(chan struct{}),
	}
}

// SendJSON marshals v and enqueues it for the write pump. It never blocks:
// if the outbound buffer is full the message is dropped (the next broadcast
// will carry fresh state anyway) rather than stalling the caller, which is
// typically a room's single actor goroutine serving every other client too.
func (c *Conn) SendJSON(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	select {
	case c.send <- b:
		return true
	case <-c.closed:
		return false
	default:
		return false
	}
}

func (c *Conn) Close() {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	_ = c.WS.Close(websocket.StatusNormalClosure, "")
}

// ReadPump reads frames until the connection errs or closes, decoding each
// into T via onMessage. Run in its own goroutine; blocks until done, then
// calls onClose exactly once so the caller can detach the player/conn.
func ReadPump(ctx context.Context, c *Conn, onMessage func(data []byte), onClose func()) {
	defer onClose()
	for {
		_, data, err := c.WS.Read(ctx)
		if err != nil {
			return
		}
		onMessage(data)
	}
}

// WritePump drains the outbound queue to the socket. Run in its own goroutine.
func WritePump(ctx context.Context, c *Conn) {
	defer c.Close()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.WS.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-c.closed:
			return
		case <-ctx.Done():
			return
		}
	}
}

// HeartbeatPump pings periodically; a missed pong (or any ping error) closes
// the connection so a half-open socket (e.g. a locked phone behind a proxy)
// doesn't linger — the client's net.js wrapper then reconnects with backoff.
func HeartbeatPump(ctx context.Context, c *Conn, interval, timeout time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			pingCtx, cancel := context.WithTimeout(ctx, timeout)
			err := c.WS.Ping(pingCtx)
			cancel()
			if err != nil {
				c.Close()
				return
			}
		case <-c.closed:
			return
		case <-ctx.Done():
			return
		}
	}
}
