package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"weakestlink/internal/questionbank"
)

func (s *Server) handleAdminListSubmissions(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	limit, offset := pageParams(r.URL.Query())
	rows, total, err := s.Questions.ListSubmissions(status, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list submissions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": total, "limit": limit, "offset": offset})
}

type approveRequest struct {
	Question string `json:"question"` // optional edit-then-approve override
	Answer   string `json:"answer"`
}

func (s *Server) handleAdminApprove(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req approveRequest
	_ = readJSON(r, &req) // body is optional; an empty/missing body just approves as-is

	if err := s.Questions.ApproveSubmission(id, req.Question, req.Answer); err != nil {
		if errors.Is(err, questionbank.ErrAlreadyReviewed) {
			writeError(w, http.StatusConflict, "that submission was already reviewed")
			return
		}
		writeError(w, http.StatusInternalServerError, "could not approve submission")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type rejectRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) handleAdminReject(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req rejectRequest
	_ = readJSON(r, &req)

	if err := s.Questions.RejectSubmission(id, req.Reason); err != nil {
		if errors.Is(err, questionbank.ErrAlreadyReviewed) {
			writeError(w, http.StatusConflict, "that submission was already reviewed")
			return
		}
		writeError(w, http.StatusInternalServerError, "could not reject submission")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
