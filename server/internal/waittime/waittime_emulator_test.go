package waittime

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/samildhawan/SmartQueue/server/internal/testutil"
)

// These tests exercise the Firestore-touching Service methods against a
// real (emulated) Firestore instead of mocking the client — the class of
// code the unit tests in http_test.go can't reach. Skipped automatically
// if the emulator isn't running; see testutil.FirestoreClient.

func TestEstimateETA_FallsBackWithNoData(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client)
	sessionID := testutil.RandomID("session")

	eta, err := svc.EstimateETA(context.Background(), sessionID, "Recursion", 3, 1)
	if err != nil {
		t.Fatalf("EstimateETA: %v", err)
	}
	if eta.Source != "fallback" {
		t.Errorf("Source = %q, want %q (no session doc, no topic stat)", eta.Source, "fallback")
	}
	if eta.AverageSeconds != 300 {
		t.Errorf("AverageSeconds = %v, want 300", eta.AverageSeconds)
	}
	if eta.EstimatedSeconds != 900 { // 300 * 3 / 1
		t.Errorf("EstimatedSeconds = %v, want 900", eta.EstimatedSeconds)
	}
}

func TestEstimateETA_UsesSessionAvgMinWhenNoTopicStat(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client)
	sessionID := testutil.RandomID("session")

	if _, err := client.Collection("sessions").Doc(sessionID).Set(context.Background(), map[string]any{
		"avgMin": 8.0,
	}); err != nil {
		t.Fatalf("seeding session doc: %v", err)
	}

	eta, err := svc.EstimateETA(context.Background(), sessionID, "Recursion", 2, 1)
	if err != nil {
		t.Fatalf("EstimateETA: %v", err)
	}
	if eta.Source != "session-default" {
		t.Errorf("Source = %q, want %q", eta.Source, "session-default")
	}
	if eta.AverageSeconds != 480 { // 8 min * 60
		t.Errorf("AverageSeconds = %v, want 480", eta.AverageSeconds)
	}
}

func TestRecordResolution_CreatesThenUpdatesEWMA(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client)
	ctx := context.Background()
	sessionID := testutil.RandomID("session")

	// First resolution: EWMA seeds directly to the observed duration.
	if err := svc.RecordResolution(ctx, sessionID, "ticket1", "Recursion", "TA Jane", 120); err != nil {
		t.Fatalf("RecordResolution (first): %v", err)
	}
	eta, err := svc.EstimateETA(ctx, sessionID, "Recursion", 1, 1)
	if err != nil {
		t.Fatalf("EstimateETA (after first): %v", err)
	}
	if eta.Source != "topic" {
		t.Fatalf("Source = %q, want %q", eta.Source, "topic")
	}
	if eta.AverageSeconds != 120 {
		t.Errorf("AverageSeconds after first resolution = %v, want 120", eta.AverageSeconds)
	}

	// Second resolution: alpha=0.2 EWMA — 0.2*240 + 0.8*120 = 144.
	if err := svc.RecordResolution(ctx, sessionID, "ticket2", "Recursion", "TA Jane", 240); err != nil {
		t.Fatalf("RecordResolution (second): %v", err)
	}
	eta, err = svc.EstimateETA(ctx, sessionID, "Recursion", 1, 1)
	if err != nil {
		t.Fatalf("EstimateETA (after second): %v", err)
	}
	want := 0.2*240 + 0.8*120
	if math.Abs(eta.AverageSeconds-want) > 0.001 {
		t.Errorf("AverageSeconds after second resolution = %v, want %v", eta.AverageSeconds, want)
	}
}

func TestRecordResolution_TopicNormalization(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client)
	ctx := context.Background()
	sessionID := testutil.RandomID("session")

	// Topic normalization lowercases and swaps "/" for "_" in the doc path
	// (resolutionDocRef) — verify a resolution recorded under one casing is
	// found when queried with different casing.
	if err := svc.RecordResolution(ctx, sessionID, "ticket1", "Data/Structures", "TA Jane", 60); err != nil {
		t.Fatalf("RecordResolution: %v", err)
	}
	eta, err := svc.EstimateETA(ctx, sessionID, "DATA/STRUCTURES", 1, 1)
	if err != nil {
		t.Fatalf("EstimateETA: %v", err)
	}
	if eta.Source != "topic" || eta.AverageSeconds != 60 {
		t.Errorf("expected normalized topic lookup to hit the same doc, got source=%q avg=%v", eta.Source, eta.AverageSeconds)
	}
}

func TestExportSessionCSV(t *testing.T) {
	client := testutil.FirestoreClient(t)
	svc := NewService(client)
	ctx := context.Background()
	sessionID := testutil.RandomID("session")

	created := time.Now().Add(-10 * time.Minute)
	resolved := created.Add(5 * time.Minute)

	ticketsRef := client.Collection("sessions").Doc(sessionID).Collection("tickets")
	if _, err := ticketsRef.Doc("resolved-ticket").Set(ctx, map[string]any{
		"topic": "Recursion", "helpType": "Quick Check", "status": "resolved",
		"createdAt": created, "resolvedAt": resolved,
	}); err != nil {
		t.Fatalf("seeding resolved ticket: %v", err)
	}
	if _, err := ticketsRef.Doc("active-ticket").Set(ctx, map[string]any{
		"topic": "Loops", "helpType": "Deep Dive", "status": "active",
		"createdAt": created,
	}); err != nil {
		t.Fatalf("seeding active ticket: %v", err)
	}

	csv, err := svc.ExportSessionCSV(ctx, sessionID)
	if err != nil {
		t.Fatalf("ExportSessionCSV: %v", err)
	}
	out := string(csv)
	if !strings.HasPrefix(out, "ticketId,topic,helpType,status,createdAt,resolvedAt,durationSeconds") {
		t.Errorf("missing expected CSV header, got: %s", out)
	}
	if !strings.Contains(out, `"Recursion"`) || !strings.Contains(out, "300.0") {
		t.Errorf("expected resolved ticket row with a 300s duration, got: %s", out)
	}
	if !strings.Contains(out, `"Loops"`) {
		t.Errorf("expected active ticket row (no duration), got: %s", out)
	}
}
