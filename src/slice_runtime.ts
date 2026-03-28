import { createHash } from "node:crypto";
import { embedText, tokenizeText } from "./vector.ts";

export const DEFAULT_SLICE_NAMESPACE = "default";
export const DEFAULT_SLICE_MAX_TOKENS = 2048;
const DEFAULT_SLICE_MAX_CHARS = 12000;

export type SliceSourceKind = "memory" | "document" | "artifact" | "plan_state" | "projection" | "journal";

export type SliceSourceRef = {
  id: string;
  kind: string;
};

export type SliceEmbeddingDescriptor = {
  provider: string;
  model: string;
  dimension: number;
  version: string;
};

export type RuntimeSliceRecord = {
  id: string;
  namespace: string;
  source_key: string;
  source_kind: SliceSourceKind;
  sequence: number;
  text: string;
  token_estimate: number;
  content_hash: string;
  created_at: string;
  metadata: Record<string, unknown>;
  source_ref?: SliceSourceRef;
  embedding: number[];
  embedding_provider: string;
  embedding_model: string;
  embedding_dimension: number;
};

export type SliceSearchResult = RuntimeSliceRecord & {
  score: number;
};

export type SliceStoreQuery = {
  namespace: string;
  vector: number[];
  limit: number;
  minScore?: number;
  source_keys?: string[];
  source_kinds?: SliceSourceKind[];
};

export interface SliceStore {
  init(): Promise<void>;
  getByContentHash(namespace: string, contentHash: string): Promise<RuntimeSliceRecord | null>;
  putMany(slices: RuntimeSliceRecord[]): Promise<{ stored: RuntimeSliceRecord[]; deduped: number }>;
  search(query: SliceStoreQuery): Promise<SliceSearchResult[]>;
}

export interface SliceEmbeddingProvider {
  readonly descriptor: SliceEmbeddingDescriptor;
  embedMany(texts: string[]): Promise<number[][]>;
}

export type SliceChunk = {
  sequence: number;
  text: string;
  token_estimate: number;
};

export function normalizeNamespace(namespace?: string | null): string {
  const trimmed = namespace?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_SLICE_NAMESPACE;
}

export function sanitizeSourceKey(sourceKey: string): string {
  return sourceKey.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "slice";
}

export function hashSliceText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function estimateTokenCount(text: string): number {
  const terms = tokenizeText(text);
  if (terms.length > 0) {
    return terms.length;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function chunkTextIntoSlices(
  text: string,
  maxTokens: number,
  options: { maxCharacters?: number } = {},
): SliceChunk[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }

  const effectiveMaxTokens = Math.max(1, maxTokens || DEFAULT_SLICE_MAX_TOKENS);
  const maxCharacters = Math.max(128, options.maxCharacters ?? DEFAULT_SLICE_MAX_CHARS);
  const words = normalized.split(" ");
  const chunks: SliceChunk[] = [];
  let current: string[] = [];
  let currentCharacters = 0;

  for (const word of words) {
    const separator = current.length > 0 ? 1 : 0;
    const nextCharacters = currentCharacters + separator + word.length;
    if (current.length >= effectiveMaxTokens || (nextCharacters > maxCharacters && current.length > 0)) {
      const chunkText = current.join(" ");
      chunks.push({
        sequence: chunks.length,
        text: chunkText,
        token_estimate: estimateTokenCount(chunkText),
      });
      current = [];
      currentCharacters = 0;
    }

    current.push(word);
    currentCharacters += (current.length > 1 ? 1 : 0) + word.length;
  }

  if (current.length > 0) {
    const chunkText = current.join(" ");
    chunks.push({
      sequence: chunks.length,
      text: chunkText,
      token_estimate: estimateTokenCount(chunkText),
    });
  }

  return chunks;
}

export function buildSliceId(namespace: string, sourceKey: string, sequence: number, contentHash: string): string {
  return `slice:${sanitizeSourceKey(namespace)}:${sanitizeSourceKey(sourceKey)}:${
    sequence.toString().padStart(4, "0")
  }:${contentHash.slice(0, 12)}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export class DeterministicSliceEmbedder implements SliceEmbeddingProvider {
  readonly descriptor: SliceEmbeddingDescriptor;

  constructor(
    private readonly dimension: number,
    model = "mnemosyne-hash-embed-v1",
    provider = "mnemosyne-runtime",
  ) {
    this.descriptor = {
      provider,
      model,
      dimension,
      version: "1",
    };
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const embedding = embedText(text, this.dimension, `${this.descriptor.provider}/${this.descriptor.model}`);
      if (embedding.length !== this.dimension) {
        throw new Error(`slice embedding dimension mismatch: expected ${this.dimension}, got ${embedding.length}`);
      }
      if (embedding.some((value) => !Number.isFinite(value))) {
        throw new Error("slice embedding contains non-finite values");
      }
      return embedding;
    });
  }
}

export class InMemorySliceStore implements SliceStore {
  private readonly byNamespace = new Map<string, Map<string, RuntimeSliceRecord>>();

  async init(): Promise<void> {
    return;
  }

  async getByContentHash(namespace: string, contentHash: string): Promise<RuntimeSliceRecord | null> {
    return this.byNamespace.get(namespace)?.get(contentHash) ?? null;
  }

  async putMany(slices: RuntimeSliceRecord[]): Promise<{ stored: RuntimeSliceRecord[]; deduped: number }> {
    const stored: RuntimeSliceRecord[] = [];
    let deduped = 0;

    for (const slice of slices) {
      const namespaceMap = this.byNamespace.get(slice.namespace) ?? new Map<string, RuntimeSliceRecord>();
      this.byNamespace.set(slice.namespace, namespaceMap);
      if (namespaceMap.has(slice.content_hash)) {
        deduped += 1;
        continue;
      }
      namespaceMap.set(slice.content_hash, slice);
      stored.push(slice);
    }

    return { stored, deduped };
  }

  async search(query: SliceStoreQuery): Promise<SliceSearchResult[]> {
    const namespaceMap = this.byNamespace.get(query.namespace);
    if (!namespaceMap) {
      return [];
    }

    const sourceKeys = query.source_keys ? new Set(query.source_keys) : null;
    const sourceKinds = query.source_kinds ? new Set(query.source_kinds) : null;
    const minScore = query.minScore ?? 0;

    return [...namespaceMap.values()]
      .filter((slice) => {
        if (sourceKeys && !sourceKeys.has(slice.source_key)) return false;
        if (sourceKinds && !sourceKinds.has(slice.source_kind)) return false;
        return true;
      })
      .map((slice) => ({
        ...slice,
        score: cosineSimilarity(query.vector, slice.embedding),
      }))
      .filter((slice) => slice.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit);
  }
}
