package safedelete

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOnlyOwnedRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "film"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := Target(root, "film"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", ".", "..", "../outside", "a/b", "a\\b", "/tmp", "a\x00b"} {
		if _, err := Target(root, name); err == nil {
			t.Fatal("unsafe accepted", name)
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err == nil {
		if _, err := Target(root, "link"); err == nil {
			t.Fatal("symlink accepted")
		}
	}
}
