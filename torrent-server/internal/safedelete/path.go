package safedelete

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Only a single torrent root under the configured downloads directory is valid.
func Target(root, name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", errors.New("unsafe torrent root")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("unsafe download directory")
	}
	target := filepath.Join(absolute, name)
	relative, err := filepath.Rel(absolute, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", errors.New("outside download directory")
	}
	info, err = os.Lstat(target)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("symlink torrent root")
	}
	return target, nil
}
