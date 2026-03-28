import type { AppConfig } from "./config.ts";
import { QdrantSliceStore } from "./adapters/qdrant_slice_store.ts";
import {
  buildSliceId,
  chunkTextIntoSlices,
  DEFAULT_SLICE_MAX_TOKENS,
  DeterministicSliceEmbedder,
  hashSliceText,
  type InMemorySliceStore,
  normalizeNamespace,
  type RuntimeSliceRecord,
  sanitizeSourceKey,
  type SliceEmbeddingProvider,
  type SliceSearchResult,
  type SliceSourceKind,
  type SliceSourceRef,
  type SliceStore,
} from "./slice_runtime.ts";
import { SliceJournal } from "./slice_journal.ts";
import {
  type HybridRetrieveInput,
  hybridRetrieveInputSchema,
  type HybridRetrieveResult,
  hybridRetrieveResultSchema,
  type SliceProjectionInput,
  type SliceProjectionResult,
  sliceProjectionResultSchema,
} from "./types.ts";
import { tokenizeText } from "./vector.ts";
import type { Logger } from "./utils.ts";

export type SliceIndexInput = {
  namespace?: string | null;
  source_key: string;
  source_kind: SliceSourceKind;
  text: string;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
  source_ref?: SliceSourceRef;
};

export type SliceIndexResult = {
  namespace: string;
  source_key: string;
  source_kind: SliceSourceKind;
  total_slices: number;
  stored_slices: number;
  deduped_slices: number;
  generated_at: string;
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
};

export type StoredSliceSearchInput = {
  namespace?: string | null;
  query: string;
  top_k?: number;
  min_score?: number;
  source_keys?: string[];
  source_kinds?: SliceSourceKind[];
};

export type StoredSliceSearchResult = {
  query: string;
  namespace: string;
  returned: number;
  results: SliceSearchResult[];
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
};

type SliceServiceDependencies = {
  store?: SliceStore;
  journal?: SliceJournal;
  embedder?: SliceEmbeddingProvider;
  hybridRetriever?: (input: HybridRetrieveInput) => Promise<HybridRetrieveResult>;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function projectionModeToFusionStrategy(
  mode: SliceProjectionInput["projection_mode"],
): HybridRetrieveInput["fusion_strategy"] {
  switch (mode) {
    case "focused":
      return "memory_first";
    case "broad":
      return "temporal_first";
    default:
      return "balanced";
  }
}

function projectionSourceWeight(
  source: HybridRetrieveResult["results"][number]["source"],
  mode: SliceProjectionInput["projection_mode"],
): number {
  const weights: Record<
    SliceProjectionInput["projection_mode"],
    Record<HybridRetrieveResult["results"][number]["source"], number>
  > = {
    focused: {
      plan_state: 1.15,
      hot: 1.12,
      journal: 0.88,
      graph: 0.96,
      vector: 1.1,
      temporal: 0.92,
    },
    balanced: {
      plan_state: 1,
      hot: 1,
      journal: 1,
      graph: 1,
      vector: 1,
      temporal: 1,
    },
    broad: {
      plan_state: 1.05,
      hot: 0.96,
      journal: 1.08,
      graph: 1.06,
      vector: 0.96,
      temporal: 1.1,
    },
  };

  return weights[mode][source] ?? 1;
}

function queryCoverageScore(query: string, text: string): number {
  const queryTerms = [...new Set(tokenizeText(query).filter((term) => term.length > 1))];
  if (queryTerms.length === 0) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  const matched = queryTerms.filter((term) => normalizedText.includes(term)).length;
  return matched / queryTerms.length;
}

export class SliceService {
  private readonly store: SliceStore;
  private readonly journal: SliceJournal;
  private readonly embedder: SliceEmbeddingProvider;
  private readonly hybridRetriever?: (input: HybridRetrieveInput) => Promise<HybridRetrieveResult>;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    dependencies: SliceServiceDependencies = {},
  ) {
    this.store = dependencies.store ?? new QdrantSliceStore(config, logger);
    this.journal = dependencies.journal ?? new SliceJournal(config.SLICE_JOURNAL_PATH);
    this.embedder = dependencies.embedder ??
      new DeterministicSliceEmbedder(config.VECTOR_DIM, config.SLICE_EMBED_MODEL, config.SLICE_EMBED_PROVIDER);
    this.hybridRetriever = dependencies.hybridRetriever;
  }

  async startup(): Promise<void> {
    await this.journal.init();
    await this.store.init();
  }

  status(): Record<string, unknown> {
    const storeWithStatus = this.store as unknown as { status?: () => Record<string, unknown> };
    const storeTopology = typeof storeWithStatus.status === "function" ? storeWithStatus.status() : null;
    return {
      namespace_default: "default",
      collection: this.config.SLICE_QDRANT_COLLECTION,
      journal: this.config.SLICE_JOURNAL_PATH,
      max_tokens_per_slice: this.config.SLICE_MAX_TOKENS,
      embedding: this.embedder.descriptor,
      vector_topology: storeTopology,
    };
  }

  async indexSource(input: SliceIndexInput): Promise<SliceIndexResult> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("slice source text cannot be empty");
    }

    const namespace = normalizeNamespace(input.namespace);
    const maxTokens = input.max_tokens ?? this.config.SLICE_MAX_TOKENS ?? DEFAULT_SLICE_MAX_TOKENS;
    const chunks = chunkTextIntoSlices(text, maxTokens);
    if (chunks.length === 0) {
      throw new Error("slice source text produced zero chunks");
    }

    const embeddings = await this.embedder.embedMany(chunks.map((chunk) => chunk.text));
    const generatedAt = new Date().toISOString();
    const sourceKey = sanitizeSourceKey(input.source_key);
    const records: RuntimeSliceRecord[] = chunks.map((chunk, index) => {
      const contentHash = hashSliceText(chunk.text);
      return {
        id: buildSliceId(namespace, sourceKey, chunk.sequence, contentHash),
        namespace,
        source_key: sourceKey,
        source_kind: input.source_kind,
        sequence: chunk.sequence,
        text: chunk.text,
        token_estimate: chunk.token_estimate,
        content_hash: contentHash,
        created_at: generatedAt,
        metadata: {
          ...(input.metadata ?? {}),
          total_chunks: chunks.length,
          chunk_index: index,
        },
        source_ref: input.source_ref,
        embedding: embeddings[index],
        embedding_provider: this.embedder.descriptor.provider,
        embedding_model: this.embedder.descriptor.model,
        embedding_dimension: this.embedder.descriptor.dimension,
      };
    });

    const stored = await this.store.putMany(records);
    await this.journal.appendMany(stored.stored);
    this.logger.info("slice_source_indexed", {
      namespace,
      source_key: sourceKey,
      source_kind: input.source_kind,
      total_slices: records.length,
      stored_slices: stored.stored.length,
      deduped_slices: stored.deduped,
    });

    return {
      namespace,
      source_key: sourceKey,
      source_kind: input.source_kind,
      total_slices: records.length,
      stored_slices: stored.stored.length,
      deduped_slices: stored.deduped,
      generated_at: generatedAt,
      embedding: {
        provider: this.embedder.descriptor.provider,
        model: this.embedder.descriptor.model,
        dimension: this.embedder.descriptor.dimension,
      },
    };
  }

  async searchStoredSlices(input: StoredSliceSearchInput): Promise<StoredSliceSearchResult> {
    const namespace = normalizeNamespace(input.namespace);
    const [vector] = await this.embedder.embedMany([input.query]);
    const results = await this.store.search({
      namespace,
      vector,
      limit: input.top_k ?? this.config.TOP_K_DEFAULT,
      minScore: input.min_score ?? 0.15,
      source_keys: input.source_keys,
      source_kinds: input.source_kinds,
    });

    return {
      query: input.query,
      namespace,
      returned: results.length,
      results,
      embedding: {
        provider: this.embedder.descriptor.provider,
        model: this.embedder.descriptor.model,
        dimension: this.embedder.descriptor.dimension,
      },
    };
  }

  async project(input: SliceProjectionInput): Promise<SliceProjectionResult> {
    const namespace = normalizeNamespace(input.namespace);
    const query = input.query ?? input.objective;

    const retrieval = this.hybridRetriever
      ? await this.hybridRetriever(hybridRetrieveInputSchema.parse({
        query,
        plan_id: input.plan_id ?? null,
        namespace,
        fusion_strategy: projectionModeToFusionStrategy(input.projection_mode),
        top_k: Math.min(25, Math.max(input.max_slices * 4, input.max_slices)),
        sources: input.sources,
        filters: input.filters,
        include_scores: true,
      }))
      : await this.projectFromStoredSlices(query, namespace, input.max_slices);

    return this.projectFromResults(input, retrieval.results);
  }

  private async projectFromStoredSlices(
    query: string,
    namespace: string,
    maxSlices: number,
  ): Promise<HybridRetrieveResult> {
    const search = await this.searchStoredSlices({
      namespace,
      query,
      top_k: Math.min(25, Math.max(maxSlices * 4, maxSlices)),
    });

    return hybridRetrieveResultSchema.parse({
      query,
      plan_id: null,
      namespace,
      fusion_strategy: "balanced",
      scanned_sources: ["vector"],
      returned: search.results.length,
      results: search.results.map((slice) => ({
        id: slice.id,
        source: "vector",
        text: slice.text,
        score: slice.score,
        created_at: slice.created_at,
        metadata: {
          ...slice.metadata,
          source_key: slice.source_key,
          source_kind: slice.source_kind,
        },
        channels: ["vector"],
      })),
    });
  }

  private projectFromResults(
    input: SliceProjectionInput,
    results: HybridRetrieveResult["results"],
  ): SliceProjectionResult {
    const namespace = normalizeNamespace(input.namespace);
    const queryContext = `${input.objective} ${input.query ?? ""}`.trim();
    const perSliceBudget = Math.max(
      64,
      Math.min(this.config.SLICE_MAX_TOKENS, Math.floor(input.max_tokens / Math.max(1, input.max_slices))),
    );
    const projectionCandidates = results.flatMap((result) => {
      const chunks = chunkTextIntoSlices(result.text, perSliceBudget);
      return chunks.map((chunk) => {
        const coverage = queryCoverageScore(queryContext, chunk.text);
        const positionWeight = Math.max(0.78, 1 - chunk.sequence * 0.05);
        const score = clamp01(
          (Number(result.score ?? 0.5) || 0.5) * projectionSourceWeight(result.source, input.projection_mode) *
            (0.7 + 0.3 * coverage) * positionWeight,
        );
        const sourceRef = input.include_sources
          ? {
            id: result.id,
            kind: typeof result.metadata.kind === "string" ? result.metadata.kind : "memory",
          }
          : undefined;

        return {
          slice_id: buildSliceId(namespace, result.id, chunk.sequence, hashSliceText(chunk.text)),
          source: result.source,
          text: chunk.text,
          score,
          token_estimate: chunk.token_estimate,
          metadata: input.include_sources
            ? {
              ...result.metadata,
              source_channels: result.channels ?? [],
              source_score: result.score ?? null,
              source_created_at: result.created_at ?? null,
            }
            : { ...(result.metadata ?? {}) },
          source_ref: sourceRef,
        };
      });
    }).sort((left, right) => right.score - left.score);

    const selected: SliceProjectionResult["slices"] = [];
    let totalTokens = 0;
    let usedSources = new Set<string>();

    const rankedCandidates = input.projection_mode === "broad"
      ? [...projectionCandidates].sort((left, right) => {
        const leftNovel = usedSources.has(left.source) ? 0 : 0.03;
        const rightNovel = usedSources.has(right.source) ? 0 : 0.03;
        return (right.score + rightNovel) - (left.score + leftNovel);
      })
      : projectionCandidates;

    for (const candidate of rankedCandidates) {
      if (selected.length >= input.max_slices) break;
      if (totalTokens > 0 && totalTokens + candidate.token_estimate > input.max_tokens) continue;
      selected.push(candidate);
      totalTokens += candidate.token_estimate;
      usedSources = new Set([...usedSources, candidate.source]);
    }

    return sliceProjectionResultSchema.parse({
      projection_id: crypto.randomUUID(),
      plan_id: input.plan_id ?? null,
      namespace,
      objective: input.objective,
      projection_mode: input.projection_mode,
      slices: selected,
      truncated: selected.length < projectionCandidates.length,
      total_estimated_tokens: totalTokens,
      generated_at: new Date().toISOString(),
    });
  }
}
