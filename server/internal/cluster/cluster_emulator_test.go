package cluster

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/samildhawan/SmartQueue/server/internal/testutil"
	"github.com/samildhawan/SmartQueue/server/internal/ticket"
)

// TestReclusterSession_CachedEmbeddings exercises the full Firestore
// query -> DBSCAN -> write-back path in ReclusterSession using tickets that
// already carry a cached embedding matching their current text, so
// resolveEmbeddings takes the cache-hit path entirely — no GENAI_API_KEY or
// live Gemini call needed. The cache-miss path (fetchGeminiEmbedding) is a
// thin, separate function tested only when a real key is available; see
// TestReclusterSession_FetchesRealEmbeddings below.
func TestReclusterSession_CachedEmbeddings(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client, "smartqueue-test")
	ctx := context.Background()
	sessionID := testutil.RandomID("session")

	seed := []struct {
		id      string
		topic   string
		summary string
		vec     []float64
	}{
		{"t1", "Recursion", "help with base case", []float64{1, 0, 0}},
		{"t2", "Recursion", "help with base case again", []float64{0.999, 0.001, 0}},
		{"t3", "Loops", "off by one error", []float64{0, 0, 1}},
	}

	ticketsRef := client.Collection("sessions").Doc(sessionID).Collection("tickets")
	for i, tc := range seed {
		text := ticket.ToText(ticket.Ticket{Topic: tc.topic, Summary: tc.summary})
		if _, err := ticketsRef.Doc(tc.id).Set(ctx, map[string]any{
			"topic": tc.topic, "summary": tc.summary,
			"embedding": tc.vec, "embeddedContent": text,
			"createdAt": time.Now().Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("seeding ticket %s: %v", tc.id, err)
		}
	}

	if err := svc.ReclusterSession(ctx, sessionID); err != nil {
		t.Fatalf("ReclusterSession: %v", err)
	}

	get := func(id string) map[string]any {
		snap, err := ticketsRef.Doc(id).Get(ctx)
		if err != nil {
			t.Fatalf("reading %s: %v", id, err)
		}
		return snap.Data()
	}
	d1, d2, d3 := get("t1"), get("t2"), get("t3")

	if d1["clusterId"] != d2["clusterId"] {
		t.Errorf("t1 and t2 should share a cluster, got %v vs %v", d1["clusterId"], d2["clusterId"])
	}
	if c1, _ := d1["clusterId"].(int64); c1 == -1 {
		t.Errorf("t1/t2 should be a real cluster, not noise (-1)")
	}
	if d1["clusterMemberCount"] != int64(2) {
		t.Errorf("clusterMemberCount for t1 = %v, want 2", d1["clusterMemberCount"])
	}
	if c3, _ := d3["clusterId"].(int64); c3 != -1 {
		t.Errorf("t3 (far from the other two) should be noise (-1), got %v", d3["clusterId"])
	}
	if d3["clusterLabel"] != "Other / unique question" {
		t.Errorf("t3 clusterLabel = %v, want %q", d3["clusterLabel"], "Other / unique question")
	}
}

// TestReclusterSession_FetchesRealEmbeddings covers the one thing the cached
// test above deliberately skips: an actual call to fetchGeminiEmbedding.
// Requires GENAI_API_KEY and makes one real, billed Gemini API call, so it's
// skipped unless that key is present in the environment.
func TestReclusterSession_FetchesRealEmbeddings(t *testing.T) {
	if os.Getenv("GENAI_API_KEY") == "" {
		t.Skip("GENAI_API_KEY not set — skipping the one test that makes a real Gemini API call")
	}
	client := testutil.FirestoreClient(t)
	svc := NewService(client, "smartqueue-test")
	ctx := context.Background()
	sessionID := testutil.RandomID("session")

	ticketsRef := client.Collection("sessions").Doc(sessionID).Collection("tickets")
	if _, err := ticketsRef.Doc("t1").Set(ctx, map[string]any{
		"topic": "Recursion", "summary": "help with base case", "createdAt": time.Now(),
	}); err != nil {
		t.Fatalf("seeding ticket: %v", err)
	}

	if err := svc.ReclusterSession(ctx, sessionID); err != nil {
		t.Fatalf("ReclusterSession: %v", err)
	}

	snap, err := ticketsRef.Doc("t1").Get(ctx)
	if err != nil {
		t.Fatalf("reading ticket: %v", err)
	}
	data := snap.Data()
	embedding, _ := data["embedding"].([]any)
	if len(embedding) == 0 {
		t.Error("expected a real embedding to be written back, got none")
	}
	if data["embeddedContent"] != "Recursion. help with base case" {
		t.Errorf("embeddedContent = %v, want the ticket's ToText() output", data["embeddedContent"])
	}
}
