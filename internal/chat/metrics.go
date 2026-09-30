package chat

import "sync/atomic"

type runtimeMetrics struct {
	roomCommands       atomic.Uint64
	commandLatencyNS   atomic.Uint64
	actorBusyNS        atomic.Uint64
	events             atomic.Uint64
	sseActive          atomic.Int64
	sseReconnects      atomic.Uint64
	sseSlowDisconnects atomic.Uint64
	sseReplay          atomic.Uint64
	sseSnapshots       atomic.Uint64
	eventRingOverflow  atomic.Uint64
	messages           atomic.Uint64
	pollVotes          atomic.Uint64
}
