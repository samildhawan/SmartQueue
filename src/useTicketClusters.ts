// useTicketClusters.ts
//
// React hook that takes a list of tickets and returns clustered results.
// Lazy-loads the embedding model on first use, caches per-ticket embeddings
// across renders, and only re-embeds tickets whose content actually changed.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  embedText,
  ticketToText,
  clusterEmbeddings,
  ClusterResult,
  TicketLike,
} from './ticket-clustering';

interface UseTicketClustersResult {
  clusters: ClusterResult | null;
  loading: boolean;          // True during the initial model load OR while embedding new tickets
  error: Error | null;
}

interface CachedEmbedding {
  contentHash: string;       // The text we last embedded for this ticket
  vec: Float32Array;
}

export function useTicketClusters(tickets: TicketLike[]): UseTicketClustersResult {
  const [clusters, setClusters] = useState<ClusterResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Embedding cache survives re-renders. Cleaned up when tickets are removed.
  const cacheRef = useRef<Map<string, CachedEmbedding>>(new Map());

  // Stable signature of the ticket list — only changes when ticket IDs or
  // their embeddable content change. This is what we depend on, since the
  // `tickets` array reference will change every Firestore snapshot even
  // when content is identical.
  const signature = useMemo(
    () => tickets
      .map(t => `${t.id}::${ticketToText(t)}`)
      .sort()
      .join('||'),
    [tickets]
  );

  // We need access to the latest tickets inside the effect, but we don't want
  // tickets-as-array-reference to be a dep. Ref + signature does the trick.
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;

  useEffect(() => {
    const currentTickets = ticketsRef.current;

    if (currentTickets.length === 0) {
      setClusters({ clusterLabels: new Map(), clusters: [], noiseTicketIds: [] });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const cache = cacheRef.current;
        const embeddings = new Map<string, Float32Array>();

        // Embed only what's new or changed
        for (const ticket of currentTickets) {
          const text = ticketToText(ticket);
          const cached = cache.get(ticket.id);
          if (cached && cached.contentHash === text) {
            embeddings.set(ticket.id, cached.vec);
            continue;
          }
          const vec = await embedText(text);
          if (cancelled) return;
          cache.set(ticket.id, { contentHash: text, vec });
          embeddings.set(ticket.id, vec);
        }

        // Evict cache entries for tickets that no longer exist
        const liveIds = new Set(currentTickets.map(t => t.id));
        for (const id of Array.from(cache.keys())) {
          if (!liveIds.has(id)) cache.delete(id);
        }

        const result = clusterEmbeddings(embeddings, currentTickets);
        if (!cancelled) {
          setClusters(result);
          setLoading(false);
        }
      } catch (err) {
        console.error('Ticket clustering failed:', err);
        if (!cancelled) {
          setError(err as Error);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  // signature is the real dependency; we read tickets via the ref above
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { clusters, loading, error };
}
