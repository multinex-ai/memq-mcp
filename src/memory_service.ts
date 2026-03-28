import { AppConfig } from "./config.ts";
import { MNEMOSYNE_GATEWAY_RUNTIME_VERSION } from "./build_info.ts";
import { JournalWriter } from "./journal.ts";
import {
  bridgeSyncResultSchema,
  dualBrainContractToolDefinitions,
  MNEMOSYNE_PROTOCOL_VERSION,
  MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
  planStateCheckpointResultSchema,
  planStateResumeResultSchema,
  planStateSnapshotSchema,
  planStateWriteResultSchema,
  reflectionHandoffResultSchema,
  temporalGraphQueryResultSchema,
} from "./types.ts";
import type {
  AddMemoryInput,
  BridgeSyncInput,
  GetMemoryInput,
  HybridRetrieveInput,
  HybridRetrieveResult,
  MemoryFiltersInput,
  MemoryRecord,
  MemoryStatusInput,
  PlanStateCheckpointInput,
  PlanStateReadInput,
  PlanStateResumeInput,
  PlanStateStatus,
  PlanStateWriteInput,
  RecentMemoryInput,
  ReflectionHandoffInput,
  ReflectMemoryInput,
  SearchMemoryInput,
  SliceProjectionInput,
  SliceProjectionResult,
  TemporalGraphQueryInput,
} from "./types.ts";
import { computeTemporalSearchBonus, rankTemporalGraphRows } from "./temporal_graph.ts";
import { embedText, extractEntities, tokenizeText, topTermsFromTexts } from "./vector.ts";
import { hashContent, type Logger } from "./utils.ts";
import { QdrantAdapter } from "./adapters/qdrant.ts";
import { FalkorAdapter } from "./adapters/falkor.ts";
import { type AutoReflectPlan, QuantumEntropyClient } from "./quantum_entropy.ts";
import { type ReplayCandidate, type ReplaySelectionDiagnostics, selectReplayCandidates } from "./replay_policy.ts";
import { HybridRetrievalService, textQueryCoverageScore } from "./hybrid_retrieval_service.ts";
import { SliceService } from "./slice_service.ts";
import { GatewayToolError } from "./errors.ts";
import { PlanningClient } from "./planning_client.ts";

type SearchResultRow = {
  id: string;
  agent_id: string;
  memory_type: string;
  task_id: string | null;
  tags: string[];
  text: string;
  created_at: string;
  score: number;
  vector_similarity: number;
  channels: string[];
};

type RecentMemoryRow = Omit<SearchResultRow, "score" | "vector_similarity" | "channels">;

type NormalizedFilters = {
  agent_id?: string;
  memory_type?: string;
  task_id?: string | null;
  hasTaskIdFilter: boolean;
  tags?: Set<string>;
};

export class MemoryService {
  private readonly qdrant: QdrantAdapter;
  private readonly falkor: FalkorAdapter;
  private readonly journal: JournalWriter;
  private readonly entropy: QuantumEntropyClient;
  private readonly hybridRetrieval: HybridRetrievalService;
  private readonly sliceService: SliceService;
  private readonly planning: PlanningClient;
  private reflectLock: Promise<void> = Promise.resolve();
  private writesSinceLastReflection = 0;
  private autoReflectPending = false;
  private nextAutoReflectPlan: AutoReflectPlan | null = null;
  private lastReplayDiagnostics: ReplaySelectionDiagnostics | null = null;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.qdrant = new QdrantAdapter(config, logger);
    this.falkor = new FalkorAdapter(config, logger);
    this.journal = new JournalWriter(config.SOUL_JOURNAL_PATH);
    this.entropy = new QuantumEntropyClient(config, logger);
    this.planning = new PlanningClient(config);
    this.hybridRetrieval = new HybridRetrievalService(config, {
      embedQuery: (query) =>
        embedText(query, config.VECTOR_DIM, `${config.VECTOR_EMBED_PROVIDER}/${config.VECTOR_EMBED_MODEL}`),
      vectorSearch: (vector, limit) => this.qdrant.search(vector, limit),
      graphSearch: (query, limit) => this.falkor.graphSearch(query, limit).catch(() => []),
      hotSearch: (query, limit) => this.falkor.hotSearch(query, limit).catch(() => []),
      journalSearch: (query, limit, filters) => this.searchJournal(query, limit, filters),
      planStateSearch: (input) => this.searchPlanStateEntries(input),
    });
    this.sliceService = new SliceService(config, logger, {
      hybridRetriever: (input) => this.hybridRetrieve(input),
    });
  }

  async startup(): Promise<void> {
    await this.planning.init();
    await this.journal.init();
    await this.qdrant.init();
    await this.falkor.init();
    await this.sliceService.startup();
    this.logger.info("memory_service_initialized", {
      vector_dim: this.config.VECTOR_DIM,
      auto_reflect_every: this.config.AUTO_REFLECT_EVERY,
      dedup_threshold: this.config.SIMILARITY_DEDUP_THRESHOLD,
      quantum_entropy_mode: this.config.QUANTUM_ENTROPY_MODE,
      release_channel: this.config.RELEASE_CHANNEL,
    });

    this.nextAutoReflectPlan = this.fixedAutoReflectPlan();
    this.refreshAutoReflectPlan("startup");
  }

  async shutdown(): Promise<void> {
    await this.falkor.shutdown();
  }

  async health(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    try {
      await this.qdrant.health();
      out.qdrant = "ok";
    } catch {
      out.qdrant = "degraded";
    }

    try {
      await this.falkor.health();
      out.falkor = "ok";
    } catch {
      out.falkor = "degraded";
    }

    return out;
  }

  quantumStatus(): Record<string, unknown> {
    return this.entropy.status();
  }

  async addMemory(input: AddMemoryInput, metadata: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const textBytes = new TextEncoder().encode(input.text).byteLength;
    if (textBytes > this.config.MAX_MEMORY_TEXT_BYTES) {
      throw new Error(`text exceeds byte limit (${this.config.MAX_MEMORY_TEXT_BYTES})`);
    }

    const normalized = input.text.trim().replace(/\s+/g, " ").toLowerCase();
    const contentHash = await hashContent(normalized);

    const existing = await this.qdrant.findByContentHash(contentHash);
    if (existing) {
      await this.qdrant.incrementReinforcement(existing.id);
      await this.falkor.publishHotMemory({
        id: existing.id,
        agent_id: input.agent_id,
        text: input.text,
        created_at: new Date().toISOString(),
        memory_type: input.memory_type,
        task_id: input.task_id ?? null,
        tags: input.tags,
        deduped: true,
      });
      return {
        id: existing.id,
        deduped: true,
        reason: "exact_content_hash_match",
        reinforcement_count: existing.reinforcement_count + 1,
      };
    }

    const embedding = embedText(
      input.text,
      this.config.VECTOR_DIM,
      `${this.config.VECTOR_EMBED_PROVIDER}/${this.config.VECTOR_EMBED_MODEL}`,
    );
    const nearest = await this.qdrant.findNearest(embedding);
    if (nearest && nearest.similarity >= this.config.SIMILARITY_DEDUP_THRESHOLD) {
      await this.qdrant.incrementReinforcement(nearest.record.id);
      await this.falkor.publishHotMemory({
        id: nearest.record.id,
        agent_id: input.agent_id,
        text: input.text,
        created_at: new Date().toISOString(),
        memory_type: input.memory_type,
        task_id: input.task_id ?? null,
        tags: input.tags,
        deduped: true,
      });
      return {
        id: nearest.record.id,
        deduped: true,
        reason: "near_duplicate_similarity",
        similarity: nearest.similarity,
      };
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const record: MemoryRecord = {
      id,
      agent_id: input.agent_id,
      memory_type: input.memory_type,
      task_id: input.task_id ?? null,
      tags: input.tags,
      text: input.text,
      created_at: createdAt,
      content_hash: contentHash,
      reinforcement_count: 1,
      metadata,
      embedding,
    };

    await this.journal.append({
      schema_version: 2,
      id: record.id,
      agent_id: record.agent_id,
      memory_type: input.memory_type,
      task_id: record.task_id,
      tags: record.tags,
      text: record.text,
      content_hash: record.content_hash,
      metadata: {
        ...metadata,
        backend: {
          qdrant_collection: this.config.QDRANT_COLLECTION,
          falkor_graph: this.config.FALKOR_GRAPH,
        },
      },
      created_at: record.created_at,
    });

    const entities = extractEntities(input.text);

    await Promise.all([
      this.qdrant.upsertMemory(record),
      this.falkor.upsertMemory(record, entities),
      this.falkor.publishHotMemory({
        id: record.id,
        agent_id: record.agent_id,
        text: record.text,
        created_at: record.created_at,
        memory_type: record.memory_type,
        task_id: record.task_id,
        tags: record.tags,
        deduped: false,
      }),
    ]);

    if (this.config.AUTO_REFLECT_EVERY > 0 && input.memory_type !== "reflection") {
      this.maybeAutoReflect().catch((error) => {
        this.logger.warn("auto_reflect_schedule_failed", { error: String(error) });
      });
    }

    return {
      id: record.id,
      agent_id: record.agent_id,
      memory_type: record.memory_type,
      task_id: record.task_id,
      tags: record.tags,
      created_at: record.created_at,
      vector_dim: this.config.VECTOR_DIM,
      reflection_scheduled: this.config.AUTO_REFLECT_EVERY > 0,
    };
  }

  async searchMemory(input: SearchMemoryInput): Promise<Record<string, unknown>> {
    const queryBytes = new TextEncoder().encode(input.query).byteLength;
    if (queryBytes > this.config.MAX_QUERY_BYTES) {
      throw new Error(`query exceeds byte limit (${this.config.MAX_QUERY_BYTES})`);
    }

    const topK = input.top_k ?? this.config.TOP_K_DEFAULT;
    const queryVector = embedText(
      input.query,
      this.config.VECTOR_DIM,
      `${this.config.VECTOR_EMBED_PROVIDER}/${this.config.VECTOR_EMBED_MODEL}`,
    );

    const [vectorRows, graphRows, hotRows] = await Promise.all([
      this.qdrant.search(queryVector, Math.max(topK * 3, topK)),
      this.falkor.graphSearch(input.query, Math.max(topK * 2, topK)).catch(() => []),
      this.falkor.hotSearch(input.query, Math.max(topK * 2, topK)).catch(() => []),
    ]);

    const normalizedFilters = this.normalizeFilters(input.filters);
    const merged = new Map<string, SearchResultRow>();
    let temporalHits = 0;

    for (const row of vectorRows) {
      const recencyBonus = 0.03;
      const reinforcementBonus = Math.min(0.1, 0.01 * row.reinforcement_count);
      const temporalBonus = computeTemporalSearchBonus(row.metadata, row.created_at, input.query);
      const channels = temporalBonus.hasTemporalFacts ? ["vector", "temporal"] : ["vector"];
      if (temporalBonus.hasTemporalFacts) temporalHits += 1;
      merged.set(row.id, {
        id: row.id,
        agent_id: row.agent_id,
        memory_type: row.memory_type,
        task_id: row.task_id,
        tags: row.tags,
        text: row.text,
        created_at: row.created_at,
        score: row.similarity + recencyBonus + reinforcementBonus + temporalBonus.bonus,
        vector_similarity: row.similarity,
        channels,
      });
    }

    for (const row of graphRows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      if (merged.has(id)) {
        const existing = merged.get(id)!;
        existing.score = Number(existing.score ?? 0) + 0.18;
        const channels = existing.channels as string[];
        if (!channels.includes("graph")) channels.push("graph");
      } else {
        merged.set(id, {
          id,
          agent_id: String(row.agent_id ?? "unknown"),
          memory_type: String(row.memory_type ?? "episodic"),
          task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
          tags: Array.isArray(row.tags) ? row.tags.map((v) => String(v)) : [],
          text: String(row.text ?? ""),
          created_at: String(row.created_at ?? ""),
          score: 0.4,
          vector_similarity: 0,
          channels: ["graph"],
        });
      }
    }

    for (const row of hotRows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      if (merged.has(id)) {
        const existing = merged.get(id)!;
        existing.score = Number(existing.score ?? 0) + 0.25;
        const channels = existing.channels as string[];
        if (!channels.includes("hot")) channels.push("hot");
      } else {
        merged.set(id, {
          id,
          agent_id: String(row.agent_id ?? "unknown"),
          memory_type: String(row.memory_type ?? "episodic"),
          task_id: null,
          tags: [],
          text: String(row.text ?? ""),
          created_at: String(row.created_at ?? ""),
          score: 0.35,
          vector_similarity: 0,
          channels: ["hot"],
        });
      }
    }

    const filtered = [...merged.values()]
      .filter((row) => this.matchesFilters(row, normalizedFilters));

    const ranked = this.selectTopK(filtered, topK);

    return {
      query: input.query,
      results: ranked,
      channels: {
        vector_hits: vectorRows.length,
        graph_hits: graphRows.length,
        hot_hits: hotRows.length,
        temporal_hits: temporalHits,
      },
    };
  }

  async planStateRead(input: PlanStateReadInput): Promise<Record<string, unknown>> {
    const snapshot = await this.planning.readSnapshot(input);
    return planStateSnapshotSchema.parse(snapshot);
  }

  async planStateWrite(input: PlanStateWriteInput): Promise<Record<string, unknown>> {
    const result = await this.planning.writeState(input);
    return planStateWriteResultSchema.parse(result);
  }

  async planStateCheckpoint(input: PlanStateCheckpointInput): Promise<Record<string, unknown>> {
    const result = await this.planning.createCheckpoint(input);
    try {
      await this.addMemory({
        text: this.truncateText(
          `[plan_checkpoint:${result.checkpoint_id}] ${
            input.summary ?? `Checkpointed ${input.plan_id} in ${result.namespace}.`
          }`,
        ),
        agent_id: "planner",
        memory_type: "checkpoint",
        task_id: input.plan_id,
        tags: ["plan_state", "checkpoint", result.namespace],
      }, {
        kind: "plan_state_checkpoint",
        plan_id: input.plan_id,
        namespace: result.namespace,
        checkpoint_id: result.checkpoint_id,
        state_version: result.state_version,
        status: result.status,
      });
    } catch (error) {
      this.logger.warn("plan_state_checkpoint_memory_write_failed", { error: String(error), plan_id: input.plan_id });
    }
    return planStateCheckpointResultSchema.parse(result);
  }

  async planStateResume(input: PlanStateResumeInput): Promise<Record<string, unknown>> {
    const result = await this.planning.resume(input);
    return planStateResumeResultSchema.parse(result);
  }

  private composeBridgeMetadata(
    systemMetadata: Record<string, unknown>,
    providedMetadata: Record<string, unknown>,
  ): Record<string, unknown> {
    if (Object.keys(providedMetadata).length === 0) {
      return systemMetadata;
    }

    return {
      ...providedMetadata,
      ...systemMetadata,
      caller_metadata: providedMetadata,
    };
  }

  async bridgeSync(input: BridgeSyncInput): Promise<Record<string, unknown>> {
    const namespace = this.planning.resolveNamespace(input.namespace);
    const syncId = crypto.randomUUID();
    const recordedAt = new Date().toISOString();
    const acceptedMemoryWriteIds = await this.filterExistingMemoryIds(input.memory_write_ids);

    await this.planning.writeState({
      plan_id: input.plan_id,
      namespace,
      status: this.bridgeSyncStatus(input.phase, input.outcome),
      summary: input.summary,
      state_patch: {
        ...input.state_delta,
        bridge: {
          last_sync_id: syncId,
          last_phase: input.phase,
          last_outcome: input.outcome,
          last_execution_id: input.execution_id ?? null,
          last_recorded_at: recordedAt,
          accepted_memory_write_ids: acceptedMemoryWriteIds,
        },
      },
      metadata: {
        bridge_sync: {
          sync_id: syncId,
          phase: input.phase,
          outcome: input.outcome,
          recorded_at: recordedAt,
        },
        ...input.metadata,
      },
      tags: ["bridge_sync", input.phase, input.outcome, ...input.tags],
    });

    const syncMemoryType = this.bridgeSyncMemoryType(input.phase, input.outcome);
    await this.addMemory(
      {
        text: this.truncateText(
          `[bridge_sync:${syncId}] ${input.summary} (plan=${input.plan_id}, phase=${input.phase}, outcome=${input.outcome})`,
        ),
        agent_id: "bridge",
        memory_type: syncMemoryType,
        task_id: input.plan_id,
        tags: ["bridge_sync", input.phase, input.outcome, ...input.tags],
      },
      this.composeBridgeMetadata({
        kind: "bridge_sync",
        sync_id: syncId,
        plan_id: input.plan_id,
        namespace,
        phase: input.phase,
        outcome: input.outcome,
        execution_id: input.execution_id ?? null,
        state_delta: input.state_delta,
        accepted_memory_write_ids: acceptedMemoryWriteIds,
        request_checkpoint: input.request_checkpoint,
        request_reflection_handoff: input.request_reflection_handoff,
      }, input.metadata),
    );

    let checkpointId: string | null = null;
    if (input.request_checkpoint) {
      const checkpoint = await this.planning.createCheckpoint({
        plan_id: input.plan_id,
        namespace,
        summary: input.summary,
        include_state: true,
        metadata: {
          bridge_sync: {
            sync_id: syncId,
            phase: input.phase,
            outcome: input.outcome,
          },
        },
      });
      checkpointId = String(checkpoint.checkpoint_id);
    }

    if (input.request_reflection_handoff) {
      await this.reflectionHandoff({
        plan_id: input.plan_id,
        namespace,
        checkpoint_id: checkpointId,
        session_id: input.execution_id ?? null,
        summary: input.summary,
        source_memory_ids: acceptedMemoryWriteIds,
        tags: ["bridge_sync", input.phase, input.outcome, ...input.tags],
        force: input.phase === "reflection",
        metadata: {
          bridge_sync: {
            sync_id: syncId,
            phase: input.phase,
            outcome: input.outcome,
          },
          ...input.metadata,
        },
      });
    }

    return bridgeSyncResultSchema.parse({
      sync_id: syncId,
      plan_id: input.plan_id,
      namespace,
      phase: input.phase,
      outcome: input.outcome,
      accepted_memory_write_ids: acceptedMemoryWriteIds.length,
      checkpoint_requested: input.request_checkpoint,
      reflection_handoff_requested: input.request_reflection_handoff,
      recorded_at: recordedAt,
    });
  }

  async reflectionHandoff(input: ReflectionHandoffInput): Promise<Record<string, unknown>> {
    const namespace = this.planning.resolveNamespace(input.namespace);
    const handoffId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const acceptedSourceIds = await this.filterExistingMemoryIds(input.source_memory_ids);

    let planStatus: PlanStateStatus | null = null;
    if (input.plan_id) {
      const snapshot = await this.planning.readSnapshot({
        plan_id: input.plan_id,
        namespace,
        checkpoint_id: input.checkpoint_id ?? undefined,
        include_messages: false,
        include_artifacts: false,
      }).catch((error) => {
        if (error instanceof GatewayToolError && error.code === "plan_state_not_found") {
          return null;
        }
        throw error;
      });
      planStatus = snapshot?.status ?? null;
    }

    await this.addMemory(
      {
        text: this.truncateText(
          `[reflection_handoff:${handoffId}] ${input.summary}${
            input.plan_id ? ` (plan=${input.plan_id}${planStatus ? `, status=${planStatus}` : ""})` : ""
          }`,
        ),
        agent_id: "bridge",
        memory_type: "hybrid",
        task_id: input.plan_id ?? input.session_id ?? null,
        tags: ["reflection_handoff", ...input.tags],
      },
      this.composeBridgeMetadata({
        kind: "reflection_handoff",
        handoff_id: handoffId,
        plan_id: input.plan_id ?? null,
        namespace,
        checkpoint_id: input.checkpoint_id ?? null,
        session_id: input.session_id ?? null,
        source_memory_ids: acceptedSourceIds,
      }, input.metadata),
    );

    if (input.plan_id) {
      await this.planning.writeState({
        plan_id: input.plan_id,
        namespace,
        status: input.checkpoint_id ? "checkpointed" : undefined,
        state_patch: {
          bridge: {
            last_reflection_handoff_id: handoffId,
            last_reflection_handoff_at: createdAt,
            last_reflection_checkpoint_id: input.checkpoint_id ?? null,
            accepted_source_ids: acceptedSourceIds,
          },
        },
        metadata: {
          reflection_handoff: {
            handoff_id: handoffId,
            session_id: input.session_id ?? null,
          },
          ...input.metadata,
        },
        tags: ["reflection_handoff", ...input.tags],
      });
    }

    if (input.force) {
      await this.reflectMemory({
        window: Math.max(10, Math.min(50, acceptedSourceIds.length > 0 ? acceptedSourceIds.length * 5 : 25)),
        force: true,
        session_id: input.session_id ?? undefined,
      });
    }

    return reflectionHandoffResultSchema.parse({
      handoff_id: handoffId,
      plan_id: input.plan_id ?? null,
      checkpoint_id: input.checkpoint_id ?? null,
      session_id: input.session_id ?? null,
      accepted_source_count: acceptedSourceIds.length,
      scheduled: input.force || this.config.AUTO_REFLECT_EVERY > 0,
      created_at: createdAt,
    });
  }

  async temporalGraphQuery(input: TemporalGraphQueryInput): Promise<Record<string, unknown>> {
    const queryBytes = new TextEncoder().encode(input.query).byteLength;
    if (queryBytes > this.config.MAX_QUERY_BYTES) {
      throw new Error(`query exceeds byte limit (${this.config.MAX_QUERY_BYTES})`);
    }

    const scanLimit = Math.min(300, Math.max(input.limit * 3, input.limit));
    const rows = await this.falkor.temporalGraphQuery(input, scanLimit);
    const results = rankTemporalGraphRows(rows, input);

    return temporalGraphQueryResultSchema.parse({
      query: input.query,
      plan_id: input.plan_id ?? null,
      returned: results.length,
      results,
    });
  }

  async getMemory(input: GetMemoryInput): Promise<Record<string, unknown>> {
    const record = await this.qdrant.findById(input.id);
    if (!record) {
      throw new Error(`memory not found: ${input.id}`);
    }

    return {
      memory: {
        id: record.id,
        agent_id: record.agent_id,
        memory_type: record.memory_type,
        task_id: record.task_id,
        tags: record.tags,
        text: record.text,
        created_at: record.created_at,
        content_hash: record.content_hash,
        reinforcement_count: record.reinforcement_count,
        metadata: record.metadata,
        embedding_dim: record.embedding.length,
      },
    };
  }

  async recentMemory(input: RecentMemoryInput): Promise<Record<string, unknown>> {
    const scanLimit = Math.min(Math.max(input.limit * 5, input.limit), 500);
    const rows = await this.falkor.listRecent(scanLimit);
    const normalizedFilters = this.normalizeFilters(input.filters);
    const results: RecentMemoryRow[] = [];

    for (const row of rows) {
      const candidate: RecentMemoryRow = {
        id: String(row.id ?? ""),
        agent_id: String(row.agent_id ?? "unknown"),
        memory_type: String(row.memory_type ?? "episodic"),
        task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
        tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
        text: String(row.text ?? ""),
        created_at: String(row.created_at ?? ""),
      };

      if (candidate.id.length === 0) continue;
      if (!this.matchesFilters(candidate, normalizedFilters)) continue;

      results.push(candidate);
      if (results.length >= input.limit) break;
    }

    return {
      results,
      scanned: rows.length,
      returned: results.length,
    };
  }

  async hybridRetrieve(input: HybridRetrieveInput): Promise<HybridRetrieveResult> {
    return await this.hybridRetrieval.retrieve(input);
  }

  async sliceProjection(input: SliceProjectionInput): Promise<SliceProjectionResult> {
    return await this.sliceService.project(input);
  }

  async memoryStatus(_input: MemoryStatusInput): Promise<Record<string, unknown>> {
    const health = await this.health();
    const allHealthy = Object.values(health).every((value) => value === "ok");
    const entropy = this.entropy.status();
    const plan = this.nextAutoReflectPlan ?? this.fixedAutoReflectPlan();
    const declaredContractTools = dualBrainContractToolDefinitions.map((tool) => ({
      name: tool.name,
      capability: tool.capability,
      mode: this.config.DUAL_BRAIN_CONTRACT_TOOLS[tool.capability],
    }));

    return {
      status: allHealthy ? "ok" : "degraded",
      backends: health,
      service: "mnemosyne",
      server_version: MNEMOSYNE_GATEWAY_RUNTIME_VERSION,
      protocol_version: MNEMOSYNE_PROTOCOL_VERSION,
      require_auth: this.config.REQUIRE_AUTH,
      release_channel: this.config.RELEASE_CHANNEL,
      rollout_contract: {
        version: MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
        docs_path: "products/munx-memorystack/docs/AGENT_MEMORY_PROTOCOL.md#stable-rollout-contract",
        declared_tools: declaredContractTools,
        exposed_tools: declaredContractTools.filter((tool) => tool.mode !== "off").map((tool) => tool.name),
        capabilities: this.config.DUAL_BRAIN_CONTRACT_TOOLS,
      },
      config: {
        vector_dim: this.config.VECTOR_DIM,
        vector_profiles: this.config.VECTOR_PROFILES,
        auto_reflect_every: this.config.AUTO_REFLECT_EVERY,
        replay_selection_mode: this.config.REPLAY_SELECTION_MODE,
        replay_max_sources: this.config.REPLAY_MAX_SOURCES,
        replay_tie_epsilon: this.config.REPLAY_TIE_EPSILON,
        top_k_default: this.config.TOP_K_DEFAULT,
        similarity_dedup_threshold: this.config.SIMILARITY_DEDUP_THRESHOLD,
        max_memory_text_bytes: this.config.MAX_MEMORY_TEXT_BYTES,
        max_query_bytes: this.config.MAX_QUERY_BYTES,
        max_sse_connections: this.config.MAX_SSE_CONNECTIONS,
        quantum_reflect_jitter_pct: this.config.QUANTUM_REFLECT_JITTER_PCT,
      },
      tiers: {
        hot: "falkordb",
        semantic: "qdrant",
        journal: this.config.SOUL_JOURNAL_PATH,
      },
      vector_topology: this.qdrant.status(),
      graph_topology: this.falkor.status(),
      slice_runtime: this.sliceService.status(),
      quantum_entropy: entropy,
      auto_reflection: {
        strategy: plan.strategy,
        cadence: plan.cadence,
        current_threshold: plan.threshold,
        writes_since_last_reflection: this.writesSinceLastReflection,
        writes_until_next_reflection: Math.max(0, plan.threshold - this.writesSinceLastReflection),
        pending: this.autoReflectPending,
      },
      replay_policy: {
        mode: this.config.REPLAY_SELECTION_MODE,
        max_sources: this.config.REPLAY_MAX_SOURCES,
        tie_epsilon: this.config.REPLAY_TIE_EPSILON,
        last_selection: this.lastReplayDiagnostics,
      },
    };
  }

  async reflectMemory(
    input: ReflectMemoryInput,
    options?: {
      trigger?: "manual" | "auto_fixed" | "auto_quantum";
      autoReflectPlan?: AutoReflectPlan | null;
    },
  ): Promise<Record<string, unknown>> {
    await this.reflectLock;
    let release: () => void = () => undefined;
    this.reflectLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const rows = await this.falkor.listRecent(input.window);
      if (rows.length < 8 && !input.force) {
        return {
          status: "skipped",
          reason: "insufficient_context",
          window: rows.length,
        };
      }

      const replayCandidates = rows.map((row) => this.toReplayCandidate(row));
      const quantumSample = this.config.REPLAY_SELECTION_MODE === "priority_quantum"
        ? await this.entropy.sampleDecisionEntropy()
        : null;
      const replaySelection = selectReplayCandidates(replayCandidates, {
        mode: this.config.REPLAY_SELECTION_MODE,
        maxSources: Math.min(this.config.REPLAY_MAX_SOURCES, Math.max(1, input.window)),
        tieEpsilon: this.config.REPLAY_TIE_EPSILON,
        quantumSample,
      });
      this.lastReplayDiagnostics = replaySelection.diagnostics;

      const selectedRows = replaySelection.selected;
      const sourceIds = selectedRows.map((row) => row.id);
      const texts = selectedRows.map((row) => row.text);

      const agentCounts = new Map<string, number>();
      for (const row of selectedRows) {
        const agentId = String(row.agent_id ?? "unknown");
        agentCounts.set(agentId, (agentCounts.get(agentId) ?? 0) + 1);
      }
      const topTerms = topTermsFromTexts(texts, 10);
      const topAgents = [...agentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, c]) => `${a}:${c}`);
      const reflectionSignals = this.extractReflectionSignals(selectedRows);
      const plan = options?.autoReflectPlan ?? null;
      const entropyMetadata = plan?.sample
        ? {
          strategy: plan.strategy,
          provider: plan.sample.provider,
          source: plan.sample.source,
          unit_interval: plan.sample.unit_interval,
          sampled_at: plan.sample.acquired_at,
          jitter_offset: plan.jitter_offset,
          jitter_range: plan.jitter_range,
          threshold: plan.threshold,
          raw_hex: plan.sample.raw_hex,
        }
        : null;

      const summarySegments = [
        `Reflection checkpoint: evaluated ${rows.length} recent memories and selected ${selectedRows.length} for consolidation using ${replaySelection.diagnostics.strategy}.`,
        `Dominant themes: ${topTerms.length ? topTerms.join(", ") : "none"}.`,
        `Primary contributors: ${topAgents.length ? topAgents.join(", ") : "none"}.`,
      ];
      if (reflectionSignals.failurePatterns.length > 0) {
        summarySegments.push(`Failure patterns: ${reflectionSignals.failurePatterns.join("; ")}.`);
      }
      if (reflectionSignals.procedures.length > 0) {
        summarySegments.push(`Procedural carry-forward: ${reflectionSignals.procedures.join("; ")}.`);
      }
      if (reflectionSignals.constraints.length > 0) {
        summarySegments.push(`Operating constraints: ${reflectionSignals.constraints.join("; ")}.`);
      }
      if (entropyMetadata) {
        summarySegments.push(
          `Quantum-seeded consolidation active via ${entropyMetadata.provider} (u=${
            entropyMetadata.unit_interval.toFixed(6)
          }, offset=${entropyMetadata.jitter_offset >= 0 ? "+" : ""}${entropyMetadata.jitter_offset}).`,
        );
      }
      const summary = summarySegments.join(" ");

      const reflection = await this.addMemory({
        text: summary,
        agent_id: "mnemon",
        memory_type: "reflection",
        task_id: null,
        tags: entropyMetadata
          ? ["reflection", "learning", "checkpoint", "quantum"]
          : ["reflection", "learning", "checkpoint"],
      }, {
        kind: options?.trigger === "manual" ? "manual_reflection" : "automatic_reflection",
        source_ids: sourceIds,
        replay_selection: replaySelection.diagnostics,
        top_terms: topTerms,
        agent_counts: Object.fromEntries(agentCounts.entries()),
        window: rows.length,
        consolidated_count: selectedRows.length,
        failure_patterns: reflectionSignals.failurePatterns,
        procedural_cues: reflectionSignals.procedures,
        operating_constraints: reflectionSignals.constraints,
        session_id: input.session_id ?? null,
        trigger: options?.trigger ?? "manual",
        quantum_entropy: entropyMetadata,
      });

      await this.falkor.linkReflection(String(reflection.id), sourceIds);

      return {
        status: "created",
        reflection_id: reflection.id,
        window: rows.length,
        consolidated_count: selectedRows.length,
        top_terms: topTerms,
        trigger: options?.trigger ?? "manual",
        quantum_entropy: entropyMetadata,
        replay_selection: replaySelection.diagnostics,
      };
    } finally {
      release();
    }
  }

  private async maybeAutoReflect(): Promise<void> {
    if (this.config.AUTO_REFLECT_EVERY <= 0) return;

    this.writesSinceLastReflection += 1;

    if (!this.nextAutoReflectPlan) {
      this.nextAutoReflectPlan = this.fixedAutoReflectPlan();
      this.refreshAutoReflectPlan("lazy_boot");
    }

    if (this.writesSinceLastReflection < this.nextAutoReflectPlan.threshold || this.autoReflectPending) {
      return;
    }

    const plan = this.nextAutoReflectPlan;
    this.autoReflectPending = true;

    try {
      const result = await this.reflectMemory({
        window: Math.min(Math.max(this.config.AUTO_REFLECT_EVERY, 20), 200),
        force: true,
      }, {
        trigger: plan.strategy === "quantum" ? "auto_quantum" : "auto_fixed",
        autoReflectPlan: plan,
      });

      this.logger.info("auto_reflection_completed", {
        trigger: plan.strategy,
        threshold: plan.threshold,
        reflection_id: result.reflection_id ?? null,
      });
    } catch (error) {
      this.logger.warn("auto_reflect_failed", { error: String(error) });
    } finally {
      this.writesSinceLastReflection = 0;
      this.nextAutoReflectPlan = this.fixedAutoReflectPlan();
      this.refreshAutoReflectPlan("post_reflection");
      this.autoReflectPending = false;
    }
  }

  private fixedAutoReflectPlan(): AutoReflectPlan {
    return {
      strategy: "fixed",
      cadence: this.config.AUTO_REFLECT_EVERY,
      threshold: this.config.AUTO_REFLECT_EVERY,
      jitter_offset: 0,
      jitter_range: 0,
      sample: null,
    };
  }

  private refreshAutoReflectPlan(reason: "startup" | "lazy_boot" | "post_reflection"): void {
    if (this.config.AUTO_REFLECT_EVERY <= 0) return;

    this.entropy.planReflectThreshold(this.config.AUTO_REFLECT_EVERY)
      .then((plan) => {
        this.nextAutoReflectPlan = plan;
        this.logger.info("auto_reflect_plan_updated", {
          reason,
          strategy: plan.strategy,
          threshold: plan.threshold,
          cadence: plan.cadence,
        });
      })
      .catch((error) => {
        this.logger.warn("auto_reflect_plan_update_failed", { reason, error: String(error) });
      });
  }

  private toReplayCandidate(row: Record<string, unknown>): ReplayCandidate {
    return {
      id: String(row.id ?? ""),
      agent_id: String(row.agent_id ?? "unknown"),
      memory_type: String(row.memory_type ?? "episodic"),
      task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      tags: Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : [],
      text: String(row.text ?? ""),
      created_at: String(row.created_at ?? ""),
    };
  }

  private extractReflectionSignals(rows: Array<{ text: string; tags: string[] }>): {
    failurePatterns: string[];
    procedures: string[];
    constraints: string[];
  } {
    const failurePatterns = new Set<string>();
    const procedures = new Set<string>();
    const constraints = new Set<string>();

    for (const row of rows) {
      const sentences = row.text
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
      const loweredTags = new Set(row.tags.map((tag) => tag.toLowerCase()));

      for (const sentence of sentences) {
        const lowered = sentence.toLowerCase();
        if (/(fail(?:ed|ure)?|error|bug|incident|regression|broken|degraded|timeout|exception)/i.test(lowered)) {
          failurePatterns.add(this.clampSignalSentence(sentence));
        }
        if (
          loweredTags.has("protocol") ||
          loweredTags.has("procedure") ||
          loweredTags.has("procedural") ||
          /\b(should|must|never|always|step|call|run|pin|use)\b/i.test(lowered)
        ) {
          procedures.add(this.clampSignalSentence(sentence));
        }
        if (
          loweredTags.has("constraint") ||
          loweredTags.has("guardrail") ||
          /\b(cannot|must not|only|require|forbidden|boundary|auth|limit)\b/i.test(lowered)
        ) {
          constraints.add(this.clampSignalSentence(sentence));
        }
      }
    }

    return {
      failurePatterns: [...failurePatterns].slice(0, 3),
      procedures: [...procedures].slice(0, 3),
      constraints: [...constraints].slice(0, 3),
    };
  }

  private clampSignalSentence(sentence: string): string {
    const normalized = sentence.trim().replace(/\s+/g, " ");
    return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
  }

  private async searchJournal(
    query: string,
    limit: number,
    filters?: MemoryFiltersInput,
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedFilters = this.normalizeFilters(filters);
    const scored: Array<Record<string, unknown> & { _score: number }> = [];

    await this.journal.streamEntries(async (entry) => {
      if (!this.matchesFilters(entry, normalizedFilters)) {
        return;
      }

      const text = String(entry.text ?? "");
      const score = this.scoreTextMatch(query, text);
      if (score <= 0) {
        return;
      }

      scored.push({
        ...entry,
        _score: score,
      });
    });

    return scored
      .sort((left, right) => {
        if (right._score !== left._score) {
          return right._score - left._score;
        }
        return String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
      })
      .slice(0, limit)
      .map(({ _score, ...entry }) => entry);
  }

  private scoreTextMatch(query: string, text: string): number {
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
      return textQueryCoverageScore(query, text);
    }

    const matchedTerms = queryTerms.filter((term) => normalizedText.includes(term)).length;
    return matchedTerms / queryTerms.length;
  }

  private async searchPlanStateEntries(input: {
    query: string;
    plan_id: string | null;
    namespace?: string | null;
    limit: number;
  }): Promise<Array<Record<string, unknown>>> {
    if (!input.plan_id) {
      return [];
    }

    const namespace = this.planning.resolveNamespace(input.namespace ?? undefined);
    const snapshot = await this.planning.readSnapshot({
      plan_id: input.plan_id,
      namespace,
      include_messages: true,
      include_artifacts: true,
    }).catch((error) => {
      if (error instanceof GatewayToolError && error.code === "plan_state_not_found") {
        return null;
      }
      throw error;
    });

    if (!snapshot) {
      return [];
    }

    const text = this.truncateText(
      [
        snapshot.summary ?? `Plan ${snapshot.plan_id}`,
        `status=${snapshot.status}`,
        `version=${snapshot.state_version ?? 0}`,
        JSON.stringify(snapshot.state),
        snapshot.messages?.length ? JSON.stringify(snapshot.messages.slice(0, 8)) : "",
        snapshot.artifacts?.length ? JSON.stringify(snapshot.artifacts.slice(0, 8)) : "",
      ].filter(Boolean).join("\n"),
    );

    return [{
      id: snapshot.checkpoint_id ?? snapshot.plan_id,
      plan_id: snapshot.plan_id,
      namespace,
      status: snapshot.status,
      checkpoint_id: snapshot.checkpoint_id,
      thread_id: snapshot.thread_id,
      state_version: snapshot.state_version,
      title: snapshot.summary ?? `Plan ${snapshot.plan_id}`,
      text,
      created_at: snapshot.updated_at,
      task_id: snapshot.plan_id,
      tags: ["plan_state", snapshot.status],
    }].slice(0, Math.max(1, input.limit));
  }

  private async filterExistingMemoryIds(ids: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(ids)];
    const rows = await Promise.all(
      uniqueIds.map(async (id) => ({ id, exists: Boolean(await this.qdrant.findById(id)) })),
    );
    return rows.filter((row) => row.exists).map((row) => row.id);
  }

  private truncateText(text: string, maxLength = 12000): string {
    const normalized = text.trim().replace(/\s+/g, " ");
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
  }

  private bridgeSyncStatus(
    phase: BridgeSyncInput["phase"],
    outcome: BridgeSyncInput["outcome"],
  ): PlanStateStatus {
    if (outcome === "failure") return "failed";
    if (outcome === "cancelled") return "cancelled";
    if (phase === "checkpoint") return "checkpointed";
    return "active";
  }

  private bridgeSyncMemoryType(
    phase: BridgeSyncInput["phase"],
    outcome: BridgeSyncInput["outcome"],
  ): AddMemoryInput["memory_type"] {
    if (outcome === "failure") return "episodic";
    if (phase === "checkpoint") return "checkpoint";
    return "hybrid";
  }

  private normalizeFilters(filters?: MemoryFiltersInput): NormalizedFilters | null {
    if (!filters) return null;
    return {
      agent_id: filters.agent_id,
      memory_type: filters.memory_type,
      task_id: filters.task_id ?? null,
      hasTaskIdFilter: Object.prototype.hasOwnProperty.call(filters, "task_id"),
      tags: filters.tags && filters.tags.length > 0 ? new Set(filters.tags) : undefined,
    };
  }

  private matchesFilters(
    row: {
      agent_id?: unknown;
      memory_type?: unknown;
      task_id?: unknown;
      tags?: unknown;
    },
    filters: NormalizedFilters | null,
  ): boolean {
    if (!filters) return true;

    if (filters.agent_id && String(row.agent_id ?? "") !== filters.agent_id) {
      return false;
    }

    if (filters.memory_type && String(row.memory_type ?? "") !== filters.memory_type) {
      return false;
    }

    if (filters.hasTaskIdFilter) {
      const taskId = row.task_id === null || row.task_id === undefined ? null : String(row.task_id);
      if (taskId !== filters.task_id) {
        return false;
      }
    }

    if (filters.tags) {
      const tagSet = new Set(Array.isArray(row.tags) ? row.tags.map((value) => String(value)) : []);
      for (const tag of filters.tags) {
        if (!tagSet.has(tag)) {
          return false;
        }
      }
    }

    return true;
  }

  private selectTopK(rows: SearchResultRow[], topK: number): SearchResultRow[] {
    if (rows.length <= topK) {
      return rows.sort((a, b) => b.score - a.score);
    }

    const heap: SearchResultRow[] = [];
    for (const row of rows) {
      if (heap.length < topK) {
        heap.push(row);
        this.bubbleUpMinHeap(heap, heap.length - 1);
        continue;
      }

      if (row.score <= heap[0].score) continue;
      heap[0] = row;
      this.bubbleDownMinHeap(heap, 0);
    }

    return heap.sort((a, b) => b.score - a.score);
  }

  private bubbleUpMinHeap(heap: SearchResultRow[], index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (heap[parent].score <= heap[current].score) break;
      [heap[parent], heap[current]] = [heap[current], heap[parent]];
      current = parent;
    }
  }

  private bubbleDownMinHeap(heap: SearchResultRow[], index: number): void {
    let current = index;

    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;

      if (left < heap.length && heap[left].score < heap[smallest].score) {
        smallest = left;
      }

      if (right < heap.length && heap[right].score < heap[smallest].score) {
        smallest = right;
      }

      if (smallest === current) break;
      [heap[current], heap[smallest]] = [heap[smallest], heap[current]];
      current = smallest;
    }
  }
}
