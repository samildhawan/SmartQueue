package hub

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Hub fans out live ticket updates to websocket clients, holding a single
// server-side Firestore listener per session instead of one per client.
type Hub struct {
	client *firestore.Client
	mu     sync.Mutex
	rooms  map[string]*room
}

type room struct {
	sessionID string
	clients   map[*websocket.Conn]struct{}
	cancel    context.CancelFunc
	refCount  int
	mu        sync.Mutex
}

func NewHub(client *firestore.Client) *Hub {
	return &Hub{
		client: client,
		rooms:  make(map[string]*room),
	}
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "sessionId query parameter is required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	room := h.joinRoom(sessionID)
	room.addClient(conn)

	defer func() {
		room.removeClient(conn)
		conn.Close()
	}()

	conn.SetReadLimit(512)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (h *Hub) joinRoom(sessionID string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()

	r, ok := h.rooms[sessionID]
	if ok {
		r.mu.Lock()
		r.refCount++
		r.mu.Unlock()
		return r
	}

	ctx, cancel := context.WithCancel(context.Background())
	r = &room{
		sessionID: sessionID,
		clients:   make(map[*websocket.Conn]struct{}),
		cancel:    cancel,
		refCount:  1,
	}
	h.rooms[sessionID] = r
	go r.run(ctx, h.client, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.rooms, sessionID)
	})
	return r
}

func (r *room) addClient(conn *websocket.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[conn] = struct{}{}
}

func (r *room) removeClient(conn *websocket.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, conn)
	if len(r.clients) == 0 {
		r.cancel()
	}
}

func (r *room) run(ctx context.Context, client *firestore.Client, onShutdown func()) {
	defer onShutdown()
	ticketsQuery := client.Collection("sessions").Doc(r.sessionID).Collection("tickets").OrderBy("createdAt", firestore.Asc)
	iter := ticketsQuery.Snapshots(ctx)
	defer iter.Stop()

	for {
		snap, err := iter.Next()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("firestore snapshot error for session %s: %v", r.sessionID, err)
			time.Sleep(2 * time.Second)
			continue
		}

		// QuerySnapshot.Documents is a *firestore.DocumentIterator, not a
		// slice — it needs draining via GetAll() before use.
		docs, err := snap.Documents.GetAll()
		if err != nil {
			log.Printf("failed to read snapshot documents for session %s: %v", r.sessionID, err)
			continue
		}

		payload, err := json.Marshal(map[string]any{
			"sessionId": r.sessionID,
			"tickets":   snapshotDocsToArray(docs),
			"readTime":  snap.ReadTime,
		})
		if err != nil {
			log.Printf("failed to marshal snapshot payload: %v", err)
			continue
		}
		// One Firestore snapshot event -> one payload written to every
		// currently-connected client. The previous version read this
		// payload off a channel once per client, which meant with 3+
		// clients only the first got a message and the rest blocked
		// forever waiting on a channel nothing more was ever pushed to.
		r.broadcast(payload)
	}
}

func (r *room) broadcast(payload []byte) {
	r.mu.Lock()
	clients := make([]*websocket.Conn, 0, len(r.clients))
	for conn := range r.clients {
		clients = append(clients, conn)
	}
	r.mu.Unlock()

	for _, conn := range clients {
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			conn.Close()
			r.removeClient(conn)
		}
	}
}

func snapshotDocsToArray(docs []*firestore.DocumentSnapshot) []map[string]any {
	out := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		data := doc.Data()
		data["id"] = doc.Ref.ID
		out = append(out, data)
	}
	return out
}
