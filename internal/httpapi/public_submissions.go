package httpapi

import (
	"io"
	"net/http"
	"strings"

	"weakestlink/internal/questionbank"
	"weakestlink/internal/room"
)

const (
	maxSubmissionUploadBytes = 512 * 1024
	maxSubmissionRows        = 500
	maxQuestionLen           = 300
	maxAnswerLen             = 150
	maxSubmitterNameLen      = 40
	maxNoteLen               = 300
)

type submitRequest struct {
	Question      string `json:"question"`
	Answer        string `json:"answer"`
	SubmitterName string `json:"submitterName"`
	Note          string `json:"note"`
}

// handleSubmit is the single-question "suggest a question for the community
// bank" flow — no auth, lands in the moderation queue as pending.
func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.submissionLimiter.allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many submissions — please slow down and try again shortly")
		return
	}
	var req submitRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	q := truncate(strings.TrimSpace(req.Question), maxQuestionLen)
	a := truncate(strings.TrimSpace(req.Answer), maxAnswerLen)
	if q == "" || a == "" {
		writeError(w, http.StatusBadRequest, "question and answer are required")
		return
	}
	id, err := s.Questions.CreateSubmission(q, a, truncate(req.SubmitterName, maxSubmitterNameLen), truncate(req.Note, maxNoteLen), "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not submit your question")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

type submitBulkRequest struct {
	Text          string `json:"text"` // pasted "Q | A" lines or a JSON array
	SubmitterName string `json:"submitterName"`
	Note          string `json:"note"`
}

// handleSubmitBulk accepts either a JSON body with pasted text, or a
// multipart CSV file upload — reusing the exact same shared parser as the
// controller's mid-game bank editor and the admin bulk importer.
func (s *Server) handleSubmitBulk(w http.ResponseWriter, r *http.Request) {
	if !s.submissionLimiter.allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many submissions — please slow down and try again shortly")
		return
	}

	var text, submitterName, note string
	isCSVUpload := false
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxSubmissionUploadBytes); err != nil {
			writeError(w, http.StatusBadRequest, "upload too large or malformed")
			return
		}
		submitterName = r.FormValue("submitterName")
		note = r.FormValue("note")
		file, _, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "no file provided")
			return
		}
		defer file.Close()
		data, _ := io.ReadAll(io.LimitReader(file, maxSubmissionUploadBytes))
		text = string(data)
		isCSVUpload = true
	} else {
		var req submitBulkRequest
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		text, submitterName, note = req.Text, req.SubmitterName, req.Note
	}

	var qs []room.Question
	if isCSVUpload {
		parsed, err := questionbank.ParseCSV(text)
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not parse that CSV file")
			return
		}
		qs = parsed
	} else {
		qs = questionbank.ParseText(text)
	}
	if len(qs) == 0 {
		writeError(w, http.StatusBadRequest, "could not parse any questions from that submission")
		return
	}
	qs = questionbank.Clamp(qs, maxSubmissionRows, maxQuestionLen, maxAnswerLen)

	batchID := questionbank.NewBatchID()
	submitterName = truncate(submitterName, maxSubmitterNameLen)
	note = truncate(note, maxNoteLen)
	accepted := 0
	for _, q := range qs {
		if _, err := s.Questions.CreateSubmission(q.Q, q.A, submitterName, note, batchID); err == nil {
			accepted++
		}
	}
	writeJSON(w, http.StatusCreated, map[string]int{"accepted": accepted})
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
