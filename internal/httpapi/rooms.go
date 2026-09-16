package httpapi

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"weakestlink/internal/questionbank"
	"weakestlink/internal/room"
)

const (
	minRoundDuration     = 20
	maxRoundDuration     = 300
	defaultRoundDuration = 60
	maxRoomUploadBytes   = 1 << 20 // 1MB cap on a one-off custom question upload at room creation
)

type createRoomRequest struct {
	RoundDuration int `json:"roundDuration"`
	Bank          struct {
		Mode      string          `json:"mode"` // "community" | "custom"
		Questions []room.Question `json:"questions"`
	} `json:"bank"`
}

// handleCreateRoom is the guest "create room" flow: no signup, just pick a
// duration and a question source. The server always re-derives the actual
// question set here — a client-side CSV/JSON preview is UX only, never trusted.
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	community, err := s.Questions.CommunityBank()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load the question bank")
		return
	}

	duration := defaultRoundDuration
	var bank []room.Question
	usingCustom := false

	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxRoomUploadBytes); err != nil {
			writeError(w, http.StatusBadRequest, "upload too large or malformed")
			return
		}
		if d, err := strconv.Atoi(r.FormValue("roundDuration")); err == nil {
			duration = d
		}
		if file, _, err := r.FormFile("file"); err == nil {
			defer file.Close()
			data, _ := io.ReadAll(io.LimitReader(file, maxRoomUploadBytes))
			qs, perr := questionbank.ParseCSV(string(data))
			if perr != nil || len(qs) == 0 {
				writeError(w, http.StatusBadRequest, "could not parse any questions from that file")
				return
			}
			bank, usingCustom = qs, true
		}
	} else {
		var req createRoomRequest
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.RoundDuration > 0 {
			duration = req.RoundDuration
		}
		if req.Bank.Mode == "custom" && len(req.Bank.Questions) > 0 {
			bank, usingCustom = req.Bank.Questions, true
		}
	}

	if duration < minRoundDuration || duration > maxRoundDuration {
		duration = defaultRoundDuration
	}
	if !usingCustom {
		bank = community
	}
	if len(bank) == 0 {
		writeError(w, http.StatusBadRequest, "no questions available to start a room")
		return
	}

	rm := s.Rooms.Create(duration, community, bank, usingCustom)
	writeJSON(w, http.StatusCreated, map[string]string{"roomCode": rm.Code})
}

// handleRoomSummary is the join screen's pre-flight check.
func (s *Server) handleRoomSummary(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	rm, ok := s.Rooms.Get(code)
	if !ok {
		writeJSON(w, http.StatusOK, room.Summary{Exists: false})
		return
	}
	writeJSON(w, http.StatusOK, rm.Summary())
}

type joinRoomRequest struct {
	Name        string `json:"name"`
	RejoinID    string `json:"rejoinId"`
	RejoinToken string `json:"rejoinToken"`
}

// handleJoinRoom covers both a fresh join and a rejoin-after-refresh; on
// success the client opens the WS with the returned playerId/playerToken.
func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	rm, ok := s.Rooms.Get(code)
	if !ok {
		writeError(w, http.StatusNotFound, "room not found")
		return
	}
	var req joinRoomRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	res := rm.Join(req.Name, req.RejoinID, req.RejoinToken)
	if res.Denied {
		writeError(w, http.StatusConflict, res.Reason)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"playerId": res.PlayerID, "playerToken": res.Token})
}
