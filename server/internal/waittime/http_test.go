package waittime

import "testing"

func TestIntOrDefault(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		def  int
		want int
	}{
		{"empty falls back to default", "", 7, 7},
		{"valid positive", "12", 0, 12},
		{"non-numeric falls back to default", "abc", 3, 3},
		// intOrDefault deliberately does not reject negative numbers; a
		// slightly buggy client is clamped downstream in EstimateETA rather
		// than rejected here. See the open question in
		// backend-architecture.md about whether this should 400 instead.
		{"negative number passes through unclamped", "-5", 0, -5},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := intOrDefault(c.raw, c.def); got != c.want {
				t.Errorf("intOrDefault(%q, %d) = %d, want %d", c.raw, c.def, got, c.want)
			}
		})
	}
}
