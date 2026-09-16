package room

import "testing"

func testBank() []Question {
	return []Question{{Q: "2+2?", A: "4"}, {Q: "Capital of France?", A: "Paris"}, {Q: "Color of sky?", A: "Blue"}}
}

func newTestState(names ...string) *State {
	s := NewState("TEST", 60, testBank(), testBank(), false)
	for _, n := range names {
		s.Players = append(s.Players, &Player{ID: NewID(), Name: n, Alive: true})
	}
	return s
}

func (s *State) playerByName(name string) *Player {
	for _, p := range s.Players {
		if p.Name == name {
			return p
		}
	}
	return nil
}

// --- join / reconnect --------------------------------------------------------------------

func TestJoinDedupesNames(t *testing.T) {
	s := NewState("TEST", 60, testBank(), testBank(), false)
	p1, _, denied, _ := s.Join("Alex", "", "", 1000)
	if denied || p1.Name != "Alex" {
		t.Fatalf("expected first join to succeed as Alex, got %+v denied=%v", p1, denied)
	}
	p2, _, denied, _ := s.Join("Alex", "", "", 1001)
	if denied {
		t.Fatalf("second join should not be denied")
	}
	if p2.Name != "Alex 2" {
		t.Fatalf("expected deduped name 'Alex 2', got %q", p2.Name)
	}
}

func TestJoinDeniedMidGame(t *testing.T) {
	s := newTestState("A", "B", "C")
	s.Phase = PhasePlaying
	_, _, denied, reason := s.Join("NewPerson", "", "", 1000)
	if !denied || reason == "" {
		t.Fatalf("expected join to be denied mid-game")
	}
}

func TestJoinReconnectsByNameWhenOffline(t *testing.T) {
	s := newTestState("Alex")
	original := s.Players[0]
	original.Connected = false
	original.Correct = 3

	p, reconnected, denied, _ := s.Join("alex", "", "", 1000) // case-insensitive
	if denied {
		t.Fatalf("should not be denied")
	}
	if !reconnected {
		t.Fatalf("expected reconnected=true")
	}
	if p.ID != original.ID || p.Correct != 3 {
		t.Fatalf("expected to reclaim the original player record with stats intact, got %+v", p)
	}
	if len(s.Players) != 1 {
		t.Fatalf("expected no duplicate player row, got %d players", len(s.Players))
	}
}

func TestJoinReconnectsByTokenTakesPriorityOverNameMatch(t *testing.T) {
	s := newTestState("Alex", "Sam")
	alex := s.playerByName("Alex")
	alex.Connected = false
	alex.Token = "secret-token"

	p, reconnected, denied, _ := s.Join("Whatever", alex.ID, "secret-token", 1000)
	if denied || !reconnected || p.ID != alex.ID {
		t.Fatalf("expected token-based reconnect to reclaim Alex's record, got %+v denied=%v reconnected=%v", p, denied, reconnected)
	}
}

func TestAttachPlayerRejectsWrongToken(t *testing.T) {
	s := newTestState("Alex")
	alex := s.Players[0]
	alex.Token = "correct"
	if _, _, ok := s.AttachPlayer(alex.ID, "wrong", 1000); ok {
		t.Fatalf("expected attach with wrong token to fail")
	}
	if _, _, ok := s.AttachPlayer(alex.ID, "correct", 1000); !ok {
		t.Fatalf("expected attach with correct token to succeed")
	}
}

func TestRenameConflict(t *testing.T) {
	s := newTestState("Alex", "Sam")
	sam := s.playerByName("Sam")
	ok, reason := s.Rename(sam.ID, "Alex", 1000)
	if ok || reason == "" {
		t.Fatalf("expected rename to a taken name to fail with a reason")
	}
	ok, _ = s.Rename(sam.ID, "Sammy", 1000)
	if !ok || s.playerByName("Sammy") == nil {
		t.Fatalf("expected rename to an available name to succeed")
	}
}

// --- chain / banking -----------------------------------------------------------------------

func TestMarkCorrectClimbsChainAndAdvancesTurn(t *testing.T) {
	s := newTestState("A", "B", "C")
	s.DoStartGame(1000)
	s.FinishCountdown(6000) // enter playing
	first := s.CurrentAskedID

	s.DoMarkCorrect(7000)
	if s.ChainIndex != 0 {
		t.Fatalf("expected chain index 0 after first correct answer, got %d", s.ChainIndex)
	}
	if s.CurrentAskedID == first {
		t.Fatalf("expected turn to advance to the next alive player")
	}
	if s.playerByName("A") == nil {
		t.Fatalf("sanity: player A should still exist")
	}

	s.DoMarkIncorrect(8000)
	if s.ChainIndex != -1 {
		t.Fatalf("expected chain to reset to -1 after an incorrect answer, got %d", s.ChainIndex)
	}
}

func TestBankChainMovesMoneyAndResetsChain(t *testing.T) {
	s := newTestState("A", "B", "C")
	s.DoStartGame(1000)
	s.FinishCountdown(6000)
	s.DoMarkCorrect(7000) // chain index 0 -> $20
	if !s.DoBankChain("", 8000) {
		t.Fatalf("expected bank to succeed with a live chain")
	}
	if s.Bank != ChainValues[0] {
		t.Fatalf("expected bank to equal %d, got %d", ChainValues[0], s.Bank)
	}
	if s.ChainIndex != -1 {
		t.Fatalf("expected chain reset after banking")
	}
	if s.DoBankChain("", 9000) {
		t.Fatalf("expected banking again with no live chain to fail")
	}
}

// --- voting / elimination -------------------------------------------------------------------

func TestVoteSingleWinnerEliminated(t *testing.T) {
	s := newTestState("A", "B", "C")
	s.Phase = PhaseVoting
	a, b, c := s.playerByName("A"), s.playerByName("B"), s.playerByName("C")
	s.Votes = map[string]string{a.ID: c.ID, b.ID: c.ID, c.ID: a.ID}
	s.resolveVotes(1000)
	if s.Phase != PhaseElimination {
		t.Fatalf("expected phase elimination, got %s", s.Phase)
	}
	if c.Alive {
		t.Fatalf("expected C to be eliminated")
	}
	if s.LastElimination == nil || s.LastElimination.Name != "C" {
		t.Fatalf("expected LastElimination.Name == C, got %+v", s.LastElimination)
	}
}

func TestVoteTieBrokenByPerformance(t *testing.T) {
	s := newTestState("A", "B", "C", "D")
	s.Phase = PhaseVoting
	a, b, c, d := s.playerByName("A"), s.playerByName("B"), s.playerByName("C"), s.playerByName("D")
	// B and C are tied at 1 vote each; C has a worse (correct-incorrect) score, so C goes.
	b.Correct, b.Incorrect = 5, 1 // score 4
	c.Correct, c.Incorrect = 1, 3 // score -2
	s.Votes = map[string]string{a.ID: b.ID, d.ID: c.ID}
	s.resolveVotes(1000)
	if s.Phase != PhaseElimination {
		t.Fatalf("expected an elimination to resolve automatically via performance tie-break")
	}
	if c.Alive || !b.Alive {
		t.Fatalf("expected C (worse score) eliminated over B, got C.Alive=%v B.Alive=%v", c.Alive, b.Alive)
	}
}

func TestVoteTieRequiresManualBreakWhenScoresEqual(t *testing.T) {
	s := newTestState("A", "B", "C", "D")
	s.Phase = PhaseVoting
	a, b, c, d := s.playerByName("A"), s.playerByName("B"), s.playerByName("C"), s.playerByName("D")
	// B and C tied at 1 vote, identical scores -> needs a human tie-break.
	s.Votes = map[string]string{a.ID: b.ID, d.ID: c.ID}
	s.resolveVotes(1000)
	if s.Phase != PhaseVoting {
		t.Fatalf("expected phase to remain voting pending a manual tie-break, got %s", s.Phase)
	}
	if len(s.TieCandidates) != 2 {
		t.Fatalf("expected 2 tie candidates, got %d", len(s.TieCandidates))
	}
	if !s.DoManualTieBreak(c.ID, 2000) {
		t.Fatalf("expected manual tie-break to succeed")
	}
	if c.Alive || s.Phase != PhaseElimination {
		t.Fatalf("expected manual tie-break to eliminate C")
	}
}

// --- shootout ---------------------------------------------------------------------------------

func newShootoutState(t *testing.T) (*State, *Player, *Player) {
	t.Helper()
	s := newTestState("A", "B")
	a, b := s.playerByName("A"), s.playerByName("B")
	for _, p := range s.Players {
		p.Alive = true
	}
	if !s.DoContinueAfterElimination(1000) {
		t.Fatalf("expected continue-after-elimination to succeed with 2 players")
	}
	if s.Shootout == nil {
		t.Fatalf("expected a shootout to be created")
	}
	s.FinishCountdown(6000)
	if s.Phase != PhaseShootout {
		t.Fatalf("expected phase shootout, got %s", s.Phase)
	}
	return s, a, b
}

func TestShootoutRegulationWinnerByScore(t *testing.T) {
	s, a, b := newShootoutState(t)
	// A gets every round right, B gets every round wrong -> A wins once mathematically settled.
	for i := 0; i < shootoutRegulationRounds; i++ {
		if s.Shootout.WinnerID != "" {
			break
		}
		s.DoShootoutMark("correct", int64(7000+i*10))  // A's turn
		if s.Shootout.WinnerID == "" {
			s.DoShootoutMark("incorrect", int64(7005+i*10)) // B's turn
		}
	}
	if s.Shootout.WinnerID != a.ID {
		t.Fatalf("expected A to win the shootout, winnerId=%q (a=%q b=%q)", s.Shootout.WinnerID, a.ID, b.ID)
	}
	if s.Phase != PhaseGameOver || s.Winner != "A" {
		t.Fatalf("expected game over with winner A, got phase=%s winner=%s", s.Phase, s.Winner)
	}
}

func TestShootoutTiedAfterRegulationGoesSuddenDeath(t *testing.T) {
	s, _, _ := newShootoutState(t)
	// Both players answer identically every round -> tied after 5 rounds -> sudden death.
	for i := 0; i < shootoutRegulationRounds; i++ {
		s.DoShootoutMark("correct", int64(7000+i*10))
		s.DoShootoutMark("correct", int64(7005+i*10))
	}
	if !s.Shootout.Sudden {
		t.Fatalf("expected sudden death after a tied regulation, got Sudden=%v winnerId=%q", s.Shootout.Sudden, s.Shootout.WinnerID)
	}
	if s.Shootout.WinnerID != "" {
		t.Fatalf("expected no winner yet at the start of sudden death")
	}
	// First round where exactly one of them answers correctly decides it immediately.
	s.DoShootoutMark("correct", 9000)
	s.DoShootoutMark("incorrect", 9010)
	if s.Shootout.WinnerID == "" || s.Phase != PhaseGameOver {
		t.Fatalf("expected sudden death to produce an immediate winner, got winnerId=%q phase=%s", s.Shootout.WinnerID, s.Phase)
	}
}

func TestShootoutEarlyDecisionBeforeRegulationEnds(t *testing.T) {
	s, a, _ := newShootoutState(t)
	// A wins rounds 1-3 outright (3-0); B can win at most rounds 4-5 (2 more),
	// so after round 3 the outcome is already mathematically settled.
	for i := 0; i < 3; i++ {
		s.DoShootoutMark("correct", int64(7000+i*10))
		if s.Shootout.WinnerID != "" {
			break
		}
		s.DoShootoutMark("incorrect", int64(7005+i*10))
	}
	if s.Shootout.WinnerID != a.ID {
		t.Fatalf("expected an early decision in A's favor after round 3, got winnerId=%q", s.Shootout.WinnerID)
	}
	if s.Shootout.CurrentRoundIndex >= shootoutRegulationRounds-1 {
		t.Fatalf("expected the win to be declared before all 5 regulation rounds were played")
	}
}

// --- play again ---------------------------------------------------------------------------------

func TestPlayAgainRevivesRosterKeepsBankZeroed(t *testing.T) {
	s := newTestState("A", "B", "C")
	a := s.playerByName("A")
	a.Alive = false
	a.Correct = 5
	s.Bank = 500
	s.Round = 3

	s.DoPlayAgain()

	if s.Phase != PhaseLobby || s.Bank != 0 || s.Round != 1 {
		t.Fatalf("expected a fresh lobby state, got phase=%s bank=%d round=%d", s.Phase, s.Bank, s.Round)
	}
	if len(s.Players) != 3 {
		t.Fatalf("expected roster to be kept, got %d players", len(s.Players))
	}
	revived := s.playerByName("A")
	if revived == nil || !revived.Alive || revived.Correct != 0 {
		t.Fatalf("expected A revived with stats reset, got %+v", revived)
	}
}

// --- question bank --------------------------------------------------------------------------

func TestPullQuestionNeverPanicsOnEmptyBank(t *testing.T) {
	s := NewState("TEST", 60, nil, nil, false)
	q := s.PullQuestion() // must not panic/index-out-of-range
	if q.Q == "" {
		t.Fatalf("expected a defensive placeholder question, got empty")
	}
}

func TestSetAndResetQuestionBank(t *testing.T) {
	s := NewState("TEST", 60, testBank(), testBank(), false)
	custom := []Question{{Q: "Custom?", A: "Yes"}}
	if !s.DoSetQuestionBank(custom, 1000) {
		t.Fatalf("expected setting a non-empty custom bank to succeed")
	}
	if !s.UsingCustom || len(s.QuestionBank) != 1 {
		t.Fatalf("expected custom bank of 1 question active, got usingCustom=%v len=%d", s.UsingCustom, len(s.QuestionBank))
	}
	if !s.DoResetQuestionBank(2000) {
		t.Fatalf("expected reset to succeed")
	}
	if s.UsingCustom || len(s.QuestionBank) != len(testBank()) {
		t.Fatalf("expected reset to restore the community bank, got usingCustom=%v len=%d", s.UsingCustom, len(s.QuestionBank))
	}
}
