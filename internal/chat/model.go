package chat

import "time"

type User struct {
	ID            string    `json:"id"`
	ConnectedAt   time.Time `json:"connectedAt"`
	Subscriptions uint16    `json:"-"`
	PendingUntil  time.Time `json:"-"`
}

type Message struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"roomId"`
	UserID    string    `json:"userId"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

type PollOption struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Votes uint32 `json:"votes"`
}

type Poll struct {
	ID        string            `json:"id"`
	Question  string            `json:"question"`
	Options   []PollOption      `json:"options"`
	CreatedAt time.Time         `json:"createdAt"`
	Votes     map[string]string `json:"-"`
}

type Event struct {
	Seq  uint64
	Type string
	Data []byte
}

type MessageRing struct {
	items  []Message
	start  int
	length int
}

func NewMessageRing(capacity int) MessageRing {
	return MessageRing{items: make([]Message, capacity)}
}

func (r *MessageRing) Append(value Message) {
	if r.length < len(r.items) {
		r.items[(r.start+r.length)%len(r.items)] = value
		r.length++
		return
	}
	r.items[r.start] = value
	r.start = (r.start + 1) % len(r.items)
}

func (r *MessageRing) Snapshot() []Message {
	result := make([]Message, r.length)
	for index := range result {
		result[index] = r.items[(r.start+index)%len(r.items)]
	}
	return result
}

func (r *MessageRing) Len() int { return r.length }

type EventRing struct {
	items  []Event
	start  int
	length int
}

func NewEventRing(capacity int) EventRing {
	return EventRing{items: make([]Event, capacity)}
}

func (r *EventRing) Append(value Event) {
	if r.length < len(r.items) {
		r.items[(r.start+r.length)%len(r.items)] = value
		r.length++
		return
	}
	r.items[r.start] = value
	r.start = (r.start + 1) % len(r.items)
}

func (r *EventRing) ReplayAfter(cursor, current uint64) ([]Event, bool) {
	if cursor > current {
		return nil, false
	}
	if r.length == 0 {
		return []Event{}, cursor == current
	}
	oldest := r.items[r.start].Seq
	if cursor+1 < oldest && cursor != ^uint64(0) {
		return nil, false
	}
	result := make([]Event, 0, r.length)
	for index := 0; index < r.length; index++ {
		event := r.items[(r.start+index)%len(r.items)]
		if event.Seq > cursor {
			result = append(result, Event{Seq: event.Seq, Type: event.Type, Data: append([]byte(nil), event.Data...)})
		}
	}
	return result, true
}

func (r *EventRing) Len() int { return r.length }
