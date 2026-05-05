// ticket-clustering.ts
//
// Client-side embedding + density-based clustering for SmartQueue tickets.
// Uses MiniLM-L6-v2 via @xenova/transformers (ONNX in-browser) and DBSCAN
// from density-clustering. Model is lazy-loaded once and cached in IndexedDB.
//
// Tickets can carry a `pinnedToTicketId` override that forces them to share
// a cluster with another ticket regardless of embedding similarity. The
// special value "__noise__" pins a ticket to the "Other / unique questions"
// bucket. Pins survive reclustering, so a TA's manual grouping decisions
// stick until they're explicitly undone.

import { pipeline, env } from '@xenova/transformers';
import { DBSCAN } from 'density-clustering';

// Cache models in IndexedDB so the ~14MB quantized weights only download once
env.useBrowserCache = true;
env.allowLocalModels = false;

// Singleton extractor — kicked off on first call, awaited by everyone after
let extractorPromise: Promise<any> | null = null;

const getExtractor = () => {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );
  }
  return extractorPromise;
};

// L2-normalize a vector. We do this ourselves rather than rely on the
// pipeline's normalize flag because it makes cosine distance == 1 - dot,
// which is faster and lets DBSCAN's tolerance be more interpretable.
const l2Normalize = (vec: Float32Array): Float32Array => {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
};

// Cosine distance assuming inputs are L2-normalized
const cosineDistance = (a: number[] | Float32Array, b: number[] | Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, 1 - Math.min(1, dot));
};

export const embedText = async (text: string): Promise<Float32Array> => {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: false });
  return l2Normalize(new Float32Array(output.data));
};

export const ticketToText = (
  ticket: { topic?: string; assignment?: string; summary?: string }
): string => {
  return [ticket.topic, ticket.assignment, ticket.summary]
    .filter(Boolean)
    .join('. ');
};

// Sentinel used in `pinnedToTicketId` to mean "always go to the Other bucket"
export const NOISE_PIN = '__noise__';

export interface TicketLike {
  id: string;
  topic?: string;
  assignment?: string;
  summary?: string;
  pinnedToTicketId?: string | null;
}

export interface ClusterMeta {
  id: number;
  ticketIds: string[];
  label: string;
  representativeTicketId: string;
}

export interface ClusterResult {
  clusterLabels: Map<string, number>;
  clusters: ClusterMeta[];
  noiseTicketIds: string[];
}

// Resolve a chain of pins to its terminal target.
// e.g. if A pins to B, and B pins to C, then A's effective target is C.
// Returns null if the ticket isn't pinned. Returns NOISE_PIN if it
// resolves to noise. Returns the terminal ticket id otherwise.
// Cycle-safe via a visited set, breaking ties by treating cycles as unpinned.
const resolvePinTarget = (
  ticketId: string,
  ticketsById: Map<string, TicketLike>
): string | null => {
  const start = ticketsById.get(ticketId);
  if (!start || !start.pinnedToTicketId) return null;
  if (start.pinnedToTicketId === NOISE_PIN) return NOISE_PIN;

  const visited = new Set<string>([ticketId]);
  let current: string = start.pinnedToTicketId;

  while (!visited.has(current)) {
    visited.add(current);
    const ticket = ticketsById.get(current);
    if (!ticket) return null; // Pin target doesn't exist
    if (!ticket.pinnedToTicketId) return current; // End of chain
    if (ticket.pinnedToTicketId === NOISE_PIN) return NOISE_PIN;
    current = ticket.pinnedToTicketId;
  }
  // Cycle — treat as unpinned
  return null;
};

// Run DBSCAN over the embeddings and produce labeled clusters, honoring
// any manual pins set via `pinnedToTicketId`.
//
// Algorithm:
//   1. Identify pinned tickets and their resolved targets.
//   2. Run DBSCAN only on unpinned tickets, using their embeddings.
//   3. Attach each pinned ticket to its target's cluster (or noise).
export const clusterEmbeddings = (
  embeddings: Map<string, Float32Array>,
  tickets: TicketLike[],
  opts: { eps?: number; minPts?: number } = {}
): ClusterResult => {
  const { eps = 0.45, minPts = 2 } = opts;

  if (tickets.length === 0) {
    return { clusterLabels: new Map(), clusters: [], noiseTicketIds: [] };
  }

  const ticketsById = new Map(tickets.map(t => [t.id, t]));

  // Step 1: separate pinned from unpinned
  const pinnedTickets: { id: string; target: string }[] = [];
  const unpinnedTickets: TicketLike[] = [];
  for (const ticket of tickets) {
    const target = resolvePinTarget(ticket.id, ticketsById);
    if (target) {
      pinnedTickets.push({ id: ticket.id, target });
    } else {
      unpinnedTickets.push(ticket);
    }
  }

  // Step 2: run DBSCAN on unpinned tickets only
  const unpinnedIds: string[] = [];
  const unpinnedVectors: number[][] = [];
  for (const ticket of unpinnedTickets) {
    const vec = embeddings.get(ticket.id);
    if (!vec) continue;
    unpinnedIds.push(ticket.id);
    unpinnedVectors.push(Array.from(vec));
  }

  const rawClusterByTicket = new Map<string, number>();

  if (unpinnedVectors.length > 0) {
    const dbscan = new DBSCAN();
    const clusterIndices: number[][] = dbscan.run(unpinnedVectors, eps, minPts, cosineDistance);
    const noiseIndices = new Set<number>(dbscan.noise);

    noiseIndices.forEach(idx => rawClusterByTicket.set(unpinnedIds[idx], -1));
    clusterIndices.forEach((memberIndices, clusterId) => {
      memberIndices.forEach(idx => rawClusterByTicket.set(unpinnedIds[idx], clusterId));
    });
  }

  // Step 3: pinned tickets follow their target's cluster.
  // If the target is also noise, mint a fresh cluster around the pair.
  for (const { id, target } of pinnedTickets) {
    if (target === NOISE_PIN) {
      rawClusterByTicket.set(id, -1);
      continue;
    }
    const targetClusterId = rawClusterByTicket.get(target);
    if (targetClusterId === undefined || targetClusterId === -1) {
      // Pin-to-noise: handle in second pass below
      rawClusterByTicket.set(id, -2);
    } else {
      rawClusterByTicket.set(id, targetClusterId);
    }
  }

  // Promote pin-to-noise targets into manual clusters
  let nextClusterId = 0;
  for (const cid of rawClusterByTicket.values()) {
    if (cid >= 0 && cid >= nextClusterId) nextClusterId = cid + 1;
  }
  const noisePinClusters = new Map<string, number>();
  for (const { id, target } of pinnedTickets) {
    if (target === NOISE_PIN) continue;
    if (rawClusterByTicket.get(id) !== -2) continue;
    let manualCid = noisePinClusters.get(target);
    if (manualCid === undefined) {
      manualCid = nextClusterId++;
      noisePinClusters.set(target, manualCid);
      rawClusterByTicket.set(target, manualCid);
    }
    rawClusterByTicket.set(id, manualCid);
  }

  // Build final ClusterResult
  const clusterLabels = new Map<string, number>();
  const clusterMembers = new Map<number, string[]>();
  const noiseTicketIds: string[] = [];
  for (const [tid, cid] of rawClusterByTicket.entries()) {
    if (cid === -1) {
      noiseTicketIds.push(tid);
      clusterLabels.set(tid, -1);
    } else {
      if (!clusterMembers.has(cid)) clusterMembers.set(cid, []);
      clusterMembers.get(cid)!.push(tid);
      clusterLabels.set(tid, cid);
    }
  }

  const clusters: ClusterMeta[] = [];
  for (const [cid, memberIds] of clusterMembers.entries()) {
    const firstVec = memberIds.map(id => embeddings.get(id)).find(v => v);
    const dim = firstVec?.length ?? 0;
    const centroid = new Array<number>(dim).fill(0);
    let centroidCount = 0;
    for (const mid of memberIds) {
      const vec = embeddings.get(mid);
      if (!vec) continue;
      for (let d = 0; d < dim; d++) centroid[d] += vec[d];
      centroidCount++;
    }
    if (centroidCount > 0) {
      for (let d = 0; d < dim; d++) centroid[d] /= centroidCount;
    }

    let repId = memberIds[0];
    let bestDist = Infinity;
    for (const mid of memberIds) {
      const vec = embeddings.get(mid);
      if (!vec || centroidCount === 0) continue;
      const d = cosineDistance(centroid, Array.from(vec));
      if (d < bestDist) {
        bestDist = d;
        repId = mid;
      }
    }
    const repTicket = ticketsById.get(repId);

    let label = 'Untitled cluster';
    if (repTicket) {
      const topic = repTicket.topic || '';
      const summary = (repTicket.summary || '').trim();
      const truncated = summary.length > 60 ? summary.slice(0, 60).trimEnd() + '…' : summary;
      label = topic && truncated
        ? `${topic} — ${truncated}`
        : (topic || truncated || 'Untitled cluster');
    }

    clusters.push({
      id: cid,
      ticketIds: memberIds,
      label,
      representativeTicketId: repId,
    });
  }

  clusters.sort((a, b) => b.ticketIds.length - a.ticketIds.length);

  return { clusterLabels, clusters, noiseTicketIds };
};
