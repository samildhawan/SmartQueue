package waittime

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// Handler exposes Service over HTTP.
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func (h *Handler) Routes(r chi.Router) {
	r.Get("/sessions/{sessionId}/eta", h.handleETA)
	r.Post("/sessions/{sessionId}/tickets/{ticketId}/resolve", h.handleRecordResolution)
	r.Get("/sessions/{sessionId}/export.csv", h.handleExportCSV)
}

func (h *Handler) handleETA(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	topic := r.URL.Query().Get("topic")
	queueLen := intOrDefault(r.URL.Query().Get("queueLength"), 0)
	concurrentTAs := intOrDefault(r.URL.Query().Get("concurrentTas"), 1)

	eta, err := h.svc.EstimateETA(r.Context(), sessionID, topic, queueLen, concurrentTAs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, eta)
}

func (h *Handler) handleRecordResolution(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	ticketID := chi.URLParam(r, "ticketId")

	var body struct {
		Topic           string  `json:"topic"`
		Host            string  `json:"host"`
		DurationSeconds float64 `json:"durationSeconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.svc.RecordResolution(r.Context(), sessionID, ticketID, body.Topic, body.Host, body.DurationSeconds); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	csv, err := h.svc.ExportSessionCSV(r.Context(), sessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sessionID+`.csv"`)
	w.Write(csv)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// intOrDefault parses a query-param integer, falling back to def on a parse
// error. It does NOT reject negative numbers — EstimateETA clamps queueLen
// and concurrentTAs internally instead. See backend-architecture.md's open
// question on whether the HTTP layer should 400 on negative input instead.
func intOrDefault(raw string, def int) int {
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return v
}
