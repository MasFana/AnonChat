package chat

import (
	"hash/fnv"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const anonymousLimiterSlots = 64
const limiterShardCount = 32

type bucket struct {
	tokens  float64
	last    time.Time
	touched time.Time
}

type rateLimiter struct {
	// mu and entries retain test/debug visibility; request state lives in shards.
	mu      sync.Mutex
	entries map[string]bucket
	shards  [limiterShardCount]limiterShard
	maxKeys int
	count   atomic.Int64
}

type limiterShard struct {
	mu          sync.Mutex
	entries     map[string]bucket
	lastCleanup time.Time
}

func newRateLimiter(maxKeys int) *rateLimiter {
	l := &rateLimiter{entries: make(map[string]bucket), maxKeys: maxKeys}
	for index := range l.shards {
		l.shards[index].entries = make(map[string]bucket)
	}
	return l
}

func (l *rateLimiter) allow(key string, capacity int, interval time.Duration, now time.Time) bool {
	l.cleanupExpired(now)
	shard := &l.shards[limiterShardIndex(key)]
	shard.mu.Lock()
	defer shard.mu.Unlock()
	value, exists := shard.entries[key]
	if !exists {
		if l.count.Load() >= int64(l.maxKeys) {
			return false
		}
		value = bucket{tokens: float64(capacity), last: now, touched: now}
	}
	refillPerSecond := float64(capacity) / interval.Seconds()
	value.tokens += now.Sub(value.last).Seconds() * refillPerSecond
	if value.tokens > float64(capacity) {
		value.tokens = float64(capacity)
	}
	value.last = now
	value.touched = now
	if value.tokens < 1 {
		shard.entries[key] = value
		if !exists {
			l.count.Add(1)
		}
		return false
	}
	value.tokens--
	shard.entries[key] = value
	if !exists {
		l.count.Add(1)
	}
	return true
}

func (l *rateLimiter) cleanupExpired(now time.Time) {
	for index := range l.shards {
		shard := &l.shards[index]
		if now.Sub(shard.lastCleanup) < time.Minute {
			continue
		}
		shard.mu.Lock()
		removed := 0
		for existing, value := range shard.entries {
			if now.Sub(value.touched) >= 10*time.Minute {
				delete(shard.entries, existing)
				l.count.Add(-1)
				removed++
				if removed == 16 {
					break
				}
			}
		}
		shard.lastCleanup = now
		shard.mu.Unlock()
	}
}

func limiterShardIndex(key string) int {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(key))
	return int(hash.Sum32() % limiterShardCount)
}

func clientIP(remoteAddr, forwardedFor string, trustedProxies []netip.Prefix) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return strings.TrimSpace(remoteAddr)
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = rateLimitAddress(peer)
	if !trusted(peer, trustedProxies) || strings.TrimSpace(forwardedFor) == "" {
		return peer.String()
	}
	chain := strings.Split(forwardedFor, ",")
	addresses := make([]netip.Addr, len(chain))
	for index, value := range chain {
		address, parseErr := netip.ParseAddr(strings.TrimSpace(value))
		if parseErr != nil {
			return peer.String()
		}
		addresses[index] = rateLimitAddress(address)
	}
	current := peer
	for index := len(addresses) - 1; index >= 0 && trusted(current, trustedProxies); index-- {
		current = addresses[index]
	}
	return current.String()
}

func remotePeer(remoteAddr string) netip.Addr {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return rateLimitAddress(address)
}

func validClientAddress(value string) netip.Addr {
	address, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil || !address.IsGlobalUnicast() {
		return netip.Addr{}
	}
	return rateLimitAddress(address)
}

func anonymousLimiterSlot(anonID string) uint8 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(anonID))
	return uint8(hash.Sum64() % anonymousLimiterSlots)
}

func rateLimitAddress(address netip.Addr) netip.Addr {
	address = address.Unmap()
	if address.Is6() {
		return netip.PrefixFrom(address, 64).Masked().Addr()
	}
	return address
}

func trusted(address netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
