// Command server runs the Chain Reaction game server: it serves the static
// frontend, the REST API (room bootstrap, admin, submissions), and the
// WebSocket endpoint that drives live gameplay, all from one Go binary.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"weakestlink/internal/auth"
	"weakestlink/internal/db"
	"weakestlink/internal/httpapi"
	"weakestlink/internal/questionbank"
	"weakestlink/internal/room"
)

func main() {
	backupPath := flag.String("backup", "", "write a consistent SQLite backup to this path and exit (see README for the cron recipe)")
	flag.Parse()

	dbPath := envOr("DB_PATH", "./data/weakestlink.db")
	if dir := filepath.Dir(dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("could not create data directory %s: %v", dir, err)
		}
	}

	sqlDB, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("could not open database: %v", err)
	}
	defer sqlDB.Close()

	if *backupPath != "" {
		safePath := strings.ReplaceAll(*backupPath, "'", "''")
		if _, err := sqlDB.Exec(fmt.Sprintf("VACUUM INTO '%s'", safePath)); err != nil {
			log.Fatalf("backup failed: %v", err)
		}
		log.Printf("backup written to %s", *backupPath)
		return
	}

	questions := questionbank.NewStore(sqlDB)
	if err := questions.Seed(); err != nil {
		log.Fatalf("could not seed question bank: %v", err)
	}

	signingKey, err := loadSigningKey(os.Getenv("SESSION_SIGNING_KEY"))
	if err != nil {
		log.Fatalf("invalid SESSION_SIGNING_KEY: %v", err)
	}
	admin := auth.NewAdmin(sqlDB, signingKey)
	if err := admin.Bootstrap(os.Getenv("ADMIN_BOOTSTRAP_PASSWORD")); err != nil {
		log.Printf("admin account not initialized yet: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rooms := room.NewManager(ctx)
	secure := envOr("SECURE_COOKIES", "true") == "true"
	srv := httpapi.NewServer(rooms, questions, admin, secure)
	handler := httpapi.NewRouter(srv, envOr("STATIC_DIR", "./web"))

	addr := ":" + envOr("PORT", "8080")
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("weakestlink listening on %s", addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// loadSigningKey expects a base64-encoded key (matching the `openssl rand
// -base64 32` instruction in .env.example). Falling back to an ephemeral
// per-run key lets `go run` work with zero setup for local development;
// production deployments should always set SESSION_SIGNING_KEY explicitly so
// admin sessions survive a restart.
func loadSigningKey(encoded string) ([]byte, error) {
	if encoded == "" {
		log.Println("WARNING: SESSION_SIGNING_KEY not set — using an ephemeral key for this run only (admin sessions won't survive a restart)")
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		return b, nil
	}
	b, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(b) < 16 {
		return nil, fmt.Errorf("must be a base64-encoded string of at least 16 bytes (try: openssl rand -base64 32)")
	}
	return b, nil
}
