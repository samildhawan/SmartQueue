// Command server wires the wait-time, clustering, and realtime-hub
// services into one HTTP process sitting between the SmartQueue frontend
// and Firestore. See backend-architecture.md for why these three exist.
package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"cloud.google.com/go/firestore"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/samildhawan/SmartQueue/server/internal/cluster"
	"github.com/samildhawan/SmartQueue/server/internal/hub"
	"github.com/samildhawan/SmartQueue/server/internal/waittime"
)

func main() {
	ctx := context.Background()

	projectID := os.Getenv("FIREBASE_PROJECT_ID")
	if projectID == "" {
		log.Fatal("FIREBASE_PROJECT_ID is required")
	}

	// Firestore databases named anything other than "(default)" (as this
	// project's is, per firestoreDatabaseId in firebase-applet-config.json
	// on the frontend) need NewClientWithDatabase — NewClient always targets
	// "(default)" and fails with a NotFound on a named database.
	databaseID := os.Getenv("FIRESTORE_DATABASE_ID")
	if databaseID == "" {
		databaseID = "(default)"
	}
	client, err := firestore.NewClientWithDatabase(ctx, projectID, databaseID)
	if err != nil {
		log.Fatalf("failed to create firestore client: %v", err)
	}
	defer client.Close()

	waittimeSvc := waittime.NewService(client)
	clusterSvc := cluster.NewService(client, projectID)
	realtimeHub := hub.NewHub(client)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	// No auth middleware exists yet (see backend-architecture.md's open
	// question on Firebase ID token verification) so this is left wide open
	// to match that same posture, not tightened independently of it.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST"},
		AllowedHeaders: []string{"Content-Type"},
	}))

	r.Route("/api", func(api chi.Router) {
		waittime.NewHandler(waittimeSvc).Routes(api)
		api.Post("/sessions/{sessionId}/recluster", func(w http.ResponseWriter, req *http.Request) {
			sessionID := chi.URLParam(req, "sessionId")
			if err := clusterSvc.ReclusterSession(req.Context(), sessionID); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	})
	r.Get("/ws", realtimeHub.HandleWebSocket)

	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("listening on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}
