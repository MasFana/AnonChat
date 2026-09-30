package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"anonchat/internal/chat"
)

func main() {
	config, err := chat.LoadConfig()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	app := chat.NewServer(config)
	server := &http.Server{
		Addr: config.Address, Handler: app,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	shutdownSignal, stopSignal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	slog.Info("server listening", "address", config.Address)
	serveResult := make(chan error, 1)
	go func() { serveResult <- server.ListenAndServe() }()
	select {
	case err := <-serveResult:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("server stopped", "error", err)
			os.Exit(1)
		}
	case <-shutdownSignal.Done():
		app.BeginDrain()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		roomShutdown := make(chan error, 1)
		go func() { roomShutdown <- app.Shutdown(ctx) }()
		if err := server.Shutdown(ctx); err != nil {
			slog.Error("http shutdown timed out", "error", err)
			_ = server.Close()
		}
		select {
		case err := <-roomShutdown:
			if err != nil {
				slog.Error("room shutdown timed out", "error", err)
			}
		case <-ctx.Done():
			slog.Error("room shutdown timed out", "error", ctx.Err())
		}
	}
}
