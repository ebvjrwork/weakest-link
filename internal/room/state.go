// Package room implements the Chain Reaction game engine: a pure, in-memory
// state machine with no network or storage dependencies, so it can be unit
// tested in isolation and driven by any transport (see internal/ws).
package room

import (
	"crypto/rand"
	"encoding/hex"
	"math/big"
)

// ChainValues is the money ladder a player climbs one correct answer at a time.
var ChainValues = []int{20, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000}

type Phase string

const (
	PhaseLobby       Phase = "lobby"
	PhaseCountdown   Phase = "countdown"
	PhasePlaying     Phase = "playing"
	PhaseVoting      Phase = "voting"
	PhaseElimination Phase = "elimination"
	PhaseShootout    Phase = "shootout"
	PhaseGameOver    Phase = "gameover"
)

type CountdownTarget string

const (
	TargetNone     CountdownTarget = ""
	TargetRound    CountdownTarget = "round"
	TargetShootout CountdownTarget = "shootout"
)

// Question is a trivia question/answer pair.
type Question struct {
	Q string `json:"q"`
	A string `json:"a"`
}

// Player mirrors the JS player object shape, plus a server-side-only Token
// (never serialized/broadcast) used to authenticate WS reconnects.
type Player struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Alive     bool   `json:"alive"`
	Correct   int    `json:"correct"`
	Incorrect int    `json:"incorrect"`
	Connected bool   `json:"connected"`
	Token     string `json:"-"`
}

type Timer struct {
	Duration int   `json:"duration"` // seconds
	EndsAt   int64 `json:"endsAt"`   // epoch ms
	Running  bool  `json:"running"`
}

type EliminationTally struct {
	Name  string `json:"name"`
	Votes int    `json:"votes"`
}

type Elimination struct {
	Name  string             `json:"name"`
	Tally []EliminationTally `json:"tally"`
	Note  string             `json:"note"`
}

// ShootoutRound records both players' results for one wave of the shootout.
// A nil pointer means "not yet answered", matching the JS `null`.
type ShootoutRound struct {
	P0 *string `json:"p0"`
	P1 *string `json:"p1"`
}

type Shootout struct {
	Order             [2]string       `json:"order"`
	Rounds            []ShootoutRound `json:"rounds"`
	CurrentRoundIndex int             `json:"currentRoundIndex"`
	CurrentTurn       int             `json:"currentTurn"` // 0 or 1, index into Order
	CurrentQuestion   *Question       `json:"currentQuestion"`
	Sudden            bool            `json:"sudden"`
	WinnerID          string          `json:"winnerId"`
}

type LogEntry struct {
	T   int64  `json:"t"`
	Msg string `json:"msg"`
}

// State is the full authoritative game state for one room — the Go
// equivalent of the JS `H` object. Only the owning Room actor goroutine
// (see room.go) may ever touch a State value; that is what makes every
// method on it safe to call without locks.
type State struct {
	Phase         Phase
	RoomCode      string
	RoundDuration int // seconds, fixed at room creation

	// ControllerKey is a separate secret from RoomCode, required to attach as
	// the quizmaster controller. RoomCode alone is intentionally public (every
	// player needs it to join), so without a second secret anyone who can join
	// the game could also open the controller and see answers / mark scores.
	// Never sent in any broadcast state — only returned once, directly from
	// POST /api/rooms.
	ControllerKey string

	Players []*Player

	ChainIndex int // -1 means no live chain
	Bank       int
	Round      int

	CurrentAskedID  string
	CurrentQuestion *Question

	Timer Timer

	Votes map[string]string // voterID -> targetID

	LastElimination *Elimination
	TieCandidates   []string
	TieTally        map[string]int

	Revealing   bool
	RevealOrder []string
	RevealIndex int

	CountdownEndsAt int64
	CountdownTarget CountdownTarget

	Shootout *Shootout
	Winner   string

	Log []LogEntry

	QuestionBank []Question
	UsingCustom  bool
	deck         []Question // shuffled draw pile, refilled from QuestionBank

	// communityBank is the snapshot fetched from the DB when the room was
	// created; DoResetQuestionBank() reverts to it after a custom upload.
	communityBank []Question
}

// NewState builds a fresh lobby-phase state, mirroring newHostState().
// communityBank is the room's default bank (the server's shared/community
// question bank at creation time); if usingCustom is true, bank is the
// one-off custom set supplied at room creation instead. controllerKey must be
// generated once at room creation (see Manager.Create) and preserved across
// DoPlayAgain — it is NOT regenerated here, since NewState is also called on
// every play-again reset and rotating it would silently lock out an already
// -connected quizmaster's saved link.
func NewState(roomCode, controllerKey string, roundDuration int, communityBank []Question, bank []Question, usingCustom bool) *State {
	return &State{
		Phase:         PhaseLobby,
		RoomCode:      roomCode,
		ControllerKey: controllerKey,
		RoundDuration: roundDuration,
		Players:       []*Player{},
		ChainIndex:    -1,
		Round:         1,
		Timer:         Timer{Duration: roundDuration},
		Votes:         map[string]string{},
		QuestionBank:  bank,
		UsingCustom:   usingCustom,
		communityBank: communityBank,
	}
}

const maxLogEntries = 8

// PushLog prepends a log entry, matching pushLog()'s newest-first, capped-at-8 behavior.
func (s *State) PushLog(now int64, msg string) {
	s.Log = append([]LogEntry{{T: now, Msg: msg}}, s.Log...)
	if len(s.Log) > maxLogEntries {
		s.Log = s.Log[:maxLogEntries]
	}
}

// emptyBankQuestion is returned defensively if a room's question bank is
// empty (e.g. every question was deleted mid-game) so callers never index
// into an empty deck instead of crashing.
var emptyBankQuestion = Question{Q: "No questions available — ask the admin to add some.", A: "—"}

// PullQuestion draws from a shuffled deck, refilling/reshuffling from the
// active question bank whenever it's exhausted — an unbiased
// draw-without-replacement-until-exhausted, matching pullQuestion().
func (s *State) PullQuestion() Question {
	if len(s.deck) == 0 {
		if len(s.QuestionBank) == 0 {
			return emptyBankQuestion
		}
		s.deck = shuffledCopy(s.QuestionBank)
	}
	last := len(s.deck) - 1
	q := s.deck[last]
	s.deck = s.deck[:last]
	return q
}

func shuffledCopy(qs []Question) []Question {
	out := make([]Question, len(qs))
	copy(out, qs)
	for i := len(out) - 1; i > 0; i-- {
		j := randIntn(i + 1)
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// randIntn returns a uniform random int in [0, n) using crypto/rand, so the
// room package has no dependency on math/rand seeding behavior.
func randIntn(n int) int {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}

// AlivePlayers returns players with Alive==true, in roster order.
func (s *State) AlivePlayers() []*Player {
	out := make([]*Player, 0, len(s.Players))
	for _, p := range s.Players {
		if p.Alive {
			out = append(out, p)
		}
	}
	return out
}

// FindPlayer returns the player with the given id, or nil.
func (s *State) FindPlayer(id string) *Player {
	for _, p := range s.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

const roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ" // no O/I, matching genRoomCode()

// GenRoomCode returns a random 4-letter room code from an unambiguous alphabet.
func GenRoomCode() string {
	b := make([]byte, 4)
	for i := range b {
		b[i] = roomCodeAlphabet[randIntn(len(roomCodeAlphabet))]
	}
	return string(b)
}

// NewID returns a random opaque identifier, used for player IDs and reconnect tokens.
func NewID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
