package questionbank

import (
	"path/filepath"
	"testing"

	"weakestlink/internal/db"
	"weakestlink/internal/room"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return NewStore(sqlDB)
}

func TestSeedPopulatesOnlyOnce(t *testing.T) {
	s := newTestStore(t)
	if err := s.Seed(); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	bank, err := s.CommunityBank()
	if err != nil {
		t.Fatalf("CommunityBank: %v", err)
	}
	if len(bank) != len(SeedQuestions) {
		t.Fatalf("expected %d seeded questions, got %d", len(SeedQuestions), len(bank))
	}
	if err := s.Seed(); err != nil {
		t.Fatalf("second Seed call should be a no-op, got err: %v", err)
	}
	bank2, _ := s.CommunityBank()
	if len(bank2) != len(bank) {
		t.Fatalf("seeding twice should not duplicate rows, got %d then %d", len(bank), len(bank2))
	}
}

func TestCreateUpdateDeleteAndSearch(t *testing.T) {
	s := newTestStore(t)
	id, err := s.Create("What is the capital of Portugal?", "Lisbon")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := s.Create("What color is the sky?", "Blue"); err != nil {
		t.Fatalf("Create 2: %v", err)
	}

	rows, total, err := s.List("Portugal", 10, 0)
	if err != nil {
		t.Fatalf("List(search): %v", err)
	}
	if total != 1 || len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("expected exactly 1 FTS match for 'Portugal', got total=%d rows=%+v", total, rows)
	}

	if err := s.Update(id, "What is the capital of Portugal?", "Lisboa"); err != nil {
		t.Fatalf("Update: %v", err)
	}
	rows, _, _ = s.List("Lisboa", 10, 0)
	if len(rows) != 1 || rows[0].Answer != "Lisboa" {
		t.Fatalf("expected updated answer to be searchable, got %+v", rows)
	}

	if err := s.Delete(id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, total, _ = s.List("Portugal", 10, 0)
	if total != 0 {
		t.Fatalf("expected deleted question to disappear from search and FTS index, got total=%d", total)
	}

	_, total, err = s.List("", 10, 0)
	if err != nil {
		t.Fatalf("List(all): %v", err)
	}
	if total != 1 {
		t.Fatalf("expected 1 remaining question overall, got %d", total)
	}
}

func TestSubmissionApproveFlow(t *testing.T) {
	s := newTestStore(t)
	id, err := s.CreateSubmission("2+2?", "4", "Anon", "", "batch-1")
	if err != nil {
		t.Fatalf("CreateSubmission: %v", err)
	}
	pending, total, err := s.ListSubmissions("pending", 10, 0)
	if err != nil || total != 1 || len(pending) != 1 {
		t.Fatalf("expected 1 pending submission, got total=%d err=%v", total, err)
	}

	if err := s.ApproveSubmission(id, "", "Four"); err != nil { // edit-then-approve
		t.Fatalf("ApproveSubmission: %v", err)
	}
	bank, _ := s.CommunityBank()
	found := false
	for _, q := range bank {
		if q.Q == "2+2?" && q.A == "Four" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected approved (edited) submission to appear in the community bank, got %+v", bank)
	}

	if err := s.ApproveSubmission(id, "", ""); err != ErrAlreadyReviewed {
		t.Fatalf("expected re-approving to fail with ErrAlreadyReviewed, got %v", err)
	}

	id2, _ := s.CreateSubmission("Rejected Q?", "A", "", "", "")
	if err := s.RejectSubmission(id2, "duplicate"); err != nil {
		t.Fatalf("RejectSubmission: %v", err)
	}
	if err := s.RejectSubmission(id2, "again"); err != ErrAlreadyReviewed {
		t.Fatalf("expected double-reject to fail with ErrAlreadyReviewed, got %v", err)
	}
}

func TestParseTextAndCSVAndClamp(t *testing.T) {
	if qs := ParseLines("Q1 | A1\nQ2 | A2\nnotapair\n"); len(qs) != 2 {
		t.Fatalf("expected 2 parsed line pairs, got %d (%+v)", len(qs), qs)
	}
	if qs, ok := ParseJSON(`[["Q1","A1"],{"question":"Q2","answer":"A2"}]`); !ok || len(qs) != 2 {
		t.Fatalf("expected JSON parse to find 2 questions, got ok=%v qs=%+v", ok, qs)
	}
	if qs, err := ParseCSV("question,answer\nQ1,A1\nQ2,\"A,2\"\n"); err != nil || len(qs) != 2 || qs[1].A != "A,2" {
		t.Fatalf("expected CSV parse with quoted comma to work, got qs=%+v err=%v", qs, err)
	}
	big := make([]room.Question, 10)
	for i := range big {
		big[i] = room.Question{Q: "this is a very long question text", A: "short"}
	}
	clamped := Clamp(big, 3, 10, 100)
	if len(clamped) != 3 {
		t.Fatalf("expected Clamp to cap rows to 3, got %d", len(clamped))
	}
	if len([]rune(clamped[0].Q)) != 10 {
		t.Fatalf("expected Clamp to truncate question to 10 runes, got %q", clamped[0].Q)
	}
}
