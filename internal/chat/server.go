package chat

func NewServer(config Config) *App {
	if config.Limits.MaxRooms == 0 {
		config.Limits = DefaultLimits()
	}
	return &App{config: config, rooms: newRegistry(config.Limits), static: newStaticHandler(), limiter: newRateLimiter(config.Limits.MaxRateLimitKeys)}
}
