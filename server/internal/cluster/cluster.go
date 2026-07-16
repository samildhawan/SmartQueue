// Package cluster does the Firestore-shaped work of reclustering a
// session's tickets: querying, resolving/caching embeddings via the Gemini
// API, and batching cluster metadata writes back to Firestore. The actual
// clustering decisions (DBSCAN, pin resolution) live in internal/ticket,
// which is deliberately dependency-free and unit tested on its own.
package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"

	"github.com/samildhawan/SmartQueue/server/internal/ticket"
)

const (
	defaultEps    = 0.45
	defaultMinPts = 2

	geminiEmbedEndpoint = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
)

// Service performs clustering of ticket embeddings and updates Firestore.
type Service struct {
	client    *firestore.Client
	projectID string
}

func NewService(client *firestore.Client, projectID string) *Service {
	return &Service{client: client, projectID: projectID}
}

// docTicket is the Firestore-backed document shape for a ticket.
type docTicket struct {
	ID               string                 `firestore:"-"`
	Ref              *firestore.DocumentRef `firestore:"-"`
	Topic            string                 `firestore:"topic"`
	Assignment       string                 `firestore:"assignment"`
	Summary          string                 `firestore:"summary"`
	PinnedToTicketID string                 `firestore:"pinnedToTicketId"`
	Embedding        []float64              `firestore:"embedding"`
	EmbeddedContent  string                 `firestore:"embeddedContent"`
}

func (d docTicket) toTicket() ticket.Ticket {
	return ticket.Ticket{
		ID:               d.ID,
		Topic:            d.Topic,
		Assignment:       d.Assignment,
		Summary:          d.Summary,
		PinnedToTicketID: d.PinnedToTicketID,
		Embedding:        d.Embedding,
		EmbeddedContent:  d.EmbeddedContent,
	}
}

func (s *Service) ReclusterSession(ctx context.Context, sessionID string) error {
	query := s.client.Collection("sessions").Doc(sessionID).Collection("tickets").OrderBy("createdAt", firestore.Asc)
	iter := query.Documents(ctx)
	defer iter.Stop()

	docs := make([]docTicket, 0)
	for {
		snap, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return err
		}
		var d docTicket
		if err := snap.DataTo(&d); err != nil {
			return err
		}
		d.ID = snap.Ref.ID
		d.Ref = snap.Ref
		docs = append(docs, d)
	}

	if len(docs) == 0 {
		return nil
	}

	embeddings, embeddedContent, err := s.resolveEmbeddings(ctx, docs)
	if err != nil {
		return err
	}

	tickets := make([]ticket.Ticket, len(docs))
	for i, d := range docs {
		tickets[i] = d.toTicket()
	}

	result := ticket.ClusterEmbeddings(embeddings, tickets, ticket.ClusterOptions{Eps: defaultEps, MinPts: defaultMinPts})

	return s.writeResults(ctx, docs, embeddings, embeddedContent, result)
}

// resolveEmbeddings returns, per ticket ID, the embedding vector to cluster
// with and the exact text that produced a freshly fetched embedding (empty
// if the cached embedding was reused). A ticket is re-embedded only when its
// current text differs from EmbeddedContent — comparing on Embedding != nil
// alone can't distinguish "embedded and unchanged" from "never embedded", so
// an edited ticket would never get re-embedded.
func (s *Service) resolveEmbeddings(ctx context.Context, docs []docTicket) (map[string][]float64, map[string]string, error) {
	embeddings := make(map[string][]float64, len(docs))
	embeddedContent := make(map[string]string)
	var mu sync.Mutex
	var wg sync.WaitGroup
	errCh := make(chan error, 1)

	for _, d := range docs {
		text := ticket.ToText(d.toTicket())
		if text == "" {
			embeddings[d.ID] = []float64{}
			continue
		}
		if d.Embedding != nil && d.EmbeddedContent == text {
			embeddings[d.ID] = d.Embedding
			continue
		}

		wg.Add(1)
		go func(d docTicket, text string) {
			defer wg.Done()
			vector, err := fetchGeminiEmbedding(ctx, text)
			if err != nil {
				select {
				case errCh <- err:
				default:
				}
				return
			}
			mu.Lock()
			embeddings[d.ID] = vector
			embeddedContent[d.ID] = text
			mu.Unlock()
		}(d, text)
	}

	wg.Wait()
	select {
	case err := <-errCh:
		return nil, nil, err
	default:
	}

	return embeddings, embeddedContent, nil
}

func (s *Service) writeResults(ctx context.Context, docs []docTicket, embeddings map[string][]float64, embeddedContent map[string]string, result ticket.ClusterResult) error {
	batch := s.client.Batch()
	for _, d := range docs {
		updates := []firestore.Update{
			{Path: "clusterId", Value: result.ClusterLabels[d.ID]},
		}
		if text, ok := embeddedContent[d.ID]; ok {
			updates = append(updates,
				firestore.Update{Path: "embedding", Value: embeddings[d.ID]},
				firestore.Update{Path: "embeddedContent", Value: text},
			)
		}
		batch.Update(d.Ref, updates)
	}
	for _, cluster := range result.Clusters {
		for _, ticketID := range cluster.TicketIDs {
			batch.Update(refFor(docs, ticketID), []firestore.Update{
				{Path: "clusterLabel", Value: cluster.Label},
				{Path: "clusterMemberCount", Value: len(cluster.TicketIDs)},
			})
		}
	}
	for _, ticketID := range result.NoiseTicketIDs {
		batch.Update(refFor(docs, ticketID), []firestore.Update{
			{Path: "clusterLabel", Value: "Other / unique question"},
			{Path: "clusterMemberCount", Value: 1},
		})
	}
	_, err := batch.Commit(ctx)
	return err
}

func refFor(docs []docTicket, ticketID string) *firestore.DocumentRef {
	for _, d := range docs {
		if d.ID == ticketID {
			return d.Ref
		}
	}
	return nil
}

// fetchGeminiEmbedding calls the public Generative Language API's
// embedContent endpoint. Auth is the `?key=` query param (the same
// GEMINI_API_KEY already used by @google/genai on the frontend), not a
// bearer token — there is no public embeddings endpoint at
// gemini.googleapis.com, and textembedding-gecko@001 is a Vertex AI model
// name that doesn't exist here.
func fetchGeminiEmbedding(ctx context.Context, text string) ([]float64, error) {
	apiKey := os.Getenv("GENAI_API_KEY")
	if apiKey == "" {
		return nil, errors.New("GENAI_API_KEY is required to generate server-side embeddings")
	}

	reqBody := map[string]any{
		"content": map[string]any{
			"parts": []map[string]string{{"text": text}},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s?key=%s", geminiEmbedEndpoint, apiKey)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gemini embedding failed: %s", resp.Status)
	}

	var payload struct {
		Embedding struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if len(payload.Embedding.Values) == 0 {
		return nil, errors.New("gemini returned no embedding values")
	}
	return ticket.L2Normalize(payload.Embedding.Values), nil
}
