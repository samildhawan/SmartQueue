package waittime

import (
	"context"
	"fmt"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const alpha = 0.2

// ETAResponse is returned from the wait-time estimation endpoint.
type ETAResponse struct {
	SessionID        string  `json:"sessionId"`
	Topic            string  `json:"topic"`
	QueueLength      int     `json:"queueLength"`
	ConcurrentTAs    int     `json:"concurrentTas"`
	EstimatedSeconds float64 `json:"estimatedSeconds"`
	EstimatedMinutes float64 `json:"estimatedMinutes"`
	AverageSeconds   float64 `json:"averageSeconds"`
	Source           string  `json:"source"`
}

// Service records wait-time statistics and produces ETA values.
type Service struct {
	client *firestore.Client
}

func NewService(client *firestore.Client) *Service {
	return &Service{client: client}
}

func (s *Service) resolutionDocRef(sessionID, topic string) *firestore.DocumentRef {
	normalizedTopic := strings.ReplaceAll(strings.ToLower(topic), "/", "_")
	return s.client.Collection("sessions").Doc(sessionID).Collection("waittimeStats").Doc(normalizedTopic)
}

func (s *Service) EstimateETA(ctx context.Context, sessionID, topic string, queueLen, concurrentTAs int) (*ETAResponse, error) {
	if concurrentTAs <= 0 {
		concurrentTAs = 1
	}
	if queueLen < 0 {
		queueLen = 0
	}

	sessionAvgSeconds, err := s.loadSessionAverage(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	stat, err := s.loadTopicStat(ctx, sessionID, topic)
	if err != nil {
		return nil, err
	}

	averageSeconds := stat.EWMASeconds
	source := "topic"
	if averageSeconds <= 0 {
		averageSeconds = sessionAvgSeconds
		source = "session-default"
	}
	if averageSeconds <= 0 {
		averageSeconds = 300
		source = "fallback"
	}

	estimatedSeconds := averageSeconds * float64(queueLen) / float64(concurrentTAs)
	return &ETAResponse{
		SessionID:        sessionID,
		Topic:            topic,
		QueueLength:      queueLen,
		ConcurrentTAs:    concurrentTAs,
		EstimatedSeconds: estimatedSeconds,
		EstimatedMinutes: estimatedSeconds / 60,
		AverageSeconds:   averageSeconds,
		Source:           source,
	}, nil
}

func (s *Service) RecordResolution(ctx context.Context, sessionID, ticketID, topic, host string, durationSeconds float64) error {
	if durationSeconds <= 0 {
		return fmt.Errorf("durationSeconds must be > 0")
	}
	if topic == "" {
		topic = "unknown"
	}

	ref := s.resolutionDocRef(sessionID, topic)
	return s.client.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		// The Go Firestore client has no DocumentSnapshot.Exists() — Get()
		// returns a NotFound error and a nil snapshot when the doc is missing,
		// so existence is `err == nil`, not a method call on the result.
		notFound := status.Code(err) == codes.NotFound
		if err != nil && !notFound {
			return err
		}

		stat := topicStat{Topic: topic}
		if !notFound {
			if err := snap.DataTo(&stat); err != nil {
				return err
			}
		}
		if stat.EWMASeconds <= 0 {
			stat.EWMASeconds = durationSeconds
		} else {
			stat.EWMASeconds = alpha*durationSeconds + (1-alpha)*stat.EWMASeconds
		}
		stat.Count++
		stat.LastUpdated = time.Now()
		stat.Host = host
		return tx.Set(ref, stat)
	})
}

func (s *Service) ExportSessionCSV(ctx context.Context, sessionID string) ([]byte, error) {
	q := s.client.Collection("sessions").Doc(sessionID).Collection("tickets").OrderBy("createdAt", firestore.Asc)
	iter := q.Documents(ctx)
	defer iter.Stop()

	rows := []string{"ticketId,topic,helpType,status,createdAt,resolvedAt,durationSeconds"}
	for {
		snap, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		var ticket struct {
			Topic      string    `firestore:"topic"`
			HelpType   string    `firestore:"helpType"`
			CreatedAt  time.Time `firestore:"createdAt"`
			ResolvedAt time.Time `firestore:"resolvedAt"`
			Status     string    `firestore:"status"`
		}
		if err := snap.DataTo(&ticket); err != nil {
			return nil, err
		}
		duration := ""
		if !ticket.ResolvedAt.IsZero() {
			duration = fmt.Sprintf("%.1f", ticket.ResolvedAt.Sub(ticket.CreatedAt).Seconds())
		}
		rows = append(rows, fmt.Sprintf("%s,%q,%q,%s,%s,%s,%s",
			snap.Ref.ID,
			ticket.Topic,
			ticket.HelpType,
			ticket.Status,
			ticket.CreatedAt.Format(time.RFC3339),
			ticket.ResolvedAt.Format(time.RFC3339),
			duration,
		))
	}
	return []byte(strings.Join(rows, "\n")), nil
}

func (s *Service) loadSessionAverage(ctx context.Context, sessionID string) (float64, error) {
	snap, err := s.client.Collection("sessions").Doc(sessionID).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return 0, nil
		}
		return 0, err
	}
	var session struct {
		AvgMin float64 `firestore:"avgMin"`
	}
	if err := snap.DataTo(&session); err != nil {
		return 0, err
	}
	return session.AvgMin * 60, nil
}

func (s *Service) loadTopicStat(ctx context.Context, sessionID, topic string) (*topicStat, error) {
	if topic == "" {
		topic = "unknown"
	}
	ref := s.resolutionDocRef(sessionID, topic)
	snap, err := ref.Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return &topicStat{Topic: topic}, nil
		}
		return nil, err
	}
	stat := &topicStat{Topic: topic}
	if err := snap.DataTo(stat); err != nil {
		return nil, err
	}
	return stat, nil
}

type topicStat struct {
	Topic       string    `firestore:"topic" json:"topic"`
	Count       int64     `firestore:"count" json:"count"`
	EWMASeconds float64   `firestore:"ewmaSeconds" json:"ewmaSeconds"`
	Host        string    `firestore:"host" json:"host"`
	LastUpdated time.Time `firestore:"lastUpdated" json:"lastUpdated"`
}
