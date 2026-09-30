package chat

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address           string
	Limits            Limits
	TrustedProxyCIDRs []netip.Prefix
	PprofToken        string
}

type Limits struct {
	MaxRooms                int
	MaxUsersPerRoom         int
	MaxMessagesPerRoom      int
	MaxEventRing            int
	MaxSubscribers          int
	MaxSubscriptionsPerUser int
	MaxSSEQueueFrames       int
	MaxCommandQueue         int
	MaxMessageBytes         int
	MaxRequestBodyBytes     int64
	MaxPollOptions          int
	MaxRateLimitKeys        int
	OwnerGrace              time.Duration
	HeartbeatInterval       time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		MaxRooms: 1000, MaxUsersPerRoom: 1000, MaxMessagesPerRoom: 1000,
		MaxEventRing: 256, MaxSubscribers: 100, MaxSubscriptionsPerUser: 4, MaxSSEQueueFrames: 32,
		MaxCommandQueue: 256, MaxMessageBytes: 64 * 1024, MaxRequestBodyBytes: 128 * 1024,
		MaxPollOptions: 8, MaxRateLimitKeys: 10000, OwnerGrace: 5 * time.Second, HeartbeatInterval: 15 * time.Second,
	}
}

func LoadConfig() (Config, error) {
	address := os.Getenv("ADDR")
	if address == "" {
		address = ":8080"
	}
	if _, _, err := net.SplitHostPort(address); err != nil {
		return Config{}, fmt.Errorf("invalid ADDR: %w", err)
	}
	trustedProxies, err := parseTrustedProxyCIDRs(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, err
	}
	limits := DefaultLimits()
	values := []struct {
		name    string
		target  *int
		minimum int
		maximum int
	}{
		{"MAX_ROOMS", &limits.MaxRooms, 1, 10000},
		{"MAX_USERS_PER_ROOM", &limits.MaxUsersPerRoom, 1, 10000},
		{"MAX_MESSAGES_PER_ROOM", &limits.MaxMessagesPerRoom, 1, 10000},
		{"MAX_EVENT_RING", &limits.MaxEventRing, 1, 4096},
		{"MAX_SUBSCRIBERS_PER_ROOM", &limits.MaxSubscribers, 1, 256},
		{"MAX_SUBSCRIPTIONS_PER_USER", &limits.MaxSubscriptionsPerUser, 1, 32},
		{"MAX_SSE_QUEUE_FRAMES", &limits.MaxSSEQueueFrames, 1, 256},
		{"MAX_ROOM_COMMAND_QUEUE", &limits.MaxCommandQueue, 1, 4096},
		{"MAX_MESSAGE_BYTES", &limits.MaxMessageBytes, 1, 64 * 1024},
		{"MAX_POLL_OPTIONS", &limits.MaxPollOptions, 2, 8},
		{"MAX_RATE_LIMIT_KEYS", &limits.MaxRateLimitKeys, 100, 100000},
	}
	for _, value := range values {
		parsed, err := envInt(value.name, *value.target, value.minimum, value.maximum)
		if err != nil {
			return Config{}, err
		}
		*value.target = parsed
	}
	if value := os.Getenv("MAX_REQUEST_BODY_BYTES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 1024 || parsed > 128*1024 {
			return Config{}, fmt.Errorf("MAX_REQUEST_BODY_BYTES must be between 1024 and 131072")
		}
		limits.MaxRequestBodyBytes = parsed
	}
	if value := os.Getenv("OWNER_AWAY_GRACE_MS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 100 || parsed > 60000 {
			return Config{}, fmt.Errorf("OWNER_AWAY_GRACE_MS must be between 100 and 60000")
		}
		limits.OwnerGrace = time.Duration(parsed) * time.Millisecond
	}
	if value := os.Getenv("HEARTBEAT_INTERVAL_MS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1000 || parsed > 60000 {
			return Config{}, fmt.Errorf("HEARTBEAT_INTERVAL_MS must be between 1000 and 60000")
		}
		limits.HeartbeatInterval = time.Duration(parsed) * time.Millisecond
	}
	return Config{Address: address, Limits: limits, TrustedProxyCIDRs: trustedProxies, PprofToken: os.Getenv("PPROF_TOKEN")}, nil
}

func parseTrustedProxyCIDRs(value string) ([]netip.Prefix, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, entry := range strings.Split(value, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(entry))
		if err != nil {
			return nil, fmt.Errorf("invalid TRUSTED_PROXY_CIDRS entry %q", entry)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func envInt(name string, fallback, minimum, maximum int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return parsed, nil
}
