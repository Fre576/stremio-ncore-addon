package playbacklimiter

import (
	"sync"
	"testing"
	"time"
)

func TestDeletionCannotRaceAdmissionOrGrace(t *testing.T) {
	m := New(time.Minute)
	lease, _ := m.Acquire("a", "hash", "1080p")
	called := false
	remove := func() error { called = true; return nil }
	if m.DeleteIdle("hash", remove) == nil || called {
		t.Fatal("deleted active")
	}
	lease.Release()
	if m.DeleteIdle("hash", remove) == nil || called {
		t.Fatal("deleted grace")
	}
	m.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if err := m.DeleteIdle("hash", remove); err != nil || !called {
		t.Fatal(err)
	}
	if _, err := m.Acquire("a", "hash", "1080p"); err == nil {
		t.Fatal("stale handler acquired deleted torrent")
	}
	m.Register("hash")
	if _, err := m.Acquire("a", "hash", "1080p"); err != nil {
		t.Fatal(err)
	}
}

func TestExclusive4KAndTwoHD(t *testing.T) {
	for _, first := range []string{"4k", "1080p"} {
		m := New(time.Minute)
		if _, err := m.Acquire("a", "one", first); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Acquire("b", "two", "4k"); err != ErrCapacity {
			t.Fatal("4K must not coexist", err)
		}
		_, err := m.Acquire("b", "two", "1080p")
		if first == "4k" {
			if err != ErrCapacity {
				t.Fatal("4K must exclude HD", err)
			}
		} else {
			if err != nil {
				t.Fatal(err)
			}
			if _, err := m.Acquire("c", "three", "1080p"); err != ErrCapacity {
				t.Fatal("third HD must wait", err)
			}
		}
	}
}

func TestSameIPReplacementAndRejectedUpgrade(t *testing.T) {
	m := New(time.Minute)
	old, _ := m.Acquire("a", "old", "1080p")
	m.Acquire("b", "other", "1080p")
	if _, err := m.Acquire("a", "new4k", "4k"); err != ErrCapacity {
		t.Fatal(err)
	}
	if old.Context().Err() != nil {
		t.Fatal("rejected upgrade interrupted old movie")
	}
	next, err := m.Acquire("a", "newhd", "1080p")
	if err != nil {
		t.Fatal(err)
	}
	if old.Context().Err() == nil {
		t.Fatal("old stream not cancelled")
	}
	old.Release()
	if next.Context().Err() != nil || len(m.Snapshot()) != 2 {
		t.Fatal("stale release damaged replacement")
	}
}

func TestRangesAndReleaseGrace(t *testing.T) {
	m := New(time.Minute)
	now := time.Now()
	m.now = func() time.Time { return now }
	a, _ := m.Acquire("a", "movie", "4k")
	b, _ := m.Acquire("a", "movie", "4k")
	a.Release()
	a.Release()
	now = now.Add(2 * time.Hour)
	if len(m.Snapshot()) != 1 {
		t.Fatal("live response expired")
	}
	b.Release()
	now = now.Add(59 * time.Second)
	if _, err := m.Acquire("b", "other", "1080p"); err != ErrCapacity {
		t.Fatal("grace not respected")
	}
	now = now.Add(2 * time.Second)
	if _, err := m.Acquire("b", "other", "1080p"); err != nil {
		t.Fatal("slot did not expire", err)
	}
}

func TestConcurrentAdmission(t *testing.T) {
	m := New(time.Minute)
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := m.Acquire(string(rune('a'+i)), "movie", "1080p"); err == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if accepted != 2 {
		t.Fatalf("admitted %d clients", accepted)
	}
}

func TestQuality(t *testing.T) {
	for name, want := range map[string]string{"Movie.2160p.mkv": "4k", "Movie.UHD.mkv": "4k", "Movie.4K.mkv": "4k", "Movie.1080p.mkv": "1080p", "Movie.720p.mkv": "1080p", "unknown.mkv": "4k"} {
		if got := Classify(name); got != want {
			t.Fatalf("%s: %s", name, got)
		}
	}
}
