// waittimeApi.ts
//
// Client for server/internal/waittime: a real ETA based on an
// exponentially-weighted moving average of actual resolution times,
// replacing `aheadCount * avgMin` math done entirely in the browser.
//
// Both calls are best-effort. If the Go backend isn't running, fetchETA
// resolves to null (caller keeps whatever value it already has — the
// avgMin-based estimate) and recordResolution silently no-ops; Firestore
// remains the source of truth for ticket state either way.

const API_BASE = (import.meta as any).env?.VITE_HUB_BASE || 'http://localhost:8080';

export interface ETAResponse {
  sessionId: string;
  topic: string;
  queueLength: number;
  concurrentTas: number;
  estimatedSeconds: number;
  estimatedMinutes: number;
  averageSeconds: number;
  source: string;
}

export async function fetchETA(
  sessionId: string,
  queueLength: number,
  concurrentTas = 1
): Promise<ETAResponse | null> {
  try {
    const url = new URL(`${API_BASE}/api/sessions/${sessionId}/eta`);
    url.searchParams.set('queueLength', String(queueLength));
    url.searchParams.set('concurrentTas', String(concurrentTas));
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return (await res.json()) as ETAResponse;
  } catch {
    return null;
  }
}

export async function recordResolution(
  sessionId: string,
  ticketId: string,
  topic: string,
  host: string,
  durationSeconds: number
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/sessions/${sessionId}/tickets/${ticketId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, host, durationSeconds }),
    });
  } catch {
    // best-effort — Firestore already recorded the resolution
  }
}
