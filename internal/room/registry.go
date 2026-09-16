package room

import (
	"context"
	"strings"
	"sync"
)

// Manager is the process-wide directory of live rooms. Game logic never runs
// while its lock is held — it's purely an O(1) create/lookup/remove map; all
// real work happens inside each Room's own actor goroutine.
type Manager struct {
	ctx   context.Context
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewManager(ctx context.Context) *Manager {
	return &Manager{ctx: ctx, rooms: map[string]*Room{}}
}

// Create allocates a fresh room with a guaranteed-unique code and starts its
// actor goroutine. communityBank is the server's shared bank snapshot at
// creation time (used as the "reset to default" target); bank is what's
// actually active to start (equal to communityBank unless usingCustom).
func (m *Manager) Create(roundDuration int, communityBank, bank []Question, usingCustom bool) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	var code string
	for {
		code = GenRoomCode()
		if _, exists := m.rooms[code]; !exists {
			break
		}
	}
	st := NewState(code, roundDuration, communityBank, bank, usingCustom)
	rm := NewRoom(code, st)
	m.rooms[code] = rm
	go rm.Run(m.ctx, m.remove)
	return rm
}

// Get looks up a room by its 4-letter code (case-insensitive).
func (m *Manager) Get(code string) (*Room, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rm, ok := m.rooms[strings.ToUpper(code)]
	return rm, ok
}

func (m *Manager) remove(code string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rooms, code)
}

// Count returns the number of currently live rooms (for basic operational visibility).
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rooms)
}
