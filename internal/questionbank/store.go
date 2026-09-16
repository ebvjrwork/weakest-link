package questionbank

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"

	"weakestlink/internal/room"
)

// NewBatchID returns a short random token grouping the rows from one bulk
// paste/CSV/JSON submission, so the admin moderation queue can show and
// approve/reject them together.
func NewBatchID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var ErrAlreadyReviewed = errors.New("submission already reviewed")

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Seed inserts the built-in question set if the table is empty, so a fresh
// deployment never starts with a blank community bank. Safe to call on every boot.
func (s *Store) Seed() error {
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM questions`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err := s.BulkInsert(SeedQuestions, "seed")
	return err
}

// CommunityBank returns the full current global bank — used as the default
// question source when a new room is created.
func (s *Store) CommunityBank() ([]room.Question, error) {
	rows, err := s.db.Query(`SELECT question, answer FROM questions ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []room.Question
	for rows.Next() {
		var q room.Question
		if err := rows.Scan(&q.Q, &q.A); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

type QuestionRow struct {
	ID        int64  `json:"id"`
	Question  string `json:"question"`
	Answer    string `json:"answer"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// List returns one page of the admin question table, optionally filtered by
// a full-text search over question+answer text.
func (s *Store) List(search string, limit, offset int) (rowsOut []QuestionRow, total int, err error) {
	search = strings.TrimSpace(search)
	var rows *sql.Rows
	if search == "" {
		if err = s.db.QueryRow(`SELECT COUNT(*) FROM questions`).Scan(&total); err != nil {
			return nil, 0, err
		}
		rows, err = s.db.Query(`SELECT id, question, answer, source, created_at, updated_at FROM questions ORDER BY id DESC LIMIT ? OFFSET ?`, limit, offset)
	} else {
		q := ftsQuery(search)
		if err = s.db.QueryRow(`SELECT COUNT(*) FROM questions_fts WHERE questions_fts MATCH ?`, q).Scan(&total); err != nil {
			return nil, 0, err
		}
		rows, err = s.db.Query(`
			SELECT qs.id, qs.question, qs.answer, qs.source, qs.created_at, qs.updated_at
			FROM questions_fts f JOIN questions qs ON qs.id = f.rowid
			WHERE questions_fts MATCH ?
			ORDER BY rank LIMIT ? OFFSET ?`, q, limit, offset)
	}
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var q QuestionRow
		if err := rows.Scan(&q.ID, &q.Question, &q.Answer, &q.Source, &q.CreatedAt, &q.UpdatedAt); err != nil {
			return nil, 0, err
		}
		rowsOut = append(rowsOut, q)
	}
	return rowsOut, total, rows.Err()
}

// ftsQuery wraps each token in quotes so punctuation in trivia text (very
// common) can't be misparsed as FTS5 query syntax, with a trailing prefix
// wildcard so partial words still match while typing a search.
func ftsQuery(search string) string {
	fields := strings.Fields(search)
	for i, f := range fields {
		fields[i] = `"` + strings.ReplaceAll(f, `"`, `""`) + `"*`
	}
	return strings.Join(fields, " ")
}

func (s *Store) Create(q, a string) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO questions (question, answer, source) VALUES (?, ?, 'admin')`, q, a)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) Update(id int64, q, a string) error {
	_, err := s.db.Exec(`UPDATE questions SET question = ?, answer = ?, updated_at = datetime('now') WHERE id = ?`, q, a, id)
	return err
}

func (s *Store) Delete(id int64) error {
	_, err := s.db.Exec(`DELETE FROM questions WHERE id = ?`, id)
	return err
}

// BulkInsert is used by the seed step and by admin's trusted bulk import
// (which bypasses the moderation queue entirely).
func (s *Store) BulkInsert(qs []room.Question, source string) (int, error) {
	if len(qs) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	stmt, err := tx.Prepare(`INSERT INTO questions (question, answer, source) VALUES (?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	n := 0
	for _, q := range qs {
		if _, err := stmt.Exec(q.Q, q.A, source); err != nil {
			stmt.Close()
			tx.Rollback()
			return 0, err
		}
		n++
	}
	stmt.Close()
	return n, tx.Commit()
}

// --- moderation queue -----------------------------------------------------------------

type SubmissionRow struct {
	ID            int64  `json:"id"`
	Question      string `json:"question"`
	Answer        string `json:"answer"`
	SubmitterName string `json:"submitterName,omitempty"`
	Note          string `json:"note,omitempty"`
	Status        string `json:"status"`
	RejectReason  string `json:"rejectReason,omitempty"`
	BatchID       string `json:"batchId,omitempty"`
	CreatedAt     string `json:"createdAt"`
}

func (s *Store) CreateSubmission(q, a, submitterName, note, batchID string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO submissions (question, answer, submitter_name, note, batch_id) VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''))`,
		q, a, submitterName, note, batchID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListSubmissions(status string, limit, offset int) (out []SubmissionRow, total int, err error) {
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM submissions WHERE status = ?`, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(`
		SELECT id, question, answer, COALESCE(submitter_name,''), COALESCE(note,''), status, COALESCE(reject_reason,''), COALESCE(batch_id,''), created_at
		FROM submissions WHERE status = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var r SubmissionRow
		if err := rows.Scan(&r.ID, &r.Question, &r.Answer, &r.SubmitterName, &r.Note, &r.Status, &r.RejectReason, &r.BatchID, &r.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// ApproveSubmission moves a pending submission into the approved bank,
// optionally overriding its text (the "edit-then-approve" admin action).
func (s *Store) ApproveSubmission(id int64, overrideQ, overrideA string) error {
	var q, a, status string
	if err := s.db.QueryRow(`SELECT question, answer, status FROM submissions WHERE id = ?`, id).Scan(&q, &a, &status); err != nil {
		return err
	}
	if status != "pending" {
		return ErrAlreadyReviewed
	}
	if strings.TrimSpace(overrideQ) != "" {
		q = overrideQ
	}
	if strings.TrimSpace(overrideA) != "" {
		a = overrideA
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	res, err := tx.Exec(`INSERT INTO questions (question, answer, source) VALUES (?, ?, 'submission')`, q, a)
	if err != nil {
		tx.Rollback()
		return err
	}
	qid, _ := res.LastInsertId()
	if _, err := tx.Exec(`UPDATE submissions SET status = 'approved', approved_question_id = ?, reviewed_at = datetime('now') WHERE id = ?`, qid, id); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) RejectSubmission(id int64, reason string) error {
	res, err := s.db.Exec(`UPDATE submissions SET status = 'rejected', reject_reason = NULLIF(?, ''), reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`, reason, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrAlreadyReviewed
	}
	return nil
}
