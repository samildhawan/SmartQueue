package ticket

import (
	"math"
	"reflect"
	"sort"
	"testing"
)

func TestToText(t *testing.T) {
	cases := []struct {
		name string
		in   Ticket
		want string
	}{
		{"all fields", Ticket{Topic: "Recursion", Assignment: "A3", Summary: "Base case help"}, "Recursion. A3. Base case help"},
		{"blank fields trimmed out", Ticket{Topic: "  ", Assignment: "A3", Summary: ""}, "A3"},
		{"whitespace trimmed", Ticket{Topic: " Recursion ", Summary: " Help "}, "Recursion. Help"},
		{"empty", Ticket{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ToText(c.in); got != c.want {
				t.Errorf("ToText(%+v) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestResolvePinTarget(t *testing.T) {
	byID := map[string]Ticket{
		"unpinned":   {ID: "unpinned"},
		"a":          {ID: "a", PinnedToTicketID: "b"},
		"b":          {ID: "b", PinnedToTicketID: "c"},
		"c":          {ID: "c"}, // end of chain
		"noisy":      {ID: "noisy", PinnedToTicketID: NoisePin},
		"chainNoise": {ID: "chainNoise", PinnedToTicketID: "noisy"},
		"dangling":   {ID: "dangling", PinnedToTicketID: "does-not-exist"},
		"cycleA":     {ID: "cycleA", PinnedToTicketID: "cycleB"},
		"cycleB":     {ID: "cycleB", PinnedToTicketID: "cycleA"},
	}

	cases := []struct {
		id   string
		want string
	}{
		{"unpinned", ""},
		{"a", "c"},          // chain resolves to terminal target
		{"noisy", NoisePin}, // direct noise pin
		{"chainNoise", NoisePin},
		{"dangling", ""}, // pin target doesn't exist -> treated as unpinned
		{"cycleA", ""},   // cycle -> unpinned
		{"cycleB", ""},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			if got := ResolvePinTarget(c.id, byID); got != c.want {
				t.Errorf("ResolvePinTarget(%q) = %q, want %q", c.id, got, c.want)
			}
		})
	}
}

func TestL2NormalizeAndCosineDistance(t *testing.T) {
	v := L2Normalize([]float64{3, 4})
	if math.Abs(v[0]-0.6) > 1e-9 || math.Abs(v[1]-0.8) > 1e-9 {
		t.Fatalf("L2Normalize({3,4}) = %v, want {0.6, 0.8}", v)
	}

	if got := CosineDistance(v, v); math.Abs(got) > 1e-9 {
		t.Errorf("CosineDistance(v, v) = %v, want ~0", got)
	}

	orthogonal := []float64{0.8, -0.6}
	if got := CosineDistance(v, orthogonal); math.Abs(got-1) > 1e-9 {
		t.Errorf("CosineDistance orthogonal = %v, want ~1", got)
	}

	// Zero vector: norm is 0, so L2Normalize returns it unchanged rather than
	// dividing by zero.
	zero := L2Normalize([]float64{0, 0})
	if zero[0] != 0 || zero[1] != 0 {
		t.Errorf("L2Normalize(zero) = %v, want unchanged zero vector", zero)
	}
}

func TestRunDBSCAN_TwoClustersAndNoise(t *testing.T) {
	// Two tight clusters near orthogonal basis vectors, plus one lone point
	// far from both.
	points := [][]float64{
		{1, 0, 0},
		{0.99, 0.01, 0},
		{0.98, 0, 0.02},
		{0, 1, 0},
		{0.01, 0.99, 0},
		{0, 0.98, 0.02},
		{0, 0, 1}, // noise: orthogonal to both clusters
	}
	labels := RunDBSCAN(points, 0.05, 2)

	if labels[6] != -1 {
		t.Errorf("expected point 6 to be noise, got cluster %d", labels[6])
	}
	c1 := labels[0]
	if c1 == -1 {
		t.Fatalf("expected point 0 to be clustered, got noise")
	}
	for _, i := range []int{1, 2} {
		if labels[i] != c1 {
			t.Errorf("expected point %d in cluster %d, got %d", i, c1, labels[i])
		}
	}
	c2 := labels[3]
	if c2 == -1 || c2 == c1 {
		t.Fatalf("expected point 3 in a distinct real cluster, got %d (cluster1=%d)", c2, c1)
	}
	for _, i := range []int{4, 5} {
		if labels[i] != c2 {
			t.Errorf("expected point %d in cluster %d, got %d", i, c2, labels[i])
		}
	}
}

func TestRunDBSCAN_AllOrthogonalIsAllNoise(t *testing.T) {
	points := [][]float64{
		{1, 0, 0, 0},
		{0, 1, 0, 0},
		{0, 0, 1, 0},
		{0, 0, 0, 1},
	}
	labels := RunDBSCAN(points, 0.1, 2)
	for i, l := range labels {
		if l != -1 {
			t.Errorf("point %d: got cluster %d, want noise (-1)", i, l)
		}
	}
}

func TestRunDBSCAN_Empty(t *testing.T) {
	if labels := RunDBSCAN(nil, 0.5, 2); len(labels) != 0 {
		t.Errorf("RunDBSCAN(nil) = %v, want empty", labels)
	}
}

func TestRunDBSCAN_MinPtsEdgeCase(t *testing.T) {
	// minPts of 1: every point is its own core point (region always includes
	// itself), so nothing should end up as noise.
	points := [][]float64{{1, 0}, {0, 1}, {-1, 0}}
	labels := RunDBSCAN(points, 0.01, 1)
	for i, l := range labels {
		if l == -1 {
			t.Errorf("point %d: got noise with minPts=1, want assigned to a cluster", i)
		}
	}
}

func TestClusterEmbeddings_PinsFollowTarget(t *testing.T) {
	tickets := []Ticket{
		{ID: "t1", Topic: "recursion"},
		{ID: "t2", Topic: "recursion"},
		{ID: "t3", Topic: "loops", PinnedToTicketID: "t1"}, // pinned into t1's cluster
		{ID: "t4", Topic: "loops", PinnedToTicketID: NoisePin},
		{ID: "t5", Topic: "loops", PinnedToTicketID: "t4"},     // chain through a ticket pinned to the sentinel -> stays noise
		{ID: "t6", Topic: "edge case"},                         // unpinned, isolated embedding -> genuine DBSCAN noise
		{ID: "t7", Topic: "edge case", PinnedToTicketID: "t6"}, // pinned to a *real* ticket that landed in noise
	}
	embeddings := map[string][]float64{
		"t1": {1, 0, 0},
		"t2": {0.999, 0.001, 0},
		"t3": {-1, 0, 0}, // embedding would normally put it far from t1, but the pin overrides
		"t4": {0, 1, 0},
		"t5": {0, -1, 0},
		"t6": {0, 0, 1},
		"t7": {0, 0, -1},
	}

	result := ClusterEmbeddings(embeddings, tickets, ClusterOptions{Eps: 0.05, MinPts: 2})

	if result.ClusterLabels["t3"] != result.ClusterLabels["t1"] {
		t.Errorf("t3 should share t1's cluster via pin, got t1=%d t3=%d", result.ClusterLabels["t1"], result.ClusterLabels["t3"])
	}
	if result.ClusterLabels["t1"] != result.ClusterLabels["t2"] {
		t.Errorf("t1 and t2 should DBSCAN into the same cluster")
	}
	if result.ClusterLabels["t4"] != -1 || result.ClusterLabels["t5"] != -1 {
		t.Errorf("t4 (direct noise pin) and t5 (chained through it) should both stay noise, got t4=%d t5=%d", result.ClusterLabels["t4"], result.ClusterLabels["t5"])
	}
	if result.ClusterLabels["t6"] != result.ClusterLabels["t7"] {
		t.Errorf("t7 pinned to t6 (a real ticket that landed in noise) should share a minted manual cluster, got t6=%d t7=%d", result.ClusterLabels["t6"], result.ClusterLabels["t7"])
	}
	if result.ClusterLabels["t6"] == -1 {
		t.Errorf("t6 should have been promoted out of noise into a manual cluster via t7's pin")
	}
}

func TestClusterEmbeddings_Empty(t *testing.T) {
	result := ClusterEmbeddings(map[string][]float64{}, nil, ClusterOptions{Eps: 0.45, MinPts: 2})
	if len(result.Clusters) != 0 || len(result.NoiseTicketIDs) != 0 {
		t.Errorf("expected empty result for no tickets, got %+v", result)
	}
}

func TestClusterEmbeddings_DeterministicMemberOrder(t *testing.T) {
	tickets := []Ticket{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	embeddings := map[string][]float64{
		"a": {1, 0}, "b": {0.999, 0.001}, "c": {0.998, 0.002},
	}
	result := ClusterEmbeddings(embeddings, tickets, ClusterOptions{Eps: 0.05, MinPts: 2})
	if len(result.Clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(result.Clusters))
	}
	members := append([]string(nil), result.Clusters[0].TicketIDs...)
	sort.Strings(members)
	if !reflect.DeepEqual(members, []string{"a", "b", "c"}) {
		t.Errorf("expected all three tickets in the cluster, got %v", members)
	}
}
