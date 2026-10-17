// Package playbacklimiter admits one torrent per IP, either one exclusive 4K
// session or up to two HD sessions. Existing clients are never evicted by peers.
package playbacklimiter

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var ErrCapacity = errors.New("playback capacity reached: one exclusive 4K or two HD clients")
var fourK = regexp.MustCompile(`(?i)(^|[^a-z0-9])(2160[pi]?|4k|uhd)([^a-z0-9]|$)`)
var hd = regexp.MustCompile(`(?i)(^|[^a-z0-9])(1080[pi]?|720p|576p|540p|480p)([^a-z0-9]|$)`)

// Unknown resolution is conservatively exclusive, never silently counted as HD.
func Classify(name string) string {
	if fourK.MatchString(name) {
		return "4k"
	}
	if hd.MatchString(name) {
		return "1080p"
	}
	return "4k"
}

type session struct {
	ip, hash, quality string
	connections       int
	until             time.Time
	ctx               context.Context
	cancel            context.CancelFunc
}

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*session
	removed  map[string]bool
	grace    time.Duration
	now      func() time.Time
}

type Lease struct {
	manager *Manager
	session *session
	once    sync.Once
}

type Status struct {
	IP           string     `json:"ip"`
	InfoHash     string     `json:"infoHash"`
	Quality      string     `json:"quality"`
	Connections  int        `json:"connections"`
	ReleaseAfter *time.Time `json:"releaseAfter,omitempty"`
}

func New(grace time.Duration) *Manager {
	return &Manager{sessions: make(map[string]*session), removed: make(map[string]bool), grace: grace, now: time.Now}
}

func (m *Manager) prune() {
	for ip, s := range m.sessions {
		if s.connections == 0 && !m.now().Before(s.until) {
			s.cancel()
			delete(m.sessions, ip)
		}
	}
}

func (m *Manager) Acquire(ip, hash, quality string) (*Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prune()
	hash = strings.ToLower(hash)
	if m.removed[hash] {
		return nil, errors.New("torrent was removed; reload source list")
	}
	if ip == "" || hash == "" || (quality != "4k" && quality != "1080p") {
		return nil, errors.New("invalid playback identity")
	}
	old := m.sessions[ip]
	if old != nil && old.hash == hash && old.quality == quality {
		old.connections++
		return &Lease{manager: m, session: old}, nil
	}
	others := 0
	for otherIP, s := range m.sessions {
		if otherIP == ip {
			continue
		}
		others++
		if s.quality == "4k" || quality == "4k" {
			return nil, ErrCapacity
		}
	}
	if others >= 2 {
		return nil, ErrCapacity
	}
	// Capacity is checked BEFORE cancelling this IP's old movie.
	if old != nil {
		old.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{ip: ip, hash: hash, quality: quality, connections: 1, ctx: ctx, cancel: cancel}
	m.sessions[ip] = s
	return &Lease{manager: m, session: s}, nil
}

func (l *Lease) Context() context.Context { return l.session.ctx }

func (m *Manager) Register(hash string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.removed, strings.ToLower(hash))
}

// Serialize deletion against admission, including grace reservations. Tombstones
// prevent a stale HTTP handler from acquiring a just-deleted Torrent pointer.
func (m *Manager) DeleteIdle(hash string, remove func() error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prune()
	hash = strings.ToLower(hash)
	for _, s := range m.sessions {
		if s.hash == hash {
			return errors.New("torrent is active or awaiting reconnection")
		}
	}
	m.removed[hash] = true
	if err := remove(); err != nil {
		return err
	}
	return nil
}
func (l *Lease) Release() {
	l.once.Do(func() {
		m := l.manager
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.sessions[l.session.ip] != l.session {
			return
		}
		l.session.connections--
		if l.session.connections == 0 {
			l.session.until = m.now().Add(m.grace)
		}
	})
}

func (m *Manager) Snapshot() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prune()
	result := make([]Status, 0, len(m.sessions))
	for _, s := range m.sessions {
		item := Status{IP: s.ip, InfoHash: s.hash, Quality: s.quality, Connections: s.connections}
		if s.connections == 0 {
			until := s.until
			item.ReleaseAfter = &until
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].IP < result[j].IP })
	return result
}
