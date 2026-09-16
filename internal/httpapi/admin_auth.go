package httpapi

import (
	"errors"
	"net/http"

	"weakestlink/internal/auth"
)

type adminLoginRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	var req adminLoginRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	err := s.Admin.Login(req.Password)
	switch {
	case err == nil:
		s.Admin.IssueSession(w, s.Secure)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errors.Is(err, auth.ErrBadPassword), errors.Is(err, auth.ErrNoAdmin):
		writeError(w, http.StatusUnauthorized, "incorrect password")
	default:
		writeError(w, http.StatusInternalServerError, "login failed")
	}
}

func (s *Server) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	s.Admin.ClearSession(w, s.Secure)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAdminMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type setPasswordRequest struct {
	NewPassword string `json:"newPassword"`
}

func (s *Server) handleAdminSetPassword(w http.ResponseWriter, r *http.Request) {
	var req setPasswordRequest
	if err := readJSON(r, &req); err != nil || len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "newPassword must be at least 8 characters")
		return
	}
	if err := s.Admin.SetPassword(req.NewPassword); err != nil {
		writeError(w, http.StatusInternalServerError, "could not set the new password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
