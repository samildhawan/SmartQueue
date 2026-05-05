// useTicketClusters.ts
//
// React hook that takes a list of tickets and returns clustered results.
// Lazy-loads the embedding model on first use, caches per-ticket embeddings
// across renders, and only re-embeds tickets whose content actually changed.
//
// Manual pins (`pinnedToTicketId`) are passed through to the clustering
// function. Pin changes don't trigger re-embedding because pins don't affect
// the embedding itself, only how clusters are assembled.

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
  loading: boolean;
  error: Error | null;
}

interface CachedEmbedding {
  contentHash: string;
  vec: Float32Array;
}

export function useTicketClusters(tickets: TicketLike[]): UseTicketClustersResult {
  const [clusters, setClusters] = useState<ClusterResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cacheRef = useRef<Map<string, CachedEmbedding>>(new Map());

  // Embedding-relevant signature: only ticket id + embeddable content.
  // Pins don't affect embeddings, so they're not in this signature.
  const embedSignature = useMemo(
    () => tickets
      .map(t => `${t.id}::${ticketToText(t)}`)
      .sort()
      .join('||'),
    [tickets]
  );

  // Pin-relevant signature: triggers reclustering without re-embedding.
  const pinSignature = useMemo(
    () => tickets
      .map(t => `${t.id}::${t.pinnedToTicketId ?? ''}`)
      .sort()
      .join('||'),
    [tickets]
  );

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
  // Re-run on either content changes (need new embeddings) or pin changes
  // (only need reclustering, but useEffect can't easily express that). The
  // embedding cache makes pin-only changes effectively free since cached
  // vectors are reused.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedSignature, pinSignature]);

  return { clusters, loading, error };
}
