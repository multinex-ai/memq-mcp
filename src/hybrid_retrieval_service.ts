import type { AppConfig } from "./config.ts";
import {
  type HybridRetrieveInput,
  type HybridRetrieveResult,
  hybridRetrieveResultSchema,
  type MemoryFiltersInput,
  type MemoryRecord,
} from "./types.ts";
import { tokenizeText } from "./vector.ts";

type RuntimeRow = Record<string, unknown>;

type HybridRetrievalBackends = {
  embedQuery: (query: string) => number[];
  vectorSearch: (vector: number[], limit: number) => Promise<Array<MemoryRecord & { similarity: number }>>;
  graphSearch: (query: string, limit: number) => Promise<RuntimeRow[]>;
  hotSearch: (query: string, limit: number) => Promise<RuntimeRow[]>;
  journalSearch: (query: string, limit: number, filters?: MemoryFiltersInput) => Promise<RuntimeRow[]>;
  planStateSearch: (input: {
    query: string;
    plan_id: string | null;
    namespace?: string | null;
    limit: number;
  }) => Promise<RuntimeRow[]>;
};

type Candidate = {
  id: string;
  source: HybridRetrieveResult["results"][number]["source"];
  text: string;
  title?: string | null;
  score: number;
  created_at: string | null;
  metadata: Record<string, unknown>;
  channels: string[];
};

const DEFAULT_SOURCES = ["vector", "graph", "hot", "journal"] as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function recencyBonus(createdAt: string | null): number {
  if (!createdAt) return 0;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return 0;
  const hours = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));
  return clamp01(0.15 / (1 + hours / 24));
}

export function textQueryCoverageScore(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) {
    return 1;
  }

  const queryTerms = [...new Set(tokenizeText(query).filter((term) => term.length > 1))];
  if (queryTerms.length === 0) {
    return 0;
  }

  const matchedTerms = queryTerms.filter((term) => normalizedText.includes(term)).length;
  return matchedTerms / queryTerms.length;
}

function sourceWeight(
  source: Candidate["source"],
  strategy: HybridRetrieveInput["fusion_strategy"],
): number {
  const weights: Record<HybridRetrieveInput["fusion_strategy"], Record<Candidate["source"], number>> = {
    balanced: {
      plan_state: 1,
      hot: 1,
      journal: 0.92,
      graph: 1,
      vector: 1,
      temporal: 0.98,
    },
    memory_first: {
      plan_state: 0.9,
      hot: 1.15,
      journal: 1,
      graph: 1.08,
      vector: 1,
      temporal: 0.95,
    },
    plan_first: {
      plan_state: 1.2,
      hot: 0.95,
      journal: 0.9,
      graph: 0.95,
      vector: 0.95,
      temporal: 0.95,
    },
    temporal_first: {
      plan_state: 0.95,
      hot: 0.92,
      journal: 1,
      graph: 1.08,
      vector: 0.92,
      temporal: 1.2,
    },
  };

  return weights[strategy][source] ?? 1;
}

function normalizeFilters(filters?: MemoryFiltersInput): {
  agent_id?: string;
  memory_type?: string;
  task_id?: string | null;
  hasTaskIdFilter: boolean;
  tags?: Set<string>;
} | null {
  if (!filters) return null;
  return {
    agent_id: filters.agent_id,
    memory_type: filters.memory_type,
    task_id: filters.task_id ?? null,
    hasTaskIdFilter: Object.prototype.hasOwnProperty.call(filters, "task_id"),
    tags: filters.tags && filters.tags.length > 0 ? new Set(filters.tags) : undefined,
  };
}

function matchesFilters(
  row: { agent_id?: unknown; memory_type?: unknown; task_id?: unknown; tags?: unknown },
  filters: ReturnType<typeof normalizeFilters>,
): boolean {
  if (!filters) return true;
  if (filters.agent_id && String(row.agent_id ?? "") !== filters.agent_id) return false;
  if (filters.memory_type && String(row.memory_type ?? "") !== filters.memory_type) return false;
  if (filters.hasTaskIdFilter) {
    const taskId = row.task_id === null || row.task_id === undefined ? null : String(row.task_id);
    if (taskId !== filters.task_id) return false;
  }
  if (filters.tags) {
    const rowTags = new Set(Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : []);
    for (const tag of filters.tags) {
      if (!rowTags.has(tag)) return false;
    }
  }
  return true;
}

export class HybridRetrievalService {
  constructor(private readonly config: AppConfig, private readonly backends: HybridRetrievalBackends) {}

  async retrieve(input: HybridRetrieveInput): Promise<HybridRetrieveResult> {
    const namespace = input.namespace?.trim() || "default";
    const topK = input.top_k ?? this.config.TOP_K_DEFAULT;
    const sources = input.sources?.length
      ? [...new Set(input.sources)]
      : input.plan_id
      ? ["plan_state", ...DEFAULT_SOURCES]
      : [...DEFAULT_SOURCES];
    const filters = normalizeFilters(input.filters);

    const vectorPromise = sources.includes("vector")
      ? this.backends.vectorSearch(this.backends.embedQuery(input.query), Math.max(topK * 3, topK))
      : Promise.resolve([]);
    const graphPromise = sources.includes("graph")
      ? this.backends.graphSearch(input.query, Math.max(topK * 2, topK))
      : Promise.resolve([]);
    const hotPromise = sources.includes("hot")
      ? this.backends.hotSearch(input.query, Math.max(topK * 2, topK))
      : Promise.resolve([]);
    const journalPromise = sources.includes("journal")
      ? this.backends.journalSearch(input.query, Math.max(topK * 3, topK), input.filters)
      : Promise.resolve([]);
    const planStatePromise = sources.includes("plan_state")
      ? this.backends.planStateSearch({
        query: input.query,
        plan_id: input.plan_id ?? null,
        namespace,
        limit: Math.max(topK, 1),
      })
      : Promise.resolve([]);

    const [vectorRows, graphRows, hotRows, journalRows, planStateRows] = await Promise.all([
      vectorPromise,
      graphPromise,
      hotPromise,
      journalPromise,
      planStatePromise,
    ]);

    const candidates = new Map<string, Candidate>();
    const mergeCandidate = (candidate: Candidate) => {
      const existing = candidates.get(candidate.id);
      if (!existing) {
        candidates.set(candidate.id, candidate);
        return;
      }

      const previousScore = existing.score;
      existing.score = clamp01(Math.max(existing.score, candidate.score) + 0.04);
      existing.channels = [...new Set([...existing.channels, ...candidate.channels])];
      if (candidate.score > previousScore) {
        existing.source = candidate.source;
      }
      existing.metadata = {
        ...existing.metadata,
        ...candidate.metadata,
      };
    };

    for (const row of vectorRows) {
      if (!matchesFilters(row, filters)) continue;
      const score = clamp01(
        (row.similarity * 0.92 + recencyBonus(row.created_at)) * sourceWeight("vector", input.fusion_strategy),
      );
      mergeCandidate({
        id: row.id,
        source: "vector",
        text: row.text,
        title: null,
        score,
        created_at: row.created_at,
        metadata: {
          agent_id: row.agent_id,
          memory_type: row.memory_type,
          task_id: row.task_id,
          tags: row.tags,
          vector_similarity: row.similarity,
        },
        channels: ["vector"],
      });
    }

    for (const row of graphRows) {
      if (!matchesFilters(row, filters)) continue;
      const text = String(row.text ?? "");
      const score = clamp01(
        (0.42 + 0.48 * textQueryCoverageScore(input.query, text) + recencyBonus(String(row.created_at ?? ""))) *
          sourceWeight("graph", input.fusion_strategy),
      );
      mergeCandidate({
        id: String(row.id ?? crypto.randomUUID()),
        source: "graph",
        text,
        title: null,
        score,
        created_at: row.created_at ? String(row.created_at) : null,
        metadata: {
          agent_id: String(row.agent_id ?? "unknown"),
          memory_type: String(row.memory_type ?? "episodic"),
          task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
          tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
        },
        channels: ["graph"],
      });
    }

    for (const row of hotRows) {
      if (!matchesFilters(row, filters)) continue;
      const text = String(row.text ?? "");
      const score = clamp01(
        (0.5 + 0.42 * textQueryCoverageScore(input.query, text) + recencyBonus(String(row.created_at ?? ""))) *
          sourceWeight("hot", input.fusion_strategy),
      );
      mergeCandidate({
        id: String(row.id ?? crypto.randomUUID()),
        source: "hot",
        text,
        title: null,
        score,
        created_at: row.created_at ? String(row.created_at) : null,
        metadata: {
          agent_id: String(row.agent_id ?? "unknown"),
          memory_type: String(row.memory_type ?? "episodic"),
          task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
          tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
        },
        channels: ["hot"],
      });
    }

    for (const row of journalRows) {
      if (!matchesFilters(row, filters)) continue;
      const text = String(row.text ?? "");
      const score = clamp01(
        (0.38 + 0.45 * textQueryCoverageScore(input.query, text) + recencyBonus(String(row.created_at ?? ""))) *
          sourceWeight("journal", input.fusion_strategy),
      );
      mergeCandidate({
        id: String(row.id ?? crypto.randomUUID()),
        source: "journal",
        text,
        title: null,
        score,
        created_at: row.created_at ? String(row.created_at) : null,
        metadata: {
          agent_id: String(row.agent_id ?? "unknown"),
          memory_type: String(row.memory_type ?? "episodic"),
          task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
          tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
          content_hash: String(row.content_hash ?? ""),
        },
        channels: ["journal"],
      });
    }

    for (const row of planStateRows) {
      if (!matchesFilters(row, filters)) continue;
      const text = String(row.text ?? "");
      const score = clamp01(
        (0.54 + 0.4 * textQueryCoverageScore(input.query, text) + recencyBonus(String(row.created_at ?? ""))) *
          sourceWeight("plan_state", input.fusion_strategy),
      );
      mergeCandidate({
        id: String(row.id ?? crypto.randomUUID()),
        source: "plan_state",
        text,
        title: typeof row.title === "string" ? row.title : null,
        score,
        created_at: row.created_at ? String(row.created_at) : null,
        metadata: {
          plan_id: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
          namespace: typeof row.namespace === "string" ? row.namespace : namespace,
          status: typeof row.status === "string" ? row.status : "active",
          checkpoint_id: row.checkpoint_id === null || row.checkpoint_id === undefined
            ? null
            : String(row.checkpoint_id),
          thread_id: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
          state_version: typeof row.state_version === "number" ? row.state_version : null,
          tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
        },
        channels: ["plan_state"],
      });
    }

    const results = [...candidates.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        title: candidate.title ?? null,
        text: candidate.text,
        score: input.include_scores ? candidate.score : undefined,
        created_at: candidate.created_at,
        metadata: candidate.metadata,
        channels: candidate.channels,
      }));

    return hybridRetrieveResultSchema.parse({
      query: input.query,
      plan_id: input.plan_id ?? null,
      namespace,
      fusion_strategy: input.fusion_strategy,
      scanned_sources: sources,
      returned: results.length,
      results,
    });
  }
}
