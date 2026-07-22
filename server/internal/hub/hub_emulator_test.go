package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/samildhawan/SmartQueue/server/internal/testutil"
)

func dialWS(t *testing.T, serverURL, sessionID string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http") + "/ws?sessionId=" + sessionID
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// waitForTicketCount reads messages off conn until one carries exactly
// `want` tickets, rather than assuming a fixed message index — the initial
// (often empty) snapshot a client sees on connect isn't guaranteed to line
// up 1:1 with when it joined relative to other clients on the same room.
func waitForTicketCount(t *testing.T, conn *websocket.Conn, want int, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("timed out waiting for a payload with %d ticket(s)", want)
		}
		conn.SetReadDeadline(time.Now().Add(remaining))
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read message: %v", err)
		}
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if tickets, _ := payload["tickets"].([]any); len(tickets) == want {
			return payload
		}
	}
}

func TestHub_RelaysTicketUpdatesToClient(t *testing.T) {
	client := testutil.FirestoreClient(t)
	h := NewHub(client)
	server := httptest.NewServer(http.HandlerFunc(h.HandleWebSocket))
	defer server.Close()

	sessionID := testutil.RandomID("session")
	conn := dialWS(t, server.URL, sessionID)

	ctx := context.Background()
	if _, err := client.Collection("sessions").Doc(sessionID).Collection("tickets").Doc("t1").Set(ctx, map[string]any{
		"topic": "Recursion", "status": "active", "createdAt": time.Now(),
	}); err != nil {
		t.Fatalf("writing ticket: %v", err)
	}

	payload := waitForTicketCount(t, conn, 1, 10*time.Second)
	tickets, _ := payload["tickets"].([]any)
	first, _ := tickets[0].(map[string]any)
	if first["topic"] != "Recursion" {
		t.Errorf("ticket topic = %v, want Recursion", first["topic"])
	}
	if first["id"] != "t1" {
		t.Errorf("ticket id = %v, want t1", first["id"])
	}
}

func TestHub_FansOutToMultipleClients(t *testing.T) {
	// Regression test for the original broadcast bug: the room read one
	// broadcast message per connected client off a single-item channel, so
	// with 3+ clients only the first ever received anything and the rest
	// blocked forever. Every client here must independently observe the
	// same write.
	client := testutil.FirestoreClient(t)
	h := NewHub(client)
	server := httptest.NewServer(http.HandlerFunc(h.HandleWebSocket))
	defer server.Close()

	sessionID := testutil.RandomID("session")
	conns := make([]*websocket.Conn, 3)
	for i := range conns {
		conns[i] = dialWS(t, server.URL, sessionID)
	}

	ctx := context.Background()
	if _, err := client.Collection("sessions").Doc(sessionID).Collection("tickets").Doc("t1").Set(ctx, map[string]any{
		"topic": "Loops", "status": "active", "createdAt": time.Now(),
	}); err != nil {
		t.Fatalf("writing ticket: %v", err)
	}

	for _, conn := range conns {
		waitForTicketCount(t, conn, 1, 10*time.Second)
	}
}
