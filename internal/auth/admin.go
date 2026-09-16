// Package auth handles the single admin account: bcrypt password checks and
// an HMAC-signed session cookie. There's deliberately no JWT library and no
// users/roles table — this app has exactly one administrator.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrNoAdmin    = errors.New("admin account not initialized")
	ErrBadPassword = errors.New("incorrect password")
)

const (
	cookieName = "wlink_admin_session"
	sessionTTL = 12 * time.Hour
)

type Admin struct {
	db         *sql.DB
	signingKey []byte
}

func NewAdmin(db *sql.DB, signingKey []byte) *Admin {
	return &Admin{db: db, signingKey: signingKey}
}

// Bootstrap creates the singleton admin row from bootstrapPassword the first
// time the server ever starts; every subsequent boot is a no-op, so it's
// safe to leave ADMIN_BOOTSTRAP_PASSWORD set in the environment afterward
// (though rotating off it via SetPassword is recommended).
func (a *Admin) Bootstrap(bootstrapPassword string) error {
	var count int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM admin`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	if strings.TrimSpace(bootstrapPassword) == "" {
		return errors.New("ADMIN_BOOTSTRAP_PASSWORD must be set on first boot to create the admin account")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(bootstrapPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(`INSERT INTO admin (id, password_hash) VALUES (1, ?)`, string(hash))
	return err
}

func (a *Admin) Login(password string) error {
	var hash string
	err := a.db.QueryRow(`SELECT password_hash FROM admin WHERE id = 1`).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNoAdmin
	}
	if err != nil {
		return err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return ErrBadPassword
	}
	return nil
}

// SetPassword lets the admin rotate off the bootstrap password after first login.
func (a *Admin) SetPassword(newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(`UPDATE admin SET password_hash = ?, updated_at = datetime('now') WHERE id = 1`, string(hash))
	return err
}

// --- session cookie ---------------------------------------------------------------------
// value = base64url(expiryUnixSeconds) + "." + base64url(HMAC-SHA256(expiry, signingKey))
// Stateless by design: no server-side session store to clean up, and the
// signing key alone can invalidate every outstanding session (e.g. on rotation).

func (a *Admin) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, a.signingKey)
	mac.Write(payload)
	return mac.Sum(nil)
}

func (a *Admin) IssueSession(w http.ResponseWriter, secure bool) {
	exp := time.Now().Add(sessionTTL).Unix()
	payload := make([]byte, 8)
	binary.BigEndian.PutUint64(payload, uint64(exp))
	sig := a.sign(payload)
	value := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: value, Path: "/", HttpOnly: true, Secure: secure,
		SameSite: http.SameSiteLaxMode, Expires: time.Unix(exp, 0),
	})
}

func (a *Admin) ClearSession(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", HttpOnly: true, Secure: secure,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
}

func (a *Admin) ValidSession(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(payload) != 8 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	if !hmac.Equal(sig, a.sign(payload)) {
		return false
	}
	exp := int64(binary.BigEndian.Uint64(payload))
	return time.Now().Unix() < exp
}

// RequireAdmin is HTTP middleware protecting every /api/admin/* route except login.
func (a *Admin) RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.ValidSession(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}
