package ws

import "encoding/json"

// ClientEnvelope is the shape of every inbound message: {type, ...}. Which
// fields matter depends on Type. This intentionally mirrors the original
// PeerJS-era {type:'...'} envelope so the frontend's message dispatch barely
// changes when the transport swaps from PeerJS to a plain WebSocket.
type ClientEnvelope struct {
	Type string `json:"type"`

	// player messages
	TargetID string `json:"targetId,omitempty"` // vote
	NewName  string `json:"newName,omitempty"`  // rename

	// controller messages
	Action string          `json:"action,omitempty"`
	Arg    json.RawMessage `json:"arg,omitempty"`
}

// Inbound message types.
const (
	ClientMsgVote     = "vote"
	ClientMsgCallBank = "callBank"
	ClientMsgRename   = "rename"
	ClientMsgControl  = "control"
)

// Control actions carried in ClientEnvelope.Action when Type == "control",
// ported 1:1 from the original CONTROL_ACTIONS table.
const (
	ActionStartGame                = "startGame"
	ActionSelectAsked              = "selectAsked"
	ActionNextQuestion             = "nextQuestion"
	ActionMarkCorrect              = "markCorrect"
	ActionMarkIncorrect            = "markIncorrect"
	ActionBankChain                = "bankChain"
	ActionEndRound                 = "endRound"
	ActionStartVoteReveal          = "startVoteReveal"
	ActionAdvanceReveal            = "advanceReveal"
	ActionManualTieBreak           = "manualTieBreak"
	ActionContinueAfterElimination = "continueAfterElimination"
	ActionShootoutNextQuestion     = "shootoutNextQuestion"
	ActionShootoutMark             = "shootoutMark"
	ActionPlayAgain                = "playAgain"
	ActionKickPlayer               = "kickPlayer"
	ActionAddPlayer                = "addPlayer"
	ActionSetQuestionBank          = "setQuestionBank"
	ActionResetQuestionBank        = "resetQuestionBank"
	ActionRequestQuestionBank      = "requestQuestionBank"
	ActionCloseRoom                = "closeRoom"
)

// Outbound message type strings.
const (
	ServerMsgState            = "state"
	ServerMsgControllerState  = "controllerState"
	ServerMsgHostState        = "hostState"
	ServerMsgQuestionBankData = "questionBankData"
	ServerMsgKicked           = "kicked"
	ServerMsgRenameFailed     = "renameFailed"
	ServerMsgRoomClosed       = "roomClosed"
	ServerMsgError            = "error"
)

// Envelope is a tiny helper for building outbound {type, ...} payloads
// without a bespoke struct per message (used for the fixed-shape ones).
type Envelope map[string]any

func Msg(typ string, fields ...any) Envelope {
	e := Envelope{"type": typ}
	for i := 0; i+1 < len(fields); i += 2 {
		if key, ok := fields[i].(string); ok {
			e[key] = fields[i+1]
		}
	}
	return e
}
