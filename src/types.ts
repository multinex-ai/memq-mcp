import { z } from "zod";

export const MNEMOSYNE_PROTOCOL_VERSION = "2025-03-26";
export const MNEMOSYNE_ROLLOUT_CONTRACT_VERSION = "2026-03-17";

const identifierSchema = z.string().trim().min(1).max(256);
const namespaceSchema = z.string().trim().min(1).max(128);
const relationTypeSchema = z.string().trim().min(1).max(128);
const tagSchema = z.string().trim().min(1).max(64);
const isoTimestampSchema = z.string().datetime({ offset: true });
const summarySchema = z.string().trim().min(1).max(4000);
const metadataSchema = z.record(z.unknown());

export const releaseContractToolModeSchema = z.enum(["off", "stub", "live"]);

export const dualBrainContractToolModesSchema = z.object({
  plan_state: releaseContractToolModeSchema,
  slice_projection: releaseContractToolModeSchema,
  hybrid_retrieval: releaseContractToolModeSchema,
  bridge_sync: releaseContractToolModeSchema,
  reflection_handoff: releaseContractToolModeSchema,
  temporal_graph: releaseContractToolModeSchema,
});

export type ReleaseContractToolMode = z.infer<typeof releaseContractToolModeSchema>;
export type DualBrainContractToolModes = z.infer<typeof dualBrainContractToolModesSchema>;
export type ContractToolCapability = keyof DualBrainContractToolModes;

export const MemoryTypeEnum = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "checkpoint",
  "hybrid",
  "reflection",
]);

export const addMemoryWriteInputSchema = z.object({
  text: z.string().trim().min(1).max(12000),
  agent_id: identifierSchema.default("system"),
  memory_type: MemoryTypeEnum.default("episodic"),
  task_id: z.string().trim().max(256).nullable().optional().default(null),
  tags: z.array(tagSchema).max(32).default([]),
}).strict();

export const addMemoryInputSchema = addMemoryWriteInputSchema.extend({
  metadata: metadataSchema.default({}),
}).strict();

export const memoryFiltersSchema = z.object({
  agent_id: identifierSchema.optional(),
  memory_type: MemoryTypeEnum.optional(),
  task_id: z.string().trim().max(256).nullable().optional(),
  tags: z.array(tagSchema).max(32).optional(),
}).strict();

export const searchMemoryInputSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  top_k: z.number().int().min(1).max(25).optional(),
  filters: memoryFiltersSchema.optional(),
}).strict();

export const reflectMemoryInputSchema = z.object({
  window: z.number().int().min(10).max(500).default(50),
  force: z.boolean().default(false),
  session_id: z.string().trim().max(256).optional(),
}).strict();

export const getMemoryInputSchema = z.object({
  id: z.string().trim().uuid(),
}).strict();

export const recentMemoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(10),
  filters: memoryFiltersSchema.optional(),
}).strict();

export const memoryStatusInputSchema = z.object({}).strict();

export const planStateStatusSchema = z.enum([
  "draft",
  "active",
  "checkpointed",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const projectionModeSchema = z.enum(["focused", "balanced", "broad"]);
export const retrievalSourceSchema = z.enum(["plan_state", "hot", "journal", "graph", "vector", "temporal"]);
export const hybridRetrievalStrategySchema = z.enum([
  "balanced",
  "memory_first",
  "plan_first",
  "temporal_first",
]);
export const bridgeSyncPhaseSchema = z.enum([
  "pre_execution",
  "post_execution",
  "checkpoint",
  "resume",
  "reflection",
]);
export const bridgeSyncOutcomeSchema = z.enum(["success", "partial", "failure", "cancelled"]);

const optionalNamespaceSchema = namespaceSchema.optional();
const optionalPlanIdSchema = identifierSchema.nullable().optional();
const optionalCheckpointIdSchema = identifierSchema.nullable().optional();
const optionalSessionIdSchema = identifierSchema.nullable().optional();
const sourceListSchema = z.array(retrievalSourceSchema).min(1).max(6);

export const planStateReadInputSchema = z.object({
  plan_id: identifierSchema,
  namespace: optionalNamespaceSchema,
  checkpoint_id: optionalCheckpointIdSchema,
  include_messages: z.boolean().default(false),
  include_artifacts: z.boolean().default(false),
}).strict();

export const planStateSnapshotSchema = z.object({
  plan_id: identifierSchema,
  namespace: namespaceSchema,
  status: planStateStatusSchema,
  checkpoint_id: identifierSchema.nullable(),
  thread_id: identifierSchema.nullable(),
  state_version: z.number().int().min(0).nullable(),
  summary: z.string().trim().max(4000).nullable(),
  updated_at: isoTimestampSchema.nullable(),
  state: metadataSchema,
  messages: z.array(metadataSchema).optional(),
  artifacts: z.array(metadataSchema).optional(),
}).strict();

export const planStateWriteInputSchema = z.object({
  plan_id: identifierSchema,
  namespace: optionalNamespaceSchema,
  expected_state_version: z.number().int().min(0).optional(),
  status: planStateStatusSchema.optional(),
  summary: summarySchema.optional(),
  state_patch: metadataSchema.default({}),
  metadata: metadataSchema.default({}),
  tags: z.array(tagSchema).max(32).default([]),
}).strict();

export const planStateWriteResultSchema = z.object({
  plan_id: identifierSchema,
  namespace: namespaceSchema,
  status: planStateStatusSchema,
  state_version: z.number().int().min(0),
  checkpoint_id: identifierSchema.nullable(),
  applied: z.boolean(),
  updated_at: isoTimestampSchema,
}).strict();

export const planStateCheckpointInputSchema = z.object({
  plan_id: identifierSchema,
  namespace: optionalNamespaceSchema,
  label: z.string().trim().min(1).max(256).optional(),
  summary: summarySchema.optional(),
  include_state: z.boolean().default(true),
  metadata: metadataSchema.default({}),
}).strict();

export const planStateCheckpointResultSchema = z.object({
  plan_id: identifierSchema,
  namespace: namespaceSchema,
  checkpoint_id: identifierSchema,
  status: planStateStatusSchema,
  state_version: z.number().int().min(0).nullable(),
  created_at: isoTimestampSchema,
}).strict();

export const planStateResumeInputSchema = z.object({
  plan_id: identifierSchema,
  namespace: optionalNamespaceSchema,
  checkpoint_id: identifierSchema,
  target_thread_id: identifierSchema.nullable().optional(),
  resume_reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const planStateResumeResultSchema = z.object({
  plan_id: identifierSchema,
  namespace: namespaceSchema,
  checkpoint_id: identifierSchema,
  resumed: z.boolean(),
  status: planStateStatusSchema,
  thread_id: identifierSchema.nullable(),
  state_version: z.number().int().min(0).nullable(),
  resumed_at: isoTimestampSchema,
}).strict();

export const sliceProjectionInputSchema = z.object({
  objective: z.string().trim().min(1).max(4000),
  query: z.string().trim().min(1).max(4000).optional(),
  plan_id: optionalPlanIdSchema,
  namespace: optionalNamespaceSchema,
  projection_mode: projectionModeSchema.default("balanced"),
  sources: sourceListSchema.optional(),
  filters: memoryFiltersSchema.optional(),
  max_slices: z.number().int().min(1).max(50).default(8),
  max_tokens: z.number().int().min(128).max(20000).default(4000),
  include_sources: z.boolean().default(true),
}).strict();

export const projectedSliceSchema = z.object({
  slice_id: identifierSchema,
  source: retrievalSourceSchema,
  text: z.string().trim().min(1).max(12000),
  score: z.number().min(0).max(1),
  token_estimate: z.number().int().min(0),
  metadata: metadataSchema,
  source_ref: z.object({
    id: identifierSchema,
    kind: z.string().trim().min(1).max(64),
  }).strict().optional(),
}).strict();

export const sliceProjectionResultSchema = z.object({
  projection_id: identifierSchema,
  plan_id: identifierSchema.nullable(),
  namespace: namespaceSchema,
  objective: z.string().trim().min(1).max(4000),
  projection_mode: projectionModeSchema,
  slices: z.array(projectedSliceSchema),
  truncated: z.boolean(),
  total_estimated_tokens: z.number().int().min(0),
  generated_at: isoTimestampSchema,
}).strict();

export const hybridRetrieveInputSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  plan_id: optionalPlanIdSchema,
  namespace: optionalNamespaceSchema,
  top_k: z.number().int().min(1).max(25).optional(),
  sources: sourceListSchema.optional(),
  filters: memoryFiltersSchema.optional(),
  fusion_strategy: hybridRetrievalStrategySchema.default("balanced"),
  include_scores: z.boolean().default(true),
}).strict();

export const hybridRetrievalResultItemSchema = z.object({
  id: identifierSchema,
  source: retrievalSourceSchema,
  title: z.string().trim().min(1).max(256).nullable().optional(),
  text: z.string().trim().min(1).max(12000),
  score: z.number().min(0).max(1).optional(),
  created_at: isoTimestampSchema.nullable().optional(),
  metadata: metadataSchema,
  channels: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
}).strict();

export const hybridRetrieveResultSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  plan_id: identifierSchema.nullable(),
  namespace: namespaceSchema,
  fusion_strategy: hybridRetrievalStrategySchema,
  scanned_sources: z.array(retrievalSourceSchema),
  returned: z.number().int().min(0),
  results: z.array(hybridRetrievalResultItemSchema),
}).strict();

export const bridgeSyncInputSchema = z.object({
  plan_id: identifierSchema,
  namespace: optionalNamespaceSchema,
  phase: bridgeSyncPhaseSchema,
  outcome: bridgeSyncOutcomeSchema,
  summary: summarySchema,
  execution_id: identifierSchema.nullable().optional(),
  state_delta: metadataSchema.default({}),
  memory_write_ids: z.array(z.string().uuid()).max(64).default([]),
  request_checkpoint: z.boolean().default(false),
  request_reflection_handoff: z.boolean().default(false),
  tags: z.array(tagSchema).max(32).default([]),
  metadata: metadataSchema.default({}),
}).strict();

export const bridgeSyncResultSchema = z.object({
  sync_id: identifierSchema,
  plan_id: identifierSchema,
  namespace: namespaceSchema,
  phase: bridgeSyncPhaseSchema,
  outcome: bridgeSyncOutcomeSchema,
  accepted_memory_write_ids: z.number().int().min(0),
  checkpoint_requested: z.boolean(),
  reflection_handoff_requested: z.boolean(),
  recorded_at: isoTimestampSchema,
}).strict();

export const reflectionHandoffInputSchema = z.object({
  plan_id: optionalPlanIdSchema,
  namespace: optionalNamespaceSchema,
  checkpoint_id: optionalCheckpointIdSchema,
  session_id: optionalSessionIdSchema,
  summary: summarySchema,
  source_memory_ids: z.array(z.string().uuid()).max(64).default([]),
  tags: z.array(tagSchema).max(32).default([]),
  force: z.boolean().default(false),
  metadata: metadataSchema.default({}),
}).strict();

export const reflectionHandoffResultSchema = z.object({
  handoff_id: identifierSchema,
  plan_id: identifierSchema.nullable(),
  checkpoint_id: identifierSchema.nullable(),
  session_id: identifierSchema.nullable(),
  accepted_source_count: z.number().int().min(0),
  scheduled: z.boolean(),
  created_at: isoTimestampSchema,
}).strict();

export const temporalGraphQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  plan_id: optionalPlanIdSchema,
  subject_ids: z.array(identifierSchema).max(32).optional(),
  relation_types: z.array(relationTypeSchema).max(32).optional(),
  time_range: z.object({
    since: isoTimestampSchema.optional(),
    until: isoTimestampSchema.optional(),
  }).strict().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  include_evidence: z.boolean().default(false),
}).strict();

export const temporalGraphEdgeResultSchema = z.object({
  subject_id: identifierSchema,
  relation_type: relationTypeSchema,
  object_id: identifierSchema.nullable(),
  summary: z.string().trim().min(1).max(4000),
  valid_at: isoTimestampSchema.nullable().optional(),
  observed_at: isoTimestampSchema.nullable().optional(),
  score: z.number().min(0).max(1).nullable().optional(),
  evidence_ids: z.array(z.string().uuid()).max(64).optional(),
}).strict();

export const temporalGraphQueryResultSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  plan_id: identifierSchema.nullable(),
  returned: z.number().int().min(0),
  results: z.array(temporalGraphEdgeResultSchema),
}).strict();

export const contractStubResultSchema = z.object({
  contract_version: z.string(),
  tool: z.string().trim().min(1).max(128),
  capability: z.string().trim().min(1).max(128),
  mode: releaseContractToolModeSchema,
  implemented: z.literal(false),
  message: z.string().trim().min(1).max(4000),
  docs_path: z.string().trim().min(1).max(512),
}).strict();

export const CONTRACT_TOOL_NAMES = {
  PLAN_STATE_READ: "plan_state_read",
  PLAN_STATE_WRITE: "plan_state_write",
  PLAN_STATE_CHECKPOINT: "plan_state_checkpoint",
  PLAN_STATE_RESUME: "plan_state_resume",
  SLICE_PROJECT: "slice_project",
  HYBRID_RETRIEVE: "hybrid_retrieve",
  BRIDGE_SYNC: "bridge_sync",
  REFLECTION_HANDOFF: "reflection_handoff",
  TEMPORAL_GRAPH_QUERY: "temporal_graph_query",
} as const;

export type ContractToolName = typeof CONTRACT_TOOL_NAMES[keyof typeof CONTRACT_TOOL_NAMES];

export const dualBrainContractToolDefinitions = [
  {
    name: CONTRACT_TOOL_NAMES.PLAN_STATE_READ,
    capability: "plan_state",
    description: "Read a LangGraph left-brain plan-state snapshot or a named checkpoint.",
  },
  {
    name: CONTRACT_TOOL_NAMES.PLAN_STATE_WRITE,
    capability: "plan_state",
    description: "Write a state patch into the left-brain plan-state runtime.",
  },
  {
    name: CONTRACT_TOOL_NAMES.PLAN_STATE_CHECKPOINT,
    capability: "plan_state",
    description: "Create a durable checkpoint for a left-brain plan-state thread.",
  },
  {
    name: CONTRACT_TOOL_NAMES.PLAN_STATE_RESUME,
    capability: "plan_state",
    description: "Resume a left-brain plan-state thread from a prior checkpoint.",
  },
  {
    name: CONTRACT_TOOL_NAMES.SLICE_PROJECT,
    capability: "slice_projection",
    description: "Project plan-aware Mnemosyne slices for the next execution step.",
  },
  {
    name: CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE,
    capability: "hybrid_retrieval",
    description: "Run bridge-assisted retrieval across plan, hot, graph, journal, vector, and temporal channels.",
  },
  {
    name: CONTRACT_TOOL_NAMES.BRIDGE_SYNC,
    capability: "bridge_sync",
    description: "Sync execution outcomes from the bridge back into plan state and durable memory channels.",
  },
  {
    name: CONTRACT_TOOL_NAMES.REFLECTION_HANDOFF,
    capability: "reflection_handoff",
    description: "Handoff bridge execution context into the reflection pipeline contract.",
  },
  {
    name: CONTRACT_TOOL_NAMES.TEMPORAL_GRAPH_QUERY,
    capability: "temporal_graph",
    description: "Query temporal graph memory over entity relationships, windows, and supporting evidence.",
  },
] as const satisfies readonly {
  name: ContractToolName;
  capability: ContractToolCapability;
  description: string;
}[];

export type AddMemoryInput = z.infer<typeof addMemoryWriteInputSchema>;
export type AddMemoryToolInput = z.infer<typeof addMemoryInputSchema>;
export type MemoryFiltersInput = z.infer<typeof memoryFiltersSchema>;
export type SearchMemoryInput = z.infer<typeof searchMemoryInputSchema>;
export type ReflectMemoryInput = z.infer<typeof reflectMemoryInputSchema>;
export type GetMemoryInput = z.infer<typeof getMemoryInputSchema>;
export type RecentMemoryInput = z.infer<typeof recentMemoryInputSchema>;
export type MemoryStatusInput = z.infer<typeof memoryStatusInputSchema>;
export type PlanStateStatus = z.infer<typeof planStateStatusSchema>;
export type PlanStateReadInput = z.infer<typeof planStateReadInputSchema>;
export type PlanStateSnapshot = z.infer<typeof planStateSnapshotSchema>;
export type PlanStateWriteInput = z.infer<typeof planStateWriteInputSchema>;
export type PlanStateWriteResult = z.infer<typeof planStateWriteResultSchema>;
export type PlanStateCheckpointInput = z.infer<typeof planStateCheckpointInputSchema>;
export type PlanStateCheckpointResult = z.infer<typeof planStateCheckpointResultSchema>;
export type PlanStateResumeInput = z.infer<typeof planStateResumeInputSchema>;
export type PlanStateResumeResult = z.infer<typeof planStateResumeResultSchema>;
export type SliceProjectionInput = z.infer<typeof sliceProjectionInputSchema>;
export type ProjectedSlice = z.infer<typeof projectedSliceSchema>;
export type SliceProjectionResult = z.infer<typeof sliceProjectionResultSchema>;
export type RetrievalSource = z.infer<typeof retrievalSourceSchema>;
export type HybridRetrieveInput = z.infer<typeof hybridRetrieveInputSchema>;
export type HybridRetrieveResult = z.infer<typeof hybridRetrieveResultSchema>;
export type BridgeSyncInput = z.infer<typeof bridgeSyncInputSchema>;
export type BridgeSyncResult = z.infer<typeof bridgeSyncResultSchema>;
export type ReflectionHandoffInput = z.infer<typeof reflectionHandoffInputSchema>;
export type ReflectionHandoffResult = z.infer<typeof reflectionHandoffResultSchema>;
export type TemporalGraphQueryInput = z.infer<typeof temporalGraphQueryInputSchema>;
export type TemporalGraphEdgeResult = z.infer<typeof temporalGraphEdgeResultSchema>;
export type TemporalGraphQueryResult = z.infer<typeof temporalGraphQueryResultSchema>;
export type ContractStubResult = z.infer<typeof contractStubResultSchema>;

export type JournalEntry = {
  schema_version: 2;
  id: string;
  agent_id: string;
  memory_type: z.infer<typeof MemoryTypeEnum>;
  task_id: string | null;
  tags: string[];
  text: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type MemoryRecord = {
  id: string;
  agent_id: string;
  memory_type: string;
  task_id: string | null;
  tags: string[];
  text: string;
  created_at: string;
  content_hash: string;
  reinforcement_count: number;
  metadata: Record<string, unknown>;
  embedding: number[];
  deduped?: boolean;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type GatewayAuthContext = {
  apiKeyId: string | null;
  organizationId: string | null;
  product: string;
  accessLevel: string;
  planCode: string | null;
  deploymentMode: string | null;
  billingSource: string | null;
  features: string[];
  rateLimit: number;
  isInternal: boolean;
  source: "disabled" | "internal_bus" | "billing_manager" | "oauth_billing_manager";
};
