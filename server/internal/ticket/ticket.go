// Package ticket holds the clustering and pin-resolution logic shared by
// internal/cluster. It has no Firestore or network dependency so it can be
// unit tested in milliseconds — it mirrors src/ticket-clustering.ts closely
// (same NoisePin sentinel, same cycle/pin-to-noise rules) so a TA's pinning
// workflow behaves identically whether clustering runs client- or server-side.
package ticket

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// NoisePin is the sentinel pinnedToTicketId value meaning "always goes to
// the Other / unique questions bucket", matching NOISE_PIN in
// src/ticket-clustering.ts.
const NoisePin = "__noise__"

// Ticket is the plain-struct view of a ticket used for clustering decisions.
// It intentionally carries no Firestore reference — callers convert to/from
// their own document-backed struct.
type Ticket struct {
	ID               string
	Topic            string
	Assignment       string
	Summary          string
	PinnedToTicketID string // empty means unpinned
	Embedding        []float64
	EmbeddedContent  string // exact text that produced Embedding, for cache invalidation
}

// ToText builds the text that gets embedded for a ticket, mirroring
// ticketToText in src/ticket-clustering.ts.
func ToText(t Ticket) string {
	parts := []string{t.Topic, t.Assignment, t.Summary}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return strings.Join(out, ". ")
}

// ResolvePinTarget resolves a chain of pins to its terminal target, exactly
// mirroring resolvePinTarget in src/ticket-clustering.ts: returns "" if the
// ticket isn't pinned, NoisePin if the chain resolves to noise (directly or
// via a dangling/self-referential chain), or the terminal ticket ID
// otherwise. Cycles resolve to unpinned ("").
func ResolvePinTarget(ticketID string, byID map[string]Ticket) string {
	start, ok := byID[ticketID]
	if !ok || start.PinnedToTicketID == "" {
		return ""
	}
	if start.PinnedToTicketID == NoisePin {
		return NoisePin
	}

	visited := map[string]bool{ticketID: true}
	current := start.PinnedToTicketID

	for !visited[current] {
		visited[current] = true
		t, ok := byID[current]
		if !ok {
			return "" // pin target doesn't exist
		}
		if t.PinnedToTicketID == "" {
			return current // end of chain
		}
		if t.PinnedToTicketID == NoisePin {
			return NoisePin
		}
		current = t.PinnedToTicketID
	}
	return "" // cycle — treat as unpinned
}

// L2Normalize returns a unit-length copy of vec, or vec unchanged if it has
// zero norm.
func L2Normalize(vec []float64) []float64 {
	var norm float64
	for _, v := range vec {
		norm += v * v
	}
	if norm == 0 {
		return vec
	}
	norm = math.Sqrt(norm)
	out := make([]float64, len(vec))
	for i, v := range vec {
		out[i] = v / norm
	}
	return out
}

// CosineDistance assumes both inputs are L2-normalized, matching
// cosineDistance in src/ticket-clustering.ts.
func CosineDistance(a, b []float64) float64 {
	var dot float64
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		dot += a[i] * b[i]
	}
	if dot > 1 {
		dot = 1
	}
	return math.Max(0, 1-dot)
}

// RunDBSCAN runs standard DBSCAN over points using CosineDistance, returning
// a cluster ID per point (indexed 0..len(points)-1) or -1 for noise.
//
// visited and labels are both indexed strictly by point index; expansion
// uses a growable seed list with a manually incrementing index so newly
// discovered border points get their neighborhoods checked too. This is the
// textbook formulation, not the cluster-ID-indexed variant that caused a
// negative-index panic in the original code.
func RunDBSCAN(points [][]float64, eps float64, minPts int) []int {
	labels := make([]int, len(points))
	for i := range labels {
		labels[i] = -1
	}
	visited := make([]bool, len(points))
	cluster := 0

	regionQuery := func(idx int) []int {
		neighbors := make([]int, 0)
		for j, p := range points {
			if CosineDistance(points[idx], p) <= eps {
				neighbors = append(neighbors, j)
			}
		}
		return neighbors
	}

	for i := range points {
		if visited[i] {
			continue
		}
		visited[i] = true
		neighbors := regionQuery(i)
		if len(neighbors) < minPts {
			continue // stays -1 (noise) unless later pulled in as a border point
		}
		labels[i] = cluster
		seeds := append([]int(nil), neighbors...)
		for si := 0; si < len(seeds); si++ {
			pn := seeds[si]
			if !visited[pn] {
				visited[pn] = true
				next := regionQuery(pn)
				if len(next) >= minPts {
					seeds = append(seeds, next...)
				}
			}
			if labels[pn] == -1 {
				labels[pn] = cluster
			}
		}
		cluster++
	}
	return labels
}

// ClusterOptions configures ClusterEmbeddings.
type ClusterOptions struct {
	Eps    float64
	MinPts int
}

// ClusterMeta describes one resolved cluster.
type ClusterMeta struct {
	ID                     int
	TicketIDs              []string
	Label                  string
	RepresentativeTicketID string
}

// ClusterResult is the outcome of ClusterEmbeddings.
type ClusterResult struct {
	ClusterLabels  map[string]int // ticketID -> clusterID, -1 for noise
	Clusters       []ClusterMeta
	NoiseTicketIDs []string
}

// ClusterEmbeddings runs DBSCAN over unpinned tickets' embeddings and then
// attaches pinned tickets to their resolved target's cluster (minting a new
// manual cluster for pin-to-noise pairs), mirroring clusterEmbeddings in
// src/ticket-clustering.ts step for step.
func ClusterEmbeddings(embeddings map[string][]float64, tickets []Ticket, opts ClusterOptions) ClusterResult {
	if len(tickets) == 0 {
		return ClusterResult{ClusterLabels: map[string]int{}, Clusters: []ClusterMeta{}, NoiseTicketIDs: []string{}}
	}

	byID := make(map[string]Ticket, len(tickets))
	for _, t := range tickets {
		byID[t.ID] = t
	}

	type pinned struct {
		id     string
		target string
	}
	var pinnedTickets []pinned
	var unpinnedTickets []Ticket
	for _, t := range tickets {
		target := ResolvePinTarget(t.ID, byID)
		if target != "" {
			pinnedTickets = append(pinnedTickets, pinned{id: t.ID, target: target})
		} else {
			unpinnedTickets = append(unpinnedTickets, t)
		}
	}

	unpinnedIDs := make([]string, 0, len(unpinnedTickets))
	unpinnedVectors := make([][]float64, 0, len(unpinnedTickets))
	for _, t := range unpinnedTickets {
		vec, ok := embeddings[t.ID]
		if !ok {
			continue
		}
		unpinnedIDs = append(unpinnedIDs, t.ID)
		unpinnedVectors = append(unpinnedVectors, vec)
	}

	rawCluster := make(map[string]int)
	if len(unpinnedVectors) > 0 {
		labels := RunDBSCAN(unpinnedVectors, opts.Eps, opts.MinPts)
		for i, cid := range labels {
			rawCluster[unpinnedIDs[i]] = cid
		}
	}

	// Pinned tickets follow their target's cluster; pin-to-noise is deferred
	// to -2 so a second pass can mint a fresh manual cluster for it.
	for _, p := range pinnedTickets {
		if p.target == NoisePin {
			rawCluster[p.id] = -1
			continue
		}
		targetCid, ok := rawCluster[p.target]
		if !ok || targetCid == -1 {
			rawCluster[p.id] = -2
		} else {
			rawCluster[p.id] = targetCid
		}
	}

	nextClusterID := 0
	for _, cid := range rawCluster {
		if cid >= 0 && cid >= nextClusterID {
			nextClusterID = cid + 1
		}
	}
	noisePinClusters := make(map[string]int)
	for _, p := range pinnedTickets {
		if p.target == NoisePin || rawCluster[p.id] != -2 {
			continue
		}
		manualCid, ok := noisePinClusters[p.target]
		if !ok {
			manualCid = nextClusterID
			nextClusterID++
			noisePinClusters[p.target] = manualCid
			rawCluster[p.target] = manualCid
		}
		rawCluster[p.id] = manualCid
	}

	clusterLabels := make(map[string]int, len(rawCluster))
	clusterMembers := make(map[int][]string)
	noiseIDs := make([]string, 0)
	// Iterate tickets (not the map) for deterministic member ordering.
	for _, t := range tickets {
		cid, ok := rawCluster[t.ID]
		if !ok {
			continue
		}
		clusterLabels[t.ID] = cid
		if cid == -1 {
			noiseIDs = append(noiseIDs, t.ID)
		} else {
			clusterMembers[cid] = append(clusterMembers[cid], t.ID)
		}
	}

	clusters := make([]ClusterMeta, 0, len(clusterMembers))
	for cid, members := range clusterMembers {
		repID, dim := members[0], 0
		for _, mid := range members {
			if vec := embeddings[mid]; vec != nil {
				dim = len(vec)
				break
			}
		}
		centroid := make([]float64, dim)
		centroidCount := 0
		for _, mid := range members {
			vec := embeddings[mid]
			if vec == nil {
				continue
			}
			for d := 0; d < dim; d++ {
				centroid[d] += vec[d]
			}
			centroidCount++
		}
		if centroidCount > 0 {
			for d := range centroid {
				centroid[d] /= float64(centroidCount)
			}
		}

		bestDist := math.Inf(1)
		for _, mid := range members {
			vec := embeddings[mid]
			if vec == nil || centroidCount == 0 {
				continue
			}
			d := CosineDistance(centroid, vec)
			if d < bestDist {
				bestDist = d
				repID = mid
			}
		}

		clusters = append(clusters, ClusterMeta{
			ID:                     cid,
			TicketIDs:              members,
			Label:                  clusterLabel(byID[repID]),
			RepresentativeTicketID: repID,
		})
	}

	sort.Slice(clusters, func(i, j int) bool {
		return len(clusters[i].TicketIDs) > len(clusters[j].TicketIDs)
	})

	return ClusterResult{ClusterLabels: clusterLabels, Clusters: clusters, NoiseTicketIDs: noiseIDs}
}

func clusterLabel(rep Ticket) string {
	topic := rep.Topic
	summary := strings.TrimSpace(rep.Summary)
	truncated := summary
	if len(summary) > 60 {
		truncated = strings.TrimRight(summary[:60], " ") + "…"
	}
	switch {
	case topic != "" && truncated != "":
		return fmt.Sprintf("%s — %s", topic, truncated)
	case topic != "":
		return topic
	case truncated != "":
		return truncated
	default:
		return "Untitled cluster"
	}
}
