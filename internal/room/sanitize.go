package room

// This file builds the per-audience DTOs broadcast to clients, mirroring
// sanitizeForPlayer/sanitizeForController from the original JS: players and
// the host's big screen must NEVER receive the current answer; only the
// controller (quizmaster) does.

type PlayerPublic struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Alive     bool   `json:"alive"`
	Correct   int    `json:"correct"`
	Incorrect int    `json:"incorrect"`
	Connected bool   `json:"connected"`
}

func toPlayerPublic(players []*Player) []PlayerPublic {
	out := make([]PlayerPublic, len(players))
	for i, p := range players {
		out[i] = PlayerPublic{ID: p.ID, Name: p.Name, Alive: p.Alive, Correct: p.Correct, Incorrect: p.Incorrect, Connected: p.Connected}
	}
	return out
}

type RevealInfo struct {
	VoterName   string  `json:"voterName"`
	VotedForID  string  `json:"-"`
	VotedForName *string `json:"votedForName"`
	Index       int     `json:"index"`
	Total       int     `json:"total"`
}

func (s *State) revealInfo() *RevealInfo {
	if !s.Revealing || s.RevealOrder == nil {
		return nil
	}
	targetID := s.RevealOrder[s.RevealIndex]
	voter := s.FindPlayer(targetID)
	votedForID, voted := s.Votes[targetID]
	var votedForName *string
	if voted {
		if vf := s.FindPlayer(votedForID); vf != nil {
			votedForName = &vf.Name
		}
	}
	voterName := ""
	if voter != nil {
		voterName = voter.Name
	}
	return &RevealInfo{VoterName: voterName, VotedForName: votedForName, Index: s.RevealIndex, Total: len(s.RevealOrder)}
}

// ShootoutPublic omits the answer text (player/host view) but still carries
// the question text itself — the host's big screen shows shootout questions
// the same way it shows regular-round questions, just never the answer.
type ShootoutPublic struct {
	Order             []ShootoutSeat  `json:"order"`
	Rounds            []ShootoutRound `json:"rounds"`
	CurrentRoundIndex int             `json:"currentRoundIndex"`
	CurrentTurn       int             `json:"currentTurn"`
	Sudden            bool            `json:"sudden"`
	WinnerID          string          `json:"winnerId"`
	CurrentQuestion   *PlayerQuestion `json:"currentQuestion"`
}

// ShootoutController additionally includes the current question's answer.
type ShootoutController struct {
	ShootoutPublic
	CurrentQuestion *Question `json:"currentQuestion"`
}

type ShootoutSeat struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *State) shootoutSeats() []ShootoutSeat {
	sh := s.Shootout
	seats := make([]ShootoutSeat, 2)
	for i, id := range sh.Order {
		name := ""
		if p := s.FindPlayer(id); p != nil {
			name = p.Name
		}
		seats[i] = ShootoutSeat{ID: id, Name: name}
	}
	return seats
}

func (s *State) shootoutPublic() *ShootoutPublic {
	if s.Shootout == nil {
		return nil
	}
	var cq *PlayerQuestion
	if s.Shootout.CurrentQuestion != nil {
		cq = &PlayerQuestion{Q: s.Shootout.CurrentQuestion.Q}
	}
	return &ShootoutPublic{
		Order: s.shootoutSeats(), Rounds: s.Shootout.Rounds,
		CurrentRoundIndex: s.Shootout.CurrentRoundIndex, CurrentTurn: s.Shootout.CurrentTurn,
		Sudden: s.Shootout.Sudden, WinnerID: s.Shootout.WinnerID, CurrentQuestion: cq,
	}
}

func (s *State) shootoutController() *ShootoutController {
	base := s.shootoutPublic()
	if base == nil {
		return nil
	}
	return &ShootoutController{ShootoutPublic: *base, CurrentQuestion: s.Shootout.CurrentQuestion}
}

// PlayerQuestion strips the answer, matching {q} on the wire for players/host.
type PlayerQuestion struct {
	Q string `json:"q"`
}

// PlayerState is broadcast to each player individually (MyID/VotedAlready are
// per-recipient) and, with MyID/VotedAlready omitted, to the host display too.
type PlayerState struct {
	Phase           Phase           `json:"phase"`
	RoomCode        string          `json:"roomCode"`
	Players         []PlayerPublic  `json:"players"`
	ChainIndex      int             `json:"chainIndex"`
	ChainValue      int             `json:"chainValue"`
	Bank            int             `json:"bank"`
	Round           int             `json:"round"`
	CurrentAskedID  string          `json:"currentAskedId"`
	CurrentQuestion *PlayerQuestion `json:"currentQuestion"`
	Timer           Timer           `json:"timer"`
	CountdownEndsAt int64           `json:"countdownEndsAt"`
	MyID            string          `json:"myId,omitempty"`
	VotedAlready    bool            `json:"votedAlready,omitempty"`
	Revealing       bool            `json:"revealing"`
	RevealInfo      *RevealInfo     `json:"revealInfo"`
	LastElimination *Elimination    `json:"lastElimination"`
	Shootout        *ShootoutPublic `json:"shootout"`
	Winner          string          `json:"winner,omitempty"`
}

func (s *State) chainValue() int {
	if s.ChainIndex >= 0 {
		return ChainValues[s.ChainIndex]
	}
	return 0
}

func (s *State) currentQuestionPublic() *PlayerQuestion {
	if s.CurrentQuestion == nil {
		return nil
	}
	return &PlayerQuestion{Q: s.CurrentQuestion.Q}
}

// ToPlayerState builds the sanitized view for a specific player (forPlayerID
// may be "" for the host/spectator display, which gets the same shape minus
// the per-player fields).
func (s *State) ToPlayerState(forPlayerID string) PlayerState {
	_, voted := s.Votes[forPlayerID]
	return PlayerState{
		Phase: s.Phase, RoomCode: s.RoomCode,
		Players: toPlayerPublic(s.Players),
		ChainIndex: s.ChainIndex, ChainValue: s.chainValue(), Bank: s.Bank, Round: s.Round,
		CurrentAskedID: s.CurrentAskedID, CurrentQuestion: s.currentQuestionPublic(),
		Timer: s.Timer, CountdownEndsAt: s.CountdownEndsAt,
		MyID: forPlayerID, VotedAlready: forPlayerID != "" && voted,
		Revealing: s.Revealing, RevealInfo: s.revealInfo(),
		LastElimination: s.LastElimination, Shootout: s.shootoutPublic(), Winner: s.Winner,
	}
}

// ControllerQuestion includes the answer — the quizmaster is the only role allowed to see it.
type ControllerQuestion struct {
	Q string `json:"q"`
	A string `json:"a"`
}

type ControllerState struct {
	Phase             Phase                `json:"phase"`
	RoomCode          string               `json:"roomCode"`
	Round             int                  `json:"round"`
	Players           []PlayerPublic       `json:"players"`
	ChainIndex        int                  `json:"chainIndex"`
	ChainValue        int                  `json:"chainValue"`
	Bank              int                  `json:"bank"`
	CurrentAskedID    string               `json:"currentAskedId"`
	AskedName         string               `json:"askedName,omitempty"`
	CurrentQuestion   *ControllerQuestion  `json:"currentQuestion"`
	Timer             Timer                `json:"timer"`
	CountdownEndsAt   int64                `json:"countdownEndsAt"`
	VotedCount        int                  `json:"votedCount"`
	Revealing         bool                 `json:"revealing"`
	RevealOrder       []string             `json:"revealOrder"`
	RevealIndex       int                  `json:"revealIndex"`
	RevealInfo        *RevealInfo          `json:"revealInfo"`
	TieCandidates     []string             `json:"tieCandidates"`
	LastElimination   *Elimination         `json:"lastElimination"`
	Shootout          *ShootoutController  `json:"shootout"`
	Winner            string               `json:"winner,omitempty"`
	QuestionBankCount int                  `json:"questionBankCount"`
	UsingCustom       bool                 `json:"usingCustom"`
	Log               []LogEntry           `json:"log"`
}

func (s *State) ToControllerState() ControllerState {
	var askedName string
	if p := s.FindPlayer(s.CurrentAskedID); p != nil {
		askedName = p.Name
	}
	var cq *ControllerQuestion
	if s.CurrentQuestion != nil {
		cq = &ControllerQuestion{Q: s.CurrentQuestion.Q, A: s.CurrentQuestion.A}
	}
	return ControllerState{
		Phase: s.Phase, RoomCode: s.RoomCode, Round: s.Round,
		Players: toPlayerPublic(s.Players),
		ChainIndex: s.ChainIndex, ChainValue: s.chainValue(), Bank: s.Bank,
		CurrentAskedID: s.CurrentAskedID, AskedName: askedName, CurrentQuestion: cq,
		Timer: s.Timer, CountdownEndsAt: s.CountdownEndsAt,
		VotedCount: len(s.Votes),
		Revealing: s.Revealing, RevealOrder: s.RevealOrder, RevealIndex: s.RevealIndex, RevealInfo: s.revealInfo(),
		TieCandidates: s.TieCandidates,
		LastElimination: s.LastElimination, Shootout: s.shootoutController(), Winner: s.Winner,
		QuestionBankCount: len(s.QuestionBank), UsingCustom: s.UsingCustom,
		Log: s.Log,
	}
}
