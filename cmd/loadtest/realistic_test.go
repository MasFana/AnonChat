package main

import (
	"testing"
	"unicode/utf8"
)

func TestRealisticMessageExactUTF8Bytes(t *testing.T) {
	for _, source := range []bool{false, true} {
		for _, n := range []int{32, 500, 32768} {
			got := realisticMessage(n, source, "123")
			if len(got) != n || !utf8.ValidString(got) {
				t.Fatalf("source=%t bytes=%d got=%d valid=%t", source, n, len(got), utf8.ValidString(got))
			}
		}
	}
}
func TestScenarioMessagesPerSecond(t *testing.T) {
	if got := scenarioMessagesPerSecond(1, 50, "owner"); got != 1 {
		t.Fatal(got)
	}
	if got := scenarioMessagesPerSecond(1, 50, "round-robin"); got != 1 {
		t.Fatal(got)
	}
	if got := scenarioMessagesPerSecond(1, 50, "all"); got != 50 {
		t.Fatal(got)
	}
}
