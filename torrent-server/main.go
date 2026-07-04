package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	bittorrent "github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/types/infohash"
	rangeparser "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/range-parser"
	responses "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/responses"
	gin "github.com/gin-gonic/gin"
)

type AddTorrentRequest struct {
	Path   string `json:"path"`
	Verify *bool  `json:"verify"`
}
type PlaybackLimiter struct {
	mu             sync.Mutex
	activeInfoHash string
	activeUntil    time.Time
}

func (p *PlaybackLimiter) Start(client *bittorrent.Client) {
	ticker := time.NewTicker(10 * time.Second)
	go func() {
		for range ticker.C {
			p.ApplyPolicy(client)
		}
	}()
}

func (p *PlaybackLimiter) MarkActive(client *bittorrent.Client, infoHash string) {
	p.mu.Lock()
	p.activeInfoHash = strings.ToLower(infoHash)
	p.activeUntil = time.Now().Add(4 * time.Hour)
	p.mu.Unlock()

	p.ApplyPolicy(client)
}

func (p *PlaybackLimiter) ApplyPolicy(client *bittorrent.Client) {
	p.mu.Lock()
	activeInfoHash := p.activeInfoHash
	activeUntil := p.activeUntil
	if activeInfoHash != "" && time.Now().After(activeUntil) {
		activeInfoHash = ""
		p.activeInfoHash = ""
		p.activeUntil = time.Time{}
	}
	p.mu.Unlock()

	for _, torrent := range client.Torrents() {
		if activeInfoHash == "" {
			// Idle mode: keep seeding possible, but do not let old partial torrents
			// resume downloading in the background and overload the torrent engine.
			torrent.DisallowDataDownload()
			torrent.AllowDataUpload()
			continue
		}

		if torrent.InfoHash().HexString() == activeInfoHash {
			torrent.AllowDataDownload()
			torrent.AllowDataUpload()
			continue
		}

		torrent.DisallowDataDownload()
		torrent.DisallowDataUpload()
	}
}

func (p *PlaybackLimiter) Status(client *bittorrent.Client) gin.H {
	p.ApplyPolicy(client)

	p.mu.Lock()
	defer p.mu.Unlock()

	active := p.activeInfoHash != "" && time.Now().Before(p.activeUntil)
	activeUntil := ""
	activeTimeoutMs := 0
	if active {
		activeUntil = p.activeUntil.Format(time.RFC3339)
		activeTimeoutMs = int(time.Until(p.activeUntil).Milliseconds())
	}

	return gin.H{
		"active":          active,
		"activeInfoHash":  p.activeInfoHash,
		"activeUntil":     activeUntil,
		"activeTimeoutMs": activeTimeoutMs,
	}
}

func main() {
	var port int
	var downloadDir string

	flag.IntVar(&port, "p", 0, "Port to run the server on")
	flag.StringVar(&downloadDir, "d", "", "Directory to store downloads")

	flag.Parse()

	if port == 0 {
		log.Fatal("Port flag is required")
		return
	}
	if downloadDir == "" {
		log.Fatal("Download directory flag is required")
		return
	}

	fmt.Printf("Starting server on port %d. Downloading to directory: %s\n", port, downloadDir)

	cfg := bittorrent.NewDefaultClientConfig()
	cfg.DataDir = downloadDir // Store all downloads in a specific directory
	cfg.Seed = true

	client, err := bittorrent.NewClient(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()
	playbackLimiter := &PlaybackLimiter{}
	playbackLimiter.Start(client)

	r := gin.Default()

	r.GET("/torrents", func(c *gin.Context) {
		playbackLimiter.ApplyPolicy(client)
		torrents := client.Torrents()
		response := responses.TorrentsToResponse(torrents)
		c.JSON(http.StatusOK, response)
	})

	r.GET("/playback-limiter", func(c *gin.Context) {
		c.JSON(http.StatusOK, playbackLimiter.Status(client))
	})

	r.POST("/playback-limiter/:infoHash", func(c *gin.Context) {
		infoHash := c.Param("infoHash")
		_, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}
		playbackLimiter.MarkActive(client, infoHash)
		c.JSON(http.StatusOK, playbackLimiter.Status(client))
	})

	r.POST("/torrents", func(c *gin.Context) {
		var json AddTorrentRequest
		if err := c.ShouldBindBodyWithJSON(&json); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		torrent, err := client.AddTorrentFromFile(json.Path)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		<-torrent.GotInfo()
		if json.Verify == nil || *json.Verify {
			torrent.VerifyData()
		}
		playbackLimiter.ApplyPolicy(client)
		response := responses.TorrentToResponse(torrent)
		c.JSON(http.StatusOK, response)
	})

	r.GET("/torrents/:infoHash", func(c *gin.Context) {
		playbackLimiter.ApplyPolicy(client)
		infoHash := c.Param("infoHash")
		torrent, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}
		response := responses.TorrentToResponse(torrent)
		c.JSON(http.StatusOK, response)
	})

	r.DELETE("/torrents/:infoHash", func(c *gin.Context) {
		infoHash := c.Param("infoHash")
		torrent, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}
		// Get torrent's root directory/files before dropping
		downloadPath := cfg.DataDir
		torrentName := torrent.Name()

		torrent.Drop()

		// Remove the data files
		fullPath := path.Join(downloadPath, torrentName)
		err := os.RemoveAll(fullPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Torrent removed but failed to delete data files",
				"details": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"message":  "Torrent and data deleted successfully",
			"infoHash": infoHash,
		})
	})

	r.Match([]string{"GET", "HEAD"}, "/torrents/:infoHash/files/*filePath", func(c *gin.Context) {
		infoHash := c.Param("infoHash")
		filepath := strings.TrimPrefix(c.Param("filePath"), "/")
		torrent, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}

		<-torrent.GotInfo()
		var targetFile *bittorrent.File
		for _, file := range torrent.Files() {
			if file.Path() == filepath {
				targetFile = file
				break
			}
		}
		if targetFile == nil {
			println(filepath)
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found: " + filepath})
			return
		}

		if c.Request.Method == "HEAD" {
			c.Status(http.StatusOK)
			c.Header("Content-Length", strconv.Itoa(int(targetFile.Length())))
			c.Header("Content-Type", getContentType(targetFile.Path()))
			c.Header("Accept-Ranges", "bytes")
			return
		}

		playbackLimiter.MarkActive(client, infoHash)

		// Get file size
		fileSize := targetFile.Length()

		// Parse range header
		rangeHeader := c.GetHeader("Range")
		start, end, err := rangeparser.ParseRangeHeader(rangeHeader, fileSize)

		if err != nil {
			fmt.Println(err)
			c.Status(http.StatusRequestedRangeNotSatisfiable)
			c.Header("Accept-Ranges", "bytes")
			c.Header("Content-Type", getContentType(filepath))
			c.Header("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
			return
		}

		// Set headers
		c.Status(http.StatusPartialContent)
		c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
		c.Header("Accept-Ranges", "bytes")
		c.Header("Content-Length", fmt.Sprintf("%d", end-start+1))
		c.Header("Content-Type", getContentType(filepath))

		// Create reader for the specific range
		reader := targetFile.NewReader()
		defer reader.Close()
		_, err = reader.Seek(start, io.SeekStart)
		if err != nil {
			c.String(http.StatusInternalServerError, "Failed to seek to position: %v", err)
			return
		}

		// Stream the range
		// Create a limited reader to read only the requested range
		limitedReader := io.LimitReader(reader, end-start+1)
		c.DataFromReader(http.StatusPartialContent, end-start+1, getContentType(filepath), limitedReader, nil)
	})

	r.Run(":" + strconv.Itoa(port))
}

func getContentType(filepath string) string {
	ext := strings.ToLower(path.Ext(filepath))
	switch ext {
	case ".mp4":
		return "video/mp4"
	case ".mkv":
		return "video/x-matroska"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	default:
		return "application/octet-stream"
	}
}
