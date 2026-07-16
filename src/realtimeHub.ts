// realtimeHub.ts
//
// Client for server/internal/hub: one WebSocket per session, backed by a
// single server-side Firestore listener shared across every connected
// browser, instead of each browser opening its own onSnapshot listener
// (which Firestore bills per listener-read-stream).
//
// There's no auth on this endpoint yet (see backend-architecture.md's open
// question on Firebase ID token verification), and it's read-only — ticket
// writes (create/pin/resolve) still go straight to Firestore via the
// client SDK either way.
//
// If the hub can't be reached (backend not deployed, connection drops,
// etc.), callers are expected to fall back to a direct onSnapshot listener
// so the app keeps working without it.

const HUB_BASE = (import.meta as any).env?.VITE_HUB_BASE || 'http://localhost:8080';
const CONNECT_TIMEOUT_MS = 4000;

function wsURL(sessionId: string): string {
  const url = new URL(HUB_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

// Firestore Timestamp fields come back from the Go hub as whatever
// time.Time's MarshalJSON produces (an RFC3339 string), not a Firestore
// Timestamp object. Existing call sites throughout App.tsx do
// `ticket.createdAt?.toDate?.()`, so wrap parsed dates in a same-shaped
// object rather than touching every call site.
function toTimestampLike(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return {
    toDate: () => date,
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: (date.getTime() % 1000) * 1e6,
  };
}

function reviveTicket(raw: Record<string, any>): Record<string, any> {
  return {
    ...raw,
    createdAt: toTimestampLike(raw.createdAt),
    ...(raw.resolvedAt !== undefined ? { resolvedAt: toTimestampLike(raw.resolvedAt) } : {}),
  };
}

interface HubPayload {
  sessionId: string;
  tickets: Record<string, any>[];
  readTime: string;
}

/**
 * Connects to the realtime hub for one session. Calls `onTickets` with each
 * fanned-out update. Calls `onUnavailable` at most once — either the initial
 * connection never came up within CONNECT_TIMEOUT_MS, or an established
 * connection dropped — signaling the caller should fall back to a direct
 * Firestore listener. Returns a cleanup function.
 */
export function connectTicketsHub(
  sessionId: string,
  onTickets: (tickets: Record<string, any>[]) => void,
  onUnavailable: () => void
): () => void {
  let closed = false;
  let connectedOnce = false;
  let ws: WebSocket;

  const timeoutId = window.setTimeout(() => {
    if (!connectedOnce && !closed) {
      closed = true;
      ws?.close();
      onUnavailable();
    }
  }, CONNECT_TIMEOUT_MS);

  try {
    ws = new WebSocket(wsURL(sessionId));
  } catch (err) {
    window.clearTimeout(timeoutId);
    onUnavailable();
    return () => {};
  }

  ws.onopen = () => {
    connectedOnce = true;
    window.clearTimeout(timeoutId);
  };

  ws.onmessage = (event) => {
    try {
      const payload: HubPayload = JSON.parse(event.data);
      onTickets((payload.tickets || []).map(reviveTicket));
    } catch (err) {
      console.error(`Failed to parse hub payload for session ${sessionId}:`, err);
    }
  };

  ws.onclose = () => {
    window.clearTimeout(timeoutId);
    if (!closed) {
      closed = true;
      onUnavailable();
    }
  };

  return () => {
    closed = true;
    window.clearTimeout(timeoutId);
    ws.close();
  };
}
