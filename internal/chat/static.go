package chat

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"anonchat/web"
)

type staticHandler struct {
	files fs.FS
}

func newStaticHandler() http.Handler {
	files, err := fs.Sub(web.Files, "dist")
	if err != nil {
		panic(err)
	}
	return staticHandler{files: files}
}

func (h staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	requestPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if requestPath == "." || requestPath == "" {
		requestPath = "index.html"
	}
	if h.exists(requestPath) {
		h.serveFile(w, r, requestPath, strings.HasPrefix(requestPath, "_next/static/"))
		return
	}
	if requestPath == "room" || strings.HasPrefix(requestPath, "room/") && !strings.Contains(strings.TrimPrefix(requestPath, "room/"), "/") && !strings.Contains(path.Base(requestPath), ".") {
		h.serveFile(w, r, "room/placeholder.html", false)
		return
	}
	if strings.HasPrefix(requestPath, "_next/") || strings.Contains(path.Base(requestPath), ".") {
		h.serveFile(w, r, requestPath, strings.HasPrefix(requestPath, "_next/static/"))
		return
	}
	h.serveFile(w, r, "index.html", false)
}

func (h staticHandler) exists(name string) bool {
	info, err := fs.Stat(h.files, name)
	return err == nil && !info.IsDir()
}

func (h staticHandler) serveFile(w http.ResponseWriter, r *http.Request, name string, immutable bool) {
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(h.files, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if path.Ext(name) == ".webmanifest" {
		contentType = "application/manifest+json"
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err == nil {
		defer controller.SetWriteDeadline(time.Time{})
	}
	if immutable {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else if strings.HasSuffix(name, ".html") {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
