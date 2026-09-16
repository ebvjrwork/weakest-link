package httpapi

import (
	"net/http"
	"strconv"

	"weakestlink/internal/questionbank"
)

func (s *Server) handleAdminListQuestions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, offset := pageParams(q)
	rows, total, err := s.Questions.List(q.Get("search"), limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list questions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": total, "limit": limit, "offset": offset})
}

type questionRequest struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

func (s *Server) handleAdminCreateQuestion(w http.ResponseWriter, r *http.Request) {
	var req questionRequest
	if err := readJSON(r, &req); err != nil || req.Question == "" || req.Answer == "" {
		writeError(w, http.StatusBadRequest, "question and answer are required")
		return
	}
	id, err := s.Questions.Create(req.Question, req.Answer)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create question")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func (s *Server) handleAdminUpdateQuestion(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req questionRequest
	if err := readJSON(r, &req); err != nil || req.Question == "" || req.Answer == "" {
		writeError(w, http.StatusBadRequest, "question and answer are required")
		return
	}
	if err := s.Questions.Update(id, req.Question, req.Answer); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update question")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAdminDeleteQuestion(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.Questions.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete question")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type bulkImportRequest struct {
	Text string `json:"text"` // pasted "Q | A" lines or a JSON array
}

// handleAdminBulkImport is the admin-trusted import path: it goes straight
// into the approved bank, bypassing the moderation queue entirely.
func (s *Server) handleAdminBulkImport(w http.ResponseWriter, r *http.Request) {
	var req bulkImportRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	qs := questionbank.ParseText(req.Text)
	if len(qs) == 0 {
		writeError(w, http.StatusBadRequest, "could not parse any questions from that text")
		return
	}
	n, err := s.Questions.BulkInsert(qs, "admin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not import questions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"imported": n})
}

func pageParams(q map[string][]string) (limit, offset int) {
	limit, offset = 25, 0
	if v, err := strconv.Atoi(get(q, "limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	if v, err := strconv.Atoi(get(q, "offset")); err == nil && v >= 0 {
		offset = v
	}
	return limit, offset
}

func get(q map[string][]string, key string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}
