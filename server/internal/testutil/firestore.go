// Package testutil provides a Firestore client wired to a local emulator
// for tests that need to exercise real Firestore reads/writes/listeners —
// the class of code (internal/cluster, internal/hub, and the Service
// methods in internal/waittime) that unit tests alone can't cover.
package testutil

import (
	"context"
	"fmt"
	"math/rand"
	"net"
	"os"
	"testing"
	"time"

	"cloud.google.com/go/firestore"
)

// FirestoreClient connects to the emulator at FIRESTORE_EMULATOR_HOST
// (e.g. "localhost:8081", started via `docker compose up -d
// firestore-emulator`). The Firestore Go client detects this env var
// itself and talks to the emulator instead of production — no credentials
// needed. Skips the test if the emulator isn't running, so `go test ./...`
// doesn't hard-fail for anyone who hasn't started it.
func FirestoreClient(t *testing.T) *firestore.Client {
	t.Helper()

	host := os.Getenv("FIRESTORE_EMULATOR_HOST")
	if host == "" {
		t.Skip("FIRESTORE_EMULATOR_HOST not set — run `docker compose up -d firestore-emulator` and set FIRESTORE_EMULATOR_HOST=localhost:8081 to run this test")
	}
	if conn, err := net.DialTimeout("tcp", host, 500*time.Millisecond); err != nil {
		t.Skipf("Firestore emulator not reachable at %s (start it with `docker compose up -d firestore-emulator`): %v", host, err)
	} else {
		conn.Close()
	}

	ctx := context.Background()
	client, err := firestore.NewClient(ctx, "smartqueue-test")
	if err != nil {
		t.Fatalf("failed to create firestore client against emulator: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

// RandomID returns a short random ID, used to isolate each test's Firestore
// documents (sessions, tickets) from every other test sharing the same
// long-lived emulator instance instead of resetting it between runs.
func RandomID(prefix string) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 10)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return fmt.Sprintf("%s-%s", prefix, b)
}
