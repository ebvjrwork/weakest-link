package room

import (
	"fmt"
	"strings"
)

const countdownMs = 5000

func cleanName(name string) string {
	name = strings.TrimSpace(name)
	r := []rune(name)
	if len(r) > 18 {
		r = r[:18]
	}
	return strings.TrimSpace(string(r))
}

// joinName mirrors the JS join handler's `(name || 'Player').trim().slice(0,18) || 'Player'`:
// whitespace-only or empty input always falls back to "Player".
func joinName(name string) string {
	if name == "" {
		name = "Player"
	}
	n := cleanName(name)
	if n == "" {
		n = "Player"
	}
	return n
}

func nameTaken(name string, players []*Player) bool {
	for _, p := range players {
		if strings.EqualFold(p.Name, name) {
			return true
		}
	}
	return false
}

func dedupeName(name string, players []*Player) string {
	final := name
	n := 2
	for nameTaken(final, players) {
		final = fmt.Sprintf("%s %d", name, n)
		n++
	}
	return final
}

// --- turn / timer / countdown plumbing -------------------------------------------------

func (s *State) advanceTurn() {
	alive := s.AlivePlayers()
	if len(alive) == 0 {
		s.CurrentAskedID = ""
		return
	}
	idx := -1
	for i, p := range alive {
		if p.ID == s.CurrentAskedID {
			idx = i
			break
		}
	}
	s.CurrentAskedID = alive[(idx+1)%len(alive)].ID
}

func (s *State) startTimer(now int64) {
	s.Timer = Timer{Duration: s.RoundDuration, EndsAt: now + int64(s.RoundDuration)*1000, Running: true}
}

func (s *State) beginCountdown(now int64, target CountdownTarget) {
	s.Phase = PhaseCountdown
	s.CountdownEndsAt = now + countdownMs
	s.CountdownTarget = target
}

// FinishCountdown transitions countdown->playing or countdown->shootout. Called by the
// room actor's 500ms tick once CountdownEndsAt has passed, mirroring finishCountdown().
func (s *State) FinishCountdown(now int64) {
	target := s.CountdownTarget
	s.CountdownTarget = TargetNone
	if target == TargetShootout {
		s.Phase = PhaseShootout
		s.Shootout.CurrentQuestion = ptrQ(s.PullQuestion())
		s.PushLog(now, "Penalty shootout begins")
		return
	}
	s.Phase = PhasePlaying
	s.CurrentQuestion = ptrQ(s.PullQuestion())
	s.startTimer(now)
	s.PushLog(now, fmt.Sprintf("Round %d begins", s.Round))
}

func ptrQ(q Question) *Question { return &q }

// --- control actions (mirroring CONTROL_ACTIONS / do* functions) -----------------------

func (s *State) DoStartGame(now int64) bool {
	if len(s.Players) < 3 {
		return false
	}
	s.Round = 1
	s.ChainIndex = -1
	s.CurrentAskedID = s.Players[0].ID
	s.CurrentQuestion = nil
	s.PushLog(now, fmt.Sprintf("Game started with %d players", len(s.Players)))
	s.beginCountdown(now, TargetRound)
	return true
}

func (s *State) DoSelectAsked(playerID string) bool {
	if s.Phase != PhasePlaying {
		return false
	}
	p := s.FindPlayer(playerID)
	if p == nil || !p.Alive {
		return false
	}
	s.CurrentAskedID = playerID
	s.CurrentQuestion = ptrQ(s.PullQuestion())
	return true
}

func (s *State) DoNextQuestion() bool {
	if s.Phase != PhasePlaying || s.CurrentAskedID == "" {
		return false
	}
	s.CurrentQuestion = ptrQ(s.PullQuestion())
	return true
}

func (s *State) DoMarkCorrect(now int64) bool {
	if s.CurrentQuestion == nil || s.CurrentAskedID == "" {
		return false
	}
	p := s.FindPlayer(s.CurrentAskedID)
	if p == nil {
		return false
	}
	p.Correct++
	if s.ChainIndex < len(ChainValues)-1 {
		s.ChainIndex++
	}
	s.PushLog(now, fmt.Sprintf("✅ %s correct — chain at $%d", p.Name, ChainValues[s.ChainIndex]))
	s.advanceTurn()
	s.CurrentQuestion = ptrQ(s.PullQuestion())
	return true
}

func (s *State) DoMarkIncorrect(now int64) bool {
	if s.CurrentQuestion == nil || s.CurrentAskedID == "" {
		return false
	}
	p := s.FindPlayer(s.CurrentAskedID)
	if p == nil {
		return false
	}
	p.Incorrect++
	s.PushLog(now, fmt.Sprintf("❌ %s incorrect — chain reset", p.Name))
	s.ChainIndex = -1
	s.advanceTurn()
	s.CurrentQuestion = ptrQ(s.PullQuestion())
	return true
}

func (s *State) DoBankChain(bankerName string, now int64) bool {
	if s.Phase != PhasePlaying || s.ChainIndex < 0 {
		return false
	}
	amt := ChainValues[s.ChainIndex]
	s.Bank += amt
	who := "Banked "
	if bankerName != "" {
		who = bankerName + " banked "
	}
	s.PushLog(now, fmt.Sprintf("\U0001F3E6 %s$%d — total bank $%d", who, amt, s.Bank))
	s.ChainIndex = -1
	return true
}

func (s *State) DoEndRound(now int64) bool {
	if s.Phase != PhasePlaying {
		return false
	}
	s.Phase = PhaseVoting
	s.Votes = map[string]string{}
	s.CurrentQuestion = nil
	s.Revealing = false
	s.RevealOrder = nil
	s.RevealIndex = 0
	s.Timer.Running = false
	s.PushLog(now, fmt.Sprintf("Round %d ended — time to vote", s.Round))
	return true
}

func (s *State) DoStartVoteReveal() bool {
	if s.Phase != PhaseVoting || s.Revealing {
		return false
	}
	alive := s.AlivePlayers()
	order := make([]string, len(alive))
	for i, p := range alive {
		order[i] = p.ID
	}
	s.RevealOrder = order
	s.RevealIndex = 0
	s.Revealing = true
	return true
}

// DoAdvanceReveal steps the vote reveal forward one player; once exhausted it
// resolves the vote. Returns true if state changed (always does when called validly).
func (s *State) DoAdvanceReveal(now int64) bool {
	if !s.Revealing || s.RevealOrder == nil {
		return false
	}
	s.RevealIndex++
	if s.RevealIndex >= len(s.RevealOrder) {
		s.Revealing = false
		s.resolveVotes(now)
		return true
	}
	return true
}

func (s *State) resolveVotes(now int64) {
	alive := s.AlivePlayers()
	tally := map[string]int{}
	for _, p := range alive {
		tally[p.ID] = 0
	}
	for _, target := range s.Votes {
		if _, ok := tally[target]; ok {
			tally[target]++
		}
	}
	maxVotes := -1
	for _, p := range alive {
		if tally[p.ID] > maxVotes {
			maxVotes = tally[p.ID]
		}
	}
	var top []*Player
	for _, p := range alive {
		if tally[p.ID] == maxVotes {
			top = append(top, p)
		}
	}
	if len(top) == 1 {
		s.finalizeElimination(top[0], tally, "", now)
		return
	}

	minScore := 1 << 30
	for _, p := range top {
		if score := p.Correct - p.Incorrect; score < minScore {
			minScore = score
		}
	}
	var stillTied []*Player
	for _, p := range top {
		if p.Correct-p.Incorrect == minScore {
			stillTied = append(stillTied, p)
		}
	}
	if len(stillTied) == 1 {
		s.finalizeElimination(stillTied[0], tally, "Tie broken by in-game performance.", now)
		return
	}

	ids := make([]string, len(stillTied))
	for i, p := range stillTied {
		ids[i] = p.ID
	}
	s.TieCandidates = ids
	s.TieTally = tally
}

func (s *State) finalizeElimination(eliminated *Player, tally map[string]int, note string, now int64) {
	eliminated.Alive = false
	var t []EliminationTally
	for _, p := range s.Players {
		if votes, ok := tally[p.ID]; ok {
			t = append(t, EliminationTally{Name: p.Name, Votes: votes})
		}
	}
	sortTallyDesc(t)
	s.LastElimination = &Elimination{Name: eliminated.Name, Tally: t, Note: note}
	s.TieCandidates = nil
	s.TieTally = nil
	s.Phase = PhaseElimination
	s.PushLog(now, "\U0001F6AA "+eliminated.Name+" voted off as the Weakest Link")
}

func sortTallyDesc(t []EliminationTally) {
	for i := 1; i < len(t); i++ {
		for j := i; j > 0 && t[j].Votes > t[j-1].Votes; j-- {
			t[j], t[j-1] = t[j-1], t[j]
		}
	}
}

func (s *State) DoManualTieBreak(playerID string, now int64) bool {
	p := s.FindPlayer(playerID)
	if p == nil {
		return false
	}
	s.finalizeElimination(p, s.TieTally, "The host broke the tie.", now)
	return true
}

func (s *State) DoContinueAfterElimination(now int64) bool {
	alive := s.AlivePlayers()
	if len(alive) == 2 {
		// Rounds starts as an empty (non-nil) slice, not nil — Go's encoding/json
		// marshals a nil slice as `null`, which would crash frontend code that
		// indexes into shootout.rounds before the first round is recorded.
		s.Shootout = &Shootout{Order: [2]string{alive[0].ID, alive[1].ID}, Rounds: []ShootoutRound{}}
		s.PushLog(now, "Final 2! Get ready for the penalty shootout")
		s.beginCountdown(now, TargetShootout)
		return true
	}
	s.Round++
	s.ChainIndex = -1
	if len(alive) > 0 {
		s.CurrentAskedID = alive[0].ID
	}
	s.CurrentQuestion = nil
	s.beginCountdown(now, TargetRound)
	return true
}

// --- shootout ---------------------------------------------------------------------------

func scoreOf(s *Shootout, idx int) int {
	field := "p0"
	if idx == 1 {
		field = "p1"
	}
	n := 0
	for _, r := range s.Rounds {
		v := r.P0
		if field == "p1" {
			v = r.P1
		}
		if v != nil && *v == "correct" {
			n++
		}
	}
	return n
}

func (s *State) DoShootoutNextQuestion() bool {
	sh := s.Shootout
	if sh == nil || sh.WinnerID != "" {
		return false
	}
	sh.CurrentQuestion = ptrQ(s.PullQuestion())
	return true
}

func (s *State) DoShootoutMark(result string, now int64) bool {
	sh := s.Shootout
	if sh == nil || sh.CurrentQuestion == nil {
		return false
	}
	turnPID := sh.Order[sh.CurrentTurn]
	p := s.FindPlayer(turnPID)
	if p == nil {
		return false
	}
	for len(sh.Rounds) <= sh.CurrentRoundIndex {
		sh.Rounds = append(sh.Rounds, ShootoutRound{})
	}
	res := result
	if sh.CurrentTurn == 0 {
		sh.Rounds[sh.CurrentRoundIndex].P0 = &res
	} else {
		sh.Rounds[sh.CurrentRoundIndex].P1 = &res
	}
	if result == "correct" {
		p.Correct++
	} else {
		p.Incorrect++
	}
	sh.CurrentQuestion = nil
	mark := "❌"
	if result == "correct" {
		mark = "✅"
	}
	s.PushLog(now, p.Name+": "+mark+" in the shootout")

	s.checkShootoutEnd(now)
	if sh.WinnerID == "" {
		if sh.CurrentTurn == 0 {
			sh.CurrentTurn = 1
		} else {
			sh.CurrentTurn = 0
			sh.CurrentRoundIndex++
		}
		sh.CurrentQuestion = ptrQ(s.PullQuestion())
	}
	return true
}

const shootoutRegulationRounds = 5

func (s *State) checkShootoutEnd(now int64) {
	sh := s.Shootout
	r := (*ShootoutRound)(nil)
	if sh.CurrentRoundIndex < len(sh.Rounds) {
		r = &sh.Rounds[sh.CurrentRoundIndex]
	}
	if r == nil || r.P0 == nil || r.P1 == nil {
		return
	}
	if !sh.Sudden {
		sc0, sc1 := scoreOf(sh, 0), scoreOf(sh, 1)
		wavesDone := sh.CurrentRoundIndex + 1
		remain0 := shootoutRegulationRounds - wavesDone
		remain1 := shootoutRegulationRounds - wavesDone
		if wavesDone >= shootoutRegulationRounds {
			if sc0 != sc1 {
				idx := 1
				if sc0 > sc1 {
					idx = 0
				}
				s.declareShootoutWinner(idx, now)
				return
			}
			sh.Sudden = true
			return
		}
		if sc0 > sc1+remain1 {
			s.declareShootoutWinner(0, now)
			return
		}
		if sc1 > sc0+remain0 {
			s.declareShootoutWinner(1, now)
			return
		}
	} else {
		w0 := r.P0 != nil && *r.P0 == "correct"
		w1 := r.P1 != nil && *r.P1 == "correct"
		if w0 && !w1 {
			s.declareShootoutWinner(0, now)
			return
		}
		if w1 && !w0 {
			s.declareShootoutWinner(1, now)
			return
		}
	}
}

func (s *State) declareShootoutWinner(idx int, now int64) {
	sh := s.Shootout
	sh.WinnerID = sh.Order[idx]
	winner := s.FindPlayer(sh.WinnerID)
	s.Phase = PhaseGameOver
	if winner != nil {
		s.Winner = winner.Name
		s.PushLog(now, "\U0001F3C6 "+winner.Name+" wins the game!")
	}
}

// --- lobby / meta -------------------------------------------------------------------------

// DoPlayAgain resets to a fresh lobby, keeping the roster (revived) and question bank.
func (s *State) DoPlayAgain() {
	oldPlayers := make([]*Player, len(s.Players))
	for i, p := range s.Players {
		oldPlayers[i] = &Player{ID: p.ID, Name: p.Name, Alive: true, Connected: p.Connected, Token: p.Token}
	}
	fresh := NewState(s.RoomCode, s.RoundDuration, s.communityBank, s.QuestionBank, s.UsingCustom)
	fresh.Players = oldPlayers
	*s = *fresh
}

func (s *State) DoKickPlayer(playerID string, now int64) bool {
	if s.Phase != PhaseLobby {
		return false
	}
	idx := -1
	for i, p := range s.Players {
		if p.ID == playerID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return false
	}
	name := s.Players[idx].Name
	s.Players = append(s.Players[:idx], s.Players[idx+1:]...)
	s.PushLog(now, name+" was removed by the host")
	return true
}

func (s *State) DoAddPlayer(name string, now int64) bool {
	if s.Phase != PhaseLobby {
		return false
	}
	if name == "" {
		name = "Player"
	}
	n := cleanName(name)
	if n == "" {
		return false
	}
	final := dedupeName(n, s.Players)
	s.Players = append(s.Players, &Player{ID: NewID(), Name: final, Alive: true, Connected: false})
	s.PushLog(now, final+" added by the host")
	return true
}

func (s *State) DoSetQuestionBank(questions []Question, now int64) bool {
	if len(questions) == 0 {
		return false
	}
	s.QuestionBank = questions
	s.deck = nil
	s.UsingCustom = true
	s.PushLog(now, fmt.Sprintf("Loaded %d custom questions", len(questions)))
	return true
}

func (s *State) DoResetQuestionBank(now int64) bool {
	s.QuestionBank = append([]Question{}, s.communityBank...)
	s.deck = nil
	s.UsingCustom = false
	s.PushLog(now, "Reset to the default question bank")
	return true
}

// --- player-facing message handlers (join/vote/callBank/rename) ---------------------------

// Join finds-or-creates a player for a REST join/rejoin call, mirroring the
// fuzzy-reconnect-by-name fallback from handleIncomingHostMessage's 'join' branch,
// hardened with a per-player secret Token (never broadcast) instead of trusting a
// bare id, since state now travels over the open internet rather than a private
// WebRTC channel.
func (s *State) Join(name, rejoinID, rejoinToken string, now int64) (p *Player, reconnected bool, denied bool, denyReason string) {
	incoming := joinName(name)

	if rejoinID != "" {
		if cand := s.FindPlayer(rejoinID); cand != nil && cand.Token == rejoinToken {
			p = cand
		}
	}
	if p == nil {
		for _, pl := range s.Players {
			if !pl.Connected && strings.EqualFold(pl.Name, incoming) {
				p = pl
				break
			}
		}
	}
	if p != nil {
		reconnected = !p.Connected
		p.Connected = true
		p.Token = NewID()
		if reconnected {
			s.PushLog(now, p.Name+" reconnected")
		} else {
			s.PushLog(now, p.Name+" joined")
		}
		return p, reconnected, false, ""
	}

	if s.Phase != PhaseLobby {
		return nil, false, true, "The game is already in progress. Ask the host to start a new room."
	}

	final := dedupeName(incoming, s.Players)
	np := &Player{ID: NewID(), Name: final, Alive: true, Connected: true, Token: NewID()}
	s.Players = append(s.Players, np)
	s.PushLog(now, final+" joined")
	return np, false, false, ""
}

// AttachPlayer validates a reconnecting WebSocket against a previously issued
// token (from Join), without going through the REST join flow again.
// reconnected reports whether the player was previously offline (so the
// caller knows whether this changes what everyone else sees).
func (s *State) AttachPlayer(playerID, token string, now int64) (p *Player, reconnected bool, ok bool) {
	p = s.FindPlayer(playerID)
	if p == nil || token == "" || p.Token != token {
		return nil, false, false
	}
	wasOffline := !p.Connected
	p.Connected = true
	if wasOffline {
		s.PushLog(now, p.Name+" reconnected")
	}
	return p, wasOffline, true
}

// DetachPlayer marks a player offline when their connection drops, mirroring
// handleHostSideDisconnect — the player row is kept, not deleted, so they can rejoin.
func (s *State) DetachPlayer(playerID string, now int64) {
	p := s.FindPlayer(playerID)
	if p == nil || !p.Connected {
		return
	}
	p.Connected = false
	s.PushLog(now, p.Name+" disconnected")
}

func (s *State) SubmitVote(voterID, targetID string) bool {
	if s.Phase != PhaseVoting {
		return false
	}
	voter := s.FindPlayer(voterID)
	if voter == nil || !voter.Alive {
		return false
	}
	s.Votes[voterID] = targetID
	return true
}

// CallBank lets the on-the-spot player bank the chain themselves (in addition
// to the controller's bankChain control action), mirroring the 'callBank' message.
func (s *State) CallBank(playerID string, now int64) bool {
	if s.Phase != PhasePlaying || s.CurrentAskedID != playerID {
		return false
	}
	p := s.FindPlayer(playerID)
	if p == nil {
		return false
	}
	return s.DoBankChain(p.Name, now)
}

func (s *State) Rename(playerID, newName string, now int64) (ok bool, failReason string) {
	if s.Phase != PhaseLobby {
		return false, ""
	}
	n := cleanName(newName)
	if n == "" {
		return false, ""
	}
	for _, pl := range s.Players {
		if pl.ID != playerID && strings.EqualFold(pl.Name, n) {
			return false, "That name is taken."
		}
	}
	p := s.FindPlayer(playerID)
	if p == nil {
		return false, ""
	}
	old := p.Name
	p.Name = n
	s.PushLog(now, old+" renamed themselves to "+n)
	return true, ""
}
