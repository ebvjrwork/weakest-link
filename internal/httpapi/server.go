package httpapi

import (
	"net/http"
	"time"

	"golang.org/x/time/rate"

	"weakestlink/internal/auth"
	"weakestlink/internal/questionbank"
	"weakestlink/internal/room"
)

type Server struct {
	Rooms     *room.Manager
	Questions *questionbank.Store
	Admin     *auth.Admin
	Secure    bool // controls the cookie Secure flag; true when served over HTTPS

	submissionLimiter *ipLimiter
}

func NewServer(rooms *room.Manager, questions *questionbank.Store, admin *auth.Admin, secure bool) *Server {
	return &Server{
		Rooms: rooms, Questions: questions, Admin: admin, Secure: secure,
		// ~5 submissions/minute per IP with a burst of 5 — generous for a real
		// contributor pasting a batch, stingy enough to blunt naive flooding.
		submissionLimiter: newIPLimiter(rate.Every(time.Minute/5), 5),
	}
}

// NewRouter wires every route. staticDir is served for everything not
// matched above it — the buildless frontend (index.html/admin.html/submit.html + js/css).
func NewRouter(s *Server, staticDir string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /api/rooms/{code}", s.handleRoomSummary)
	mux.HandleFunc("POST /api/rooms/{code}/players", s.handleJoinRoom)
	mux.HandleFunc("GET /ws", s.handleWS)

	mux.HandleFunc("POST /api/admin/login", s.handleAdminLogin)
	mux.HandleFunc("POST /api/admin/logout", s.handleAdminLogout)
	mux.HandleFunc("GET /api/admin/me", s.Admin.RequireAdmin(s.handleAdminMe))
	mux.HandleFunc("POST /api/admin/password", s.Admin.RequireAdmin(s.handleAdminSetPassword))

	mux.HandleFunc("GET /api/admin/questions", s.Admin.RequireAdmin(s.handleAdminListQuestions))
	mux.HandleFunc("POST /api/admin/questions", s.Admin.RequireAdmin(s.handleAdminCreateQuestion))
	mux.HandleFunc("PUT /api/admin/questions/{id}", s.Admin.RequireAdmin(s.handleAdminUpdateQuestion))
	mux.HandleFunc("DELETE /api/admin/questions/{id}", s.Admin.RequireAdmin(s.handleAdminDeleteQuestion))
	mux.HandleFunc("POST /api/admin/questions/bulk", s.Admin.RequireAdmin(s.handleAdminBulkImport))

	mux.HandleFunc("GET /api/admin/submissions", s.Admin.RequireAdmin(s.handleAdminListSubmissions))
	mux.HandleFunc("POST /api/admin/submissions/{id}/approve", s.Admin.RequireAdmin(s.handleAdminApprove))
	mux.HandleFunc("POST /api/admin/submissions/{id}/reject", s.Admin.RequireAdmin(s.handleAdminReject))

	mux.HandleFunc("POST /api/submissions", s.handleSubmit)
	mux.HandleFunc("POST /api/submissions/bulk", s.handleSubmitBulk)

	mux.Handle("GET /", http.FileServer(http.Dir(staticDir)))

	return withLogging(mux)
}
