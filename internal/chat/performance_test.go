package chat

import (
	"fmt"
	"testing"
	"time"
)

func BenchmarkLimiterAllow(b *testing.B) {
	limiter := newRateLimiter(10000)
	now := time.Now()
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		limiter.allow(fmt.Sprintf("client:%d", index%1000), 200, time.Minute, now)
	}
}

func BenchmarkLimiterAllowParallel(b *testing.B) {
	limiter := newRateLimiter(10000)
	now := time.Now()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			limiter.allow("client:shared", 200, time.Minute, now)
		}
	})
}

func BenchmarkBroadcastOneSubscriber(b *testing.B) {
	benchmarkBroadcast(b, 1)
}

func BenchmarkBroadcast32Subscribers(b *testing.B) {
	benchmarkBroadcast(b, 32)
}

func benchmarkBroadcast(b *testing.B, subscriberCount int) {
	limits := DefaultLimits()
	limits.MaxEventRing = 256
	ref := &roomRef{id: "benchmark", disconnects: make(chan uint64, subscriberCount), done: make(chan struct{})}
	actor := newRoomActor(ref, "owner", []byte("capability"), limits, &runtimeMetrics{}, func(RoomSummary) {}, func(*roomRef) {}, func(*roomRef) {})
	for id := uint64(1); id <= uint64(subscriberCount); id++ {
		actor.subscribers[id] = &subscriber{id: id, frames: make(chan []byte, 1)}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		actor.emit("message", map[string]string{"content": "benchmark"})
		for _, sub := range actor.subscribers {
			<-sub.frames
		}
	}
}

func BenchmarkRegistryList(b *testing.B) {
	benchmarkRegistryList(b, 100)
}

func BenchmarkRegistryList1000Rooms(b *testing.B) {
	benchmarkRegistryList(b, 1000)
}

func benchmarkRegistryList(b *testing.B, roomCount int) {
	registry := newRegistry(DefaultLimits())
	for index := 0; index < roomCount; index++ {
		id := fmt.Sprintf("room-%04d", index)
		registry.active[id] = &roomRef{id: id}
		registry.summaries[id] = RoomSummary{ID: id, CreatedAt: time.Unix(int64(index), 0), IsPublic: true, UserCount: 1}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_ = registry.list()
	}
}
