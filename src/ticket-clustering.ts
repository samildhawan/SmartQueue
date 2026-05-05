// ticket-clustering.ts
//
// Client-side embedding + density-based clustering for SmartQueue tickets.
// Uses MiniLM-L6-v2 via @xenova/transformers (ONNX in-browser) and DBSCAN
// from density-clustering. Model is lazy-loaded once and cached in IndexedDB.

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
  // Clamp to handle floating-point overshoot at the boundaries
  return Math.max(0, 1 - Math.min(1, dot));
};

// Embed a single text. Mean-pooled output, then L2-normalized.
export const embedText = async (text: string): Promise<Float32Array> => {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: false });
  return l2Normalize(new Float32Array(output.data));
};

// Build the text representation of a ticket for embedding.
// Concatenating topic + assignment + summary gives richer signal than
// any single field alone — semantically similar questions cluster even
// when their `topic` enum value differs.
export const ticketToText = (
  ticket: { topic?: string; assignment?: string; summary?: string }
): string => {
  return [ticket.topic, ticket.assignment, ticket.summary]
    .filter(Boolean)
    .join('. ');
};

export interface TicketLike {
  id: string;
  topic?: string;
  assignment?: string;
  summary?: string;
}

export interface ClusterMeta {
  id: number;
  ticketIds: string[];
  label: string;             // Human-readable label derived from representative ticket
  representativeTicketId: string;
}

export interface ClusterResult {
  clusterLabels: Map<string, number>;  // ticketId -> cluster id, -1 = noise
  clusters: ClusterMeta[];             // Sorted largest-first
  noiseTicketIds: string[];            // Tickets DBSCAN classified as singletons
}

// Run DBSCAN over the embeddings and produce labeled clusters.
//
// Tuning notes:
//   - `eps` is cosine distance, so 0 = identical, 1 = orthogonal, 2 = opposite.
//     For L2-normalized MiniLM embeddings, 0.4–0.5 tends to group paraphrases
//     of the same question without merging unrelated ones. Loosen if clusters
//     are too granular, tighten if unrelated questions get merged.
//   - `minPts = 2` means "any pair of similar questions is a cluster" which is
//     the right semantics for office-hours scale (n ~ 5-30).
export const clusterEmbeddings = (
  embeddings: Map<string, Float32Array>,
  tickets: TicketLike[],
  opts: { eps?: number; minPts?: number } = {}
): ClusterResult => {
  const { eps = 0.45, minPts = 2 } = opts;

  const ids: string[] = [];
  const vectors: number[][] = [];
  for (const [id, vec] of embeddings.entries()) {
    ids.push(id);
    vectors.push(Array.from(vec));
  }

  if (ids.length === 0) {
    return { clusterLabels: new Map(), clusters: [], noiseTicketIds: [] };
  }

  const dbscan = new DBSCAN();
  const clusterIndices: number[][] = dbscan.run(vectors, eps, minPts, cosineDistance);
  const noiseIndices = new Set<number>(dbscan.noise);

  const clusterLabels = new Map<string, number>();
  const ticketsById = new Map(tickets.map(t => [t.id, t]));

  // First mark noise points
  noiseIndices.forEach(idx => clusterLabels.set(ids[idx], -1));

  const clusters: ClusterMeta[] = [];

  clusterIndices.forEach((memberIndices, clusterId) => {
    memberIndices.forEach(idx => clusterLabels.set(ids[idx], clusterId));

    // Compute centroid of cluster members
    const dim = vectors[0].length;
    const centroid = new Array<number>(dim).fill(0);
    for (const idx of memberIndices) {
      for (let d = 0; d < dim; d++) centroid[d] += vectors[idx][d];
    }
    for (let d = 0; d < dim; d++) centroid[d] /= memberIndices.length;

    // Pick the cluster member nearest the centroid as the representative.
    // This is the "medoid in normalized space" trick — gives us a real
    // ticket whose content typifies the cluster.
    let bestIdx = memberIndices[0];
    let bestDist = Infinity;
    for (const idx of memberIndices) {
      const d = cosineDistance(centroid, vectors[idx]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }
    const repId = ids[bestIdx];
    const repTicket = ticketsById.get(repId);

    // Build a readable label from the representative ticket
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
      id: clusterId,
      ticketIds: memberIndices.map(i => ids[i]),
      label,
      representativeTicketId: repId,
    });
  });

  // Sort clusters largest-first so the busiest topic shows up first in the UI
  clusters.sort((a, b) => b.ticketIds.length - a.ticketIds.length);

  const noiseTicketIds = Array.from(noiseIndices).map(i => ids[i]);

  return { clusterLabels, clusters, noiseTicketIds };
};
