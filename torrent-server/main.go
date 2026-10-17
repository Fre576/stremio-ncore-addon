package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	bittorrent "github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/types/infohash"
	"github.com/detarkende/stremio-ncore-addon/torrent-server/internal/playbacklimiter"
	rangeparser "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/range-parser"
	responses "github.com/detarkende/stremio-ncore-addon/torrent-server/internal/responses"
	"github.com/detarkende/stremio-ncore-addon/torrent-server/internal/safedelete"
	gin "github.com/gin-gonic/gin"
)

type AddTorrentRequest struct {
	Path   string `json:"path"`
	Verify *bool  `json:"verify"`
}
type PlaybackLimiter struct {
	policyMu sync.Mutex
	dataMu   sync.Mutex
	manager  *playbacklimiter.Manager
}

func (p *PlaybackLimiter) Start(client *bittorrent.Client) {
	ticker := time.NewTicker(time.Second)
	go func() {
		for range ticker.C {
			p.ApplyPolicy(client)
		}
	}()
}

func (p *PlaybackLimiter) ApplyPolicy(client *bittorrent.Client) {
	p.policyMu.Lock()
	defer p.policyMu.Unlock()
	sessions := p.manager.Snapshot()
	allowed := make(map[string]bool)
	for _, s := range sessions {
		allowed[s.InfoHash] = true
	}
	for _, torrent := range client.Torrents() {
		if allowed[torrent.InfoHash().HexString()] {
			torrent.AllowDataDownload()
			torrent.AllowDataUpload()
		} else {
			torrent.DisallowDataDownload()
			if len(sessions) == 0 {
				torrent.AllowDataUpload()
			} else {
				torrent.DisallowDataUpload()
			}
		}
	}
}

func (p *PlaybackLimiter) Status(client *bittorrent.Client) gin.H {
	p.ApplyPolicy(client)
	sessions := p.manager.Snapshot()
	first := ""
	if len(sessions) > 0 {
		first = sessions[0].InfoHash
	}
	return gin.H{"active": len(sessions) > 0, "activeInfoHash": first, "sessions": sessions, "graceSeconds": 60, "policy": "one-exclusive-4k-or-two-hd"}
}

type contextReader struct {
	ctx    context.Context
	reader bittorrent.Reader
}

func (r contextReader) Read(b []byte) (int, error) { return r.reader.ReadContext(r.ctx, b) }

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
	playbackLimiter := &PlaybackLimiter{manager: playbacklimiter.New(time.Minute)}
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

	r.POST("/torrents", func(c *gin.Context) {
		playbackLimiter.dataMu.Lock()
		defer playbackLimiter.dataMu.Unlock()
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
		playbackLimiter.manager.Register(torrent.InfoHash().HexString())
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
		playbackLimiter.dataMu.Lock()
		defer playbackLimiter.dataMu.Unlock()
		infoHash := c.Param("infoHash")
		torrent, ok := client.Torrent(infohash.FromHexString(infoHash))
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Torrent not found"})
			return
		}
		fullPath, err := safedelete.Target(cfg.DataDir, torrent.Name())
		if err == nil {
			for _, other := range client.Torrents() {
				if other != torrent && strings.EqualFold(other.Name(), torrent.Name()) {
					err = fmt.Errorf("shared torrent data directory")
					break
				}
			}
		}
		if err == nil && c.Query("cleanup") == "1" {
			stats := responses.TorrentToSummaryResponse(torrent)
			if stats.Progress < 1 || stats.Ratio < 1 {
				err = fmt.Errorf("cleanup requires complete torrent and ratio at least one")
			}
		}
		if err == nil {
			err = playbackLimiter.manager.DeleteIdle(infoHash, func() error {
				torrent.Drop()
				return os.RemoveAll(fullPath)
			})
		}
		if err != nil {
			c.JSON(http.StatusConflict, gin.H{
				"error":   "Torrent deletion refused or incomplete",
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

		// Get file size
		fileSize := targetFile.Length()

		// Parse range header. Some clients start with a plain GET before switching to byte ranges.
		rangeHeader := c.GetHeader("Range")
		start, end := int64(0), fileSize-1
		statusCode := http.StatusOK
		if rangeHeader != "" {
			var err error
			start, end, err = rangeparser.ParseRangeHeader(rangeHeader, fileSize)
			if err != nil {
				fmt.Println(err)
				c.Status(http.StatusRequestedRangeNotSatisfiable)
				c.Header("Accept-Ranges", "bytes")
				c.Header("Content-Type", getContentType(filepath))
				c.Header("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
				return
			}
			statusCode = http.StatusPartialContent
			c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
		}

		ip := net.ParseIP(c.GetHeader("X-Stremio-Client-IP"))
		if ip == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing trusted client IP"})
			return
		}
		quality := playbacklimiter.Classify(targetFile.Path() + " " + torrent.Name())
		lease, err := playbackLimiter.manager.Acquire(ip.String(), infoHash, quality)
		if err != nil {
			log.Printf("playback_denied ip=%s quality=%s hash=%s", ip.String(), quality, infoHash)
			c.Header("Retry-After", "60")
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "A szerver foglalt: egy 4K vagy ket HD lejatszas engedelyezett."})
			return
		}
		defer func() { lease.Release(); playbackLimiter.ApplyPolicy(client) }()
		playbackLimiter.ApplyPolicy(client)
		ctx, cancel := context.WithCancel(c.Request.Context())
		stopCancel := context.AfterFunc(lease.Context(), cancel)
		defer stopCancel()
		defer cancel()
		log.Printf("playback_admitted ip=%s quality=%s hash=%s range=%s", ip.String(), quality, infoHash, rangeHeader)

		// Set headers
		c.Status(statusCode)
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
		limitedReader := io.LimitReader(contextReader{ctx: ctx, reader: reader}, end-start+1)
		c.DataFromReader(statusCode, end-start+1, getContentType(filepath), limitedReader, nil)
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
