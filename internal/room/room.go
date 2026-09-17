package room

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"time"

	"weakestlink/internal/ws"
)

const (
	tickInterval = 500 * time.Millisecond
	idleTimeout  = 15 * time.Minute
)

// --- inbox message shapes ---------------------------------------------------------------
// Everything that touches Room.state flows through the single inbox channel and is
// processed on the Room's own goroutine (Run), so none of the State/action methods
// need any locking — "share memory by communicating."

type attachRequest struct {
	conn   *ws.Conn
	token  string // player token; ignored for controller/host
	result chan AttachResult
}
// AttachResult reports whether a WebSocket connection was accepted into the room.
type AttachResult struct {
	OK     bool
	Reason string
}

type detachMsg struct{ conn *ws.Conn }

type clientMsg struct {
	conn *ws.Conn
	data []byte
}

type joinRequest struct {
	name, rejoinID, rejoinToken string
	result                      chan JoinResult
}
// JoinResult is the outcome of a REST join/rejoin call.
type JoinResult struct {
	PlayerID, Token string
	Denied          bool
	Reason          string
}

type summaryRequest struct{ result chan Summary }

// Summary is a lightweight snapshot for the REST pre-flight check
// (GET /api/rooms/{code}) — deliberately just the fields a join screen needs.
type Summary struct {
	Exists      bool  `json:"exists"`
	Phase       Phase `json:"phase,omitempty"`
	PlayerCount int   `json:"playerCount"`
}

// Room is one game's actor: a goroutine that owns a *State exclusively and
// serves it from a single select loop (inbox + 500ms tick + idle timeout).
type Room struct {
	Code  string
	state *State

	inbox chan any

	players     map[string]*ws.Conn // playerID -> current live conn (only one at a time)
	controllers map[*ws.Conn]struct{}
	hosts       map[*ws.Conn]struct{}

	stopped bool
}

func NewRoom(code string, state *State) *Room {
	return &Room{
		Code: code, state: state,
		inbox:       make(chan any, 256),
		players:     map[string]*ws.Conn{},
		controllers: map[*ws.Conn]struct{}{},
		hosts:       map[*ws.Conn]struct{}{},
	}
}

// --- public API, safe to call from any goroutine (HTTP handlers) ------------------------

// Join runs a REST join/rejoin call through the actor and returns the result
// synchronously; used by POST /api/rooms/{code}/players.
func (r *Room) Join(name, rejoinID, rejoinToken string) JoinResult {
	reply := make(chan JoinResult, 1)
	r.inbox <- joinRequest{name: name, rejoinID: rejoinID, rejoinToken: rejoinToken, result: reply}
	return <-reply
}

// Attach registers a freshly upgraded WebSocket connection with the room. For
// players, token must match the one issued by Join. Blocks briefly for the
// actor to validate and (on success) push the connection its first state.
func (r *Room) Attach(c *ws.Conn, token string) AttachResult {
	reply := make(chan AttachResult, 1)
	r.inbox <- attachRequest{conn: c, token: token, result: reply}
	return <-reply
}

func (r *Room) Detach(c *ws.Conn) {
	r.inbox <- detachMsg{conn: c}
}

func (r *Room) HandleClientMessage(c *ws.Conn, data []byte) {
	r.inbox <- clientMsg{conn: c, data: data}
}

func (r *Room) Summary() Summary {
	reply := make(chan Summary, 1)
	select {
	case r.inbox <- summaryRequest{result: reply}:
		select {
		case s := <-reply:
			return s
		case <-time.After(2 * time.Second):
			return Summary{}
		}
	case <-time.After(2 * time.Second):
		return Summary{} // actor wedged or already gone
	}
}

// --- the actor loop -----------------------------------------------------------------------

// Run drives the room until it's closed, goes idle, or ctx is cancelled.
// onEmpty is invoked (once) so the caller (Manager) can drop it from the registry.
func (r *Room) Run(ctx context.Context, onEmpty func(code string)) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()

	for {
		select {
		case raw := <-r.inbox:
			changed := r.dispatch(raw)
			if r.stopped {
				r.closeAll()
				onEmpty(r.Code)
				return
			}
			if changed {
				r.broadcast()
			}
			if r.connectionCount() > 0 {
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				idle.Reset(idleTimeout)
			}
		case now := <-ticker.C:
			if r.tick(now.UnixMilli()) {
				r.broadcast()
			}
		case <-idle.C:
			r.closeAll()
			onEmpty(r.Code)
			return
		case <-ctx.Done():
			r.closeAll()
			return
		}
	}
}

func (r *Room) dispatch(raw any) (changed bool) {
	switch v := raw.(type) {
	case attachRequest:
		return r.handleAttach(v)
	case detachMsg:
		return r.handleDetach(v.conn)
	case clientMsg:
		return r.handleClientMessage(v.conn, v.data)
	case joinRequest:
		return r.handleJoin(v)
	case summaryRequest:
		v.result <- Summary{Exists: true, Phase: r.state.Phase, PlayerCount: len(r.state.Players)}
		return false
	}
	return false
}

func (r *Room) handleJoin(req joinRequest) bool {
	now := time.Now().UnixMilli()
	p, _, denied, reason := r.state.Join(req.name, req.rejoinID, req.rejoinToken, now)
	if denied {
		req.result <- JoinResult{Denied: true, Reason: reason}
		return false
	}
	req.result <- JoinResult{PlayerID: p.ID, Token: p.Token}
	return true
}

func (r *Room) handleAttach(req attachRequest) bool {
	now := time.Now().UnixMilli()
	switch req.conn.Role {
	case ws.RolePlayer:
		p, reconnected, ok := r.state.AttachPlayer(req.conn.PlayerID, req.token, now)
		if !ok {
			req.result <- AttachResult{OK: false, Reason: "That player session is no longer valid — please rejoin."}
			return false
		}
		if old, exists := r.players[p.ID]; exists && old != req.conn {
			old.Close()
		}
		r.players[p.ID] = req.conn
		req.result <- AttachResult{OK: true}
		req.conn.SendJSON(ws.Msg(ws.ServerMsgState, "state", r.state.ToPlayerState(p.ID), "now", now))
		return reconnected
	case ws.RoleController:
		// The room code alone is deliberately public (every player needs it to
		// join), so controller access — which sees answers and can mark scores
		// — requires this separate secret, checked in constant time since it's
		// the one place in this app a secret is compared over the network.
		if req.token == "" || subtle.ConstantTimeCompare([]byte(req.token), []byte(r.state.ControllerKey)) != 1 {
			req.result <- AttachResult{OK: false, Reason: "Invalid or missing quizmaster key."}
			return false
		}
		r.controllers[req.conn] = struct{}{}
		req.result <- AttachResult{OK: true}
		req.conn.SendJSON(ws.Msg(ws.ServerMsgControllerState, "state", r.state.ToControllerState(), "now", now))
		return false
	case ws.RoleHost:
		r.hosts[req.conn] = struct{}{}
		req.result <- AttachResult{OK: true}
		req.conn.SendJSON(ws.Msg(ws.ServerMsgHostState, "state", r.state.ToPlayerState(""), "now", now))
		return false
	}
	req.result <- AttachResult{OK: false, Reason: "Unknown role."}
	return false
}

func (r *Room) handleDetach(c *ws.Conn) bool {
	switch c.Role {
	case ws.RolePlayer:
		if cur, ok := r.players[c.PlayerID]; ok && cur == c {
			delete(r.players, c.PlayerID)
			r.state.DetachPlayer(c.PlayerID, time.Now().UnixMilli())
			return true
		}
	case ws.RoleController:
		delete(r.controllers, c)
	case ws.RoleHost:
		delete(r.hosts, c)
	}
	return false
}

func (r *Room) handleClientMessage(c *ws.Conn, data []byte) bool {
	var env ws.ClientEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		c.SendJSON(ws.Msg(ws.ServerMsgError, "code", "bad_json", "message", "Malformed message."))
		return false
	}
	now := time.Now().UnixMilli()
	switch c.Role {
	case ws.RolePlayer:
		return r.handlePlayerMessage(c, env, now)
	case ws.RoleController:
		return r.handleControllerMessage(c, env, now)
	default:
		return false // host connections are read-only/display-only
	}
}

func (r *Room) handlePlayerMessage(c *ws.Conn, env ws.ClientEnvelope, now int64) bool {
	switch env.Type {
	case ws.ClientMsgVote:
		return r.state.SubmitVote(c.PlayerID, env.TargetID)
	case ws.ClientMsgCallBank:
		return r.state.CallBank(c.PlayerID, now)
	case ws.ClientMsgRename:
		ok, reason := r.state.Rename(c.PlayerID, env.NewName, now)
		if !ok && reason != "" {
			c.SendJSON(ws.Msg(ws.ServerMsgRenameFailed, "reason", reason))
		}
		return ok
	}
	return false
}

func (r *Room) handleControllerMessage(c *ws.Conn, env ws.ClientEnvelope, now int64) bool {
	if env.Type != ws.ClientMsgControl {
		return false
	}
	switch env.Action {
	case ws.ActionStartGame:
		return r.state.DoStartGame(now)
	case ws.ActionSelectAsked:
		return r.state.DoSelectAsked(argString(env.Arg))
	case ws.ActionNextQuestion:
		return r.state.DoNextQuestion()
	case ws.ActionMarkCorrect:
		return r.state.DoMarkCorrect(now)
	case ws.ActionMarkIncorrect:
		return r.state.DoMarkIncorrect(now)
	case ws.ActionBankChain:
		return r.state.DoBankChain("", now)
	case ws.ActionEndRound:
		return r.state.DoEndRound(now)
	case ws.ActionStartVoteReveal:
		return r.state.DoStartVoteReveal()
	case ws.ActionAdvanceReveal:
		return r.state.DoAdvanceReveal(now)
	case ws.ActionManualTieBreak:
		return r.state.DoManualTieBreak(argString(env.Arg), now)
	case ws.ActionContinueAfterElimination:
		return r.state.DoContinueAfterElimination(now)
	case ws.ActionShootoutNextQuestion:
		return r.state.DoShootoutNextQuestion()
	case ws.ActionShootoutMark:
		return r.state.DoShootoutMark(argString(env.Arg), now)
	case ws.ActionPlayAgain:
		r.state.DoPlayAgain()
		return true
	case ws.ActionKickPlayer:
		id := argString(env.Arg)
		if !r.state.DoKickPlayer(id, now) {
			return false
		}
		if conn, exists := r.players[id]; exists {
			conn.SendJSON(ws.Msg(ws.ServerMsgKicked))
			conn.Close()
			delete(r.players, id)
		}
		return true
	case ws.ActionAddPlayer:
		return r.state.DoAddPlayer(argString(env.Arg), now)
	case ws.ActionSetQuestionBank:
		var payload struct {
			Questions []Question `json:"questions"`
		}
		if err := json.Unmarshal(env.Arg, &payload); err != nil {
			return false
		}
		return r.state.DoSetQuestionBank(payload.Questions, now)
	case ws.ActionResetQuestionBank:
		return r.state.DoResetQuestionBank(now)
	case ws.ActionRequestQuestionBank:
		c.SendJSON(ws.Msg(ws.ServerMsgQuestionBankData, "questions", r.state.QuestionBank))
		return false
	case ws.ActionCloseRoom:
		r.closeRoom()
		return false // closeRoom already notifies + tears down directly
	}
	return false
}

func argString(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

func (r *Room) closeRoom() {
	conns := make([]*ws.Conn, 0, len(r.players)+len(r.controllers)+len(r.hosts))
	for _, c := range r.players {
		c.SendJSON(ws.Msg(ws.ServerMsgRoomClosed))
		conns = append(conns, c)
	}
	for c := range r.controllers {
		c.SendJSON(ws.Msg(ws.ServerMsgRoomClosed))
		conns = append(conns, c)
	}
	for c := range r.hosts {
		c.SendJSON(ws.Msg(ws.ServerMsgRoomClosed))
		conns = append(conns, c)
	}
	r.players = map[string]*ws.Conn{}
	r.controllers = map[*ws.Conn]struct{}{}
	r.hosts = map[*ws.Conn]struct{}{}
	r.stopped = true

	// SendJSON only queues the message — the write pump goroutine is what
	// actually flushes it to the socket. Closing the connection immediately
	// (as this used to) races that flush and often wins, so the client never
	// receives the roomClosed notice at all and just sees a bare disconnect.
	// A brief delay before tearing down the transport (matching the original
	// client-only version's identical 400ms pause, for the identical reason)
	// gives every write pump time to actually send it first.
	go func() {
		time.Sleep(400 * time.Millisecond)
		for _, c := range conns {
			c.Close()
		}
	}()
}

func (r *Room) tick(nowMs int64) bool {
	switch r.state.Phase {
	case PhaseCountdown:
		if nowMs >= r.state.CountdownEndsAt {
			r.state.FinishCountdown(nowMs)
			return true
		}
	case PhasePlaying:
		if r.state.Timer.Running && nowMs >= r.state.Timer.EndsAt {
			r.state.DoEndRound(nowMs)
			return true
		}
	}
	return false
}

func (r *Room) broadcast() {
	// "now" rides along on every state push (no extra chatter — these messages
	// already go out on every change) so clients can correct for their own
	// clock drift when counting down against the absolute timer/countdown
	// deadlines below, instead of trusting their local Date.now() outright.
	now := time.Now().UnixMilli()
	for id, c := range r.players {
		c.SendJSON(ws.Msg(ws.ServerMsgState, "state", r.state.ToPlayerState(id), "now", now))
	}
	if len(r.controllers) > 0 {
		cs := r.state.ToControllerState()
		for c := range r.controllers {
			c.SendJSON(ws.Msg(ws.ServerMsgControllerState, "state", cs, "now", now))
		}
	}
	if len(r.hosts) > 0 {
		hs := r.state.ToPlayerState("")
		for c := range r.hosts {
			c.SendJSON(ws.Msg(ws.ServerMsgHostState, "state", hs, "now", now))
		}
	}
}

func (r *Room) connectionCount() int {
	return len(r.players) + len(r.controllers) + len(r.hosts)
}

func (r *Room) closeAll() {
	for _, c := range r.players {
		c.Close()
	}
	for c := range r.controllers {
		c.Close()
	}
	for c := range r.hosts {
		c.Close()
	}
}
