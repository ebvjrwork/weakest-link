package httpapi

import (
	"net"
	"net/http"
	"sync"

	"golang.org/x/time/rate"
)

// ipLimiter is a small per-IP token-bucket limiter for the public,
// unauthenticated submission endpoints — enough to blunt naive spam/flooding
// without an external rate-limiting service. It never evicts old IPs, which
// is an acceptable simplification at hobby-project scale (the map stays
// small relative to server lifetime and is cleared on every restart).
type ipLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	r        rate.Limit
	burst    int
}

func newIPLimiter(r rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{limiters: map[string]*rate.Limiter{}, r: r, burst: burst}
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	lim, ok := l.limiters[ip]
	if !ok {
		lim = rate.NewLimiter(l.r, l.burst)
		l.limiters[ip] = lim
	}
	l.mu.Unlock()
	return lim.Allow()
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
