import { z } from "zod";
import { dualBrainContractToolModesSchema, releaseContractToolModeSchema } from "./types.ts";
import { resolveVectorProfiles, type VectorProfile } from "./vector_topology.ts";

const releaseChannelSchema = z.enum([
  "hosted-prod",
  "marketplace-gcp",
  "marketplace-aws",
  "marketplace-azure",
  "self-hosted-prod",
  "dev-integration",
  "local-demo",
]);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  RELEASE_CHANNEL: releaseChannelSchema.default("dev-integration"),
  REQUIRE_AUTH: z.string().optional(),
  INTERNAL_BUS_TOKEN: z.string().default("secret_bus_token"),
  BILLING_MANAGER_URL: z.string().default(""),
  BILLING_MANAGER_SERVICE_TOKEN: z.string().default(""),
  OAUTH_AUTHORIZATION_SERVER_URL: z.string().default(""),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  USAGE_REPORTING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() === "true"),

  QDRANT_URL: z.string().url().default("http://qdrant:6333"),
  QDRANT_COLLECTION: z.string().default("soul_journal"),
  QDRANT_API_KEY: z.string().optional(),

  FALKOR_REDIS_URL: z.string().default("redis://falkordb:6379"),
  FALKOR_GRAPH: z.string().default("mnemosyne"),
  FALKOR_MIRROR_GRAPHS: z.string().default(""),

  SOUL_JOURNAL_PATH: z.string().default("/var/lib/memory-stack/soul_journal.jsonl"),
  SLICE_JOURNAL_PATH: z.string().default("/var/lib/memory-stack/slice_journal.jsonl"),

  VECTOR_DIM: z.coerce.number().int().min(32).max(8192).default(256),
  VECTOR_EMBED_PROVIDER: z.string().default("mnemosyne-runtime"),
  VECTOR_EMBED_MODEL: z.string().default("mnemosyne-hash-embed-v1"),
  VECTOR_MIRROR_PROFILES: z.string().default(""),
  SLICE_QDRANT_COLLECTION: z.string().default("mnemosyne_slices"),
  SLICE_EMBED_PROVIDER: z.string().default("mnemosyne-runtime"),
  SLICE_EMBED_MODEL: z.string().default("mnemosyne-hash-embed-v1"),
  SLICE_MAX_TOKENS: z.coerce.number().int().min(64).max(20000).default(2048),
  TOP_K_DEFAULT: z.coerce.number().int().min(1).max(25).default(5),
  SIMILARITY_DEDUP_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.985),
  AUTO_REFLECT_EVERY: z.coerce.number().int().min(0).max(100000).default(25),
  REPLAY_SELECTION_MODE: z
    .enum(["window", "priority_deterministic", "priority_prng", "priority_quantum"])
    .default("priority_quantum"),
  REPLAY_MAX_SOURCES: z.coerce.number().int().min(4).max(128).default(24),
  REPLAY_TIE_EPSILON: z.coerce.number().min(0).max(0.5).default(0.035),
  QUANTUM_ENTROPY_MODE: z.enum(["off", "external"]).default("external"),
  QUANTUM_ENTROPY_URL: z.string().default("https://qrng.anu.edu.au/API/jsonI.php?length=1&type=hex16&size=32"),
  QUANTUM_ENTROPY_METHOD: z.enum(["GET", "POST"]).default("GET"),
  QUANTUM_ENTROPY_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(2500),
  QUANTUM_REFLECT_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.35),
  QUANTUM_ENTROPY_HEADER_NAME: z.string().default(""),
  QUANTUM_ENTROPY_HEADER_VALUE: z.string().default(""),

  DB_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  DB_RETRY_BASE_DELAY_SECONDS: z.coerce.number().min(0.05).max(10).default(0.25),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(8000),
  FALKOR_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(8000),

  MAX_SSE_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(500),
  GRAPH_SEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(8),
  MAX_MEMORY_TEXT_BYTES: z.coerce.number().int().min(1024).max(5000000).default(50000),
  MAX_QUERY_BYTES: z.coerce.number().int().min(64).max(200000).default(8000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PLAN_STATE_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  SLICE_PROJECTION_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  HYBRID_RETRIEVAL_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  BRIDGE_SYNC_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  REFLECTION_HANDOFF_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  TEMPORAL_GRAPH_TOOL_MODE: releaseContractToolModeSchema.default("off"),
  OTEL_SERVICE_NAME: z.string().default("mnemosyne-gateway"),
  OTEL_SERVICE_NAMESPACE: z.string().default("multinex"),
  OTEL_SERVICE_INSTANCE_ID: z
    .string()
    .default(Deno.env.get("K_REVISION") || Deno.env.get("HOSTNAME") || crypto.randomUUID()),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().default(""),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().default(""),
  CLOUDGAZE_OTLP_BASE_URL: z.string().default(""),
  OTEL_DEPLOYMENT_ENVIRONMENT: z
    .string()
    .default(Deno.env.get("DEPLOYMENT_ENVIRONMENT") || Deno.env.get("ENVIRONMENT") || "development"),
  CLOUD_PROVIDER: z.string().default(""),
  CLOUD_PLATFORM: z.string().default(""),
  CLOUD_REGION: z.string().default(""),
  K8S_CLUSTER_NAME: z.string().default(""),
  MULTINEX_CHANNEL: z.string().default(""),
  MULTINEX_MARKETPLACE_PROVIDER: z.string().default(""),
  MULTINEX_MARKETPLACE_OFFER: z.string().default(""),
  MULTINEX_MARKETPLACE_PLAN: z.string().default(""),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, "REQUIRE_AUTH"> & {
  REQUIRE_AUTH: boolean;
  DUAL_BRAIN_CONTRACT_TOOLS: z.infer<typeof dualBrainContractToolModesSchema>;
  FALKOR_GRAPH_NAMES: string[];
  VECTOR_PROFILES: VectorProfile[];
  SLICE_VECTOR_PROFILES: VectorProfile[];
};

function defaultRequireAuth(releaseChannel: z.infer<typeof releaseChannelSchema>): boolean {
  return releaseChannel !== "local-demo";
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(Deno.env.toObject());
  const requireAuth = parsed.REQUIRE_AUTH
    ? parsed.REQUIRE_AUTH.toLowerCase() === "true"
    : defaultRequireAuth(parsed.RELEASE_CHANNEL);

  if (!requireAuth && parsed.RELEASE_CHANNEL !== "local-demo") {
    throw new Error(
      `REQUIRE_AUTH=false is not permitted for release channel ${parsed.RELEASE_CHANNEL}. Use local-demo for isolated unauthenticated demos only.`,
    );
  }

  const falkorGraphNames = [
    parsed.FALKOR_GRAPH,
    ...parsed.FALKOR_MIRROR_GRAPHS.split(",").map((value) => value.trim()).filter(Boolean),
  ].filter((value, index, array) => array.indexOf(value) === index);

  const vectorProfiles = resolveVectorProfiles({
    provider: parsed.VECTOR_EMBED_PROVIDER,
    model: parsed.VECTOR_EMBED_MODEL,
    dimension: parsed.VECTOR_DIM,
  }, parsed.VECTOR_MIRROR_PROFILES);
  const sliceVectorProfiles = resolveVectorProfiles({
    provider: parsed.SLICE_EMBED_PROVIDER,
    model: parsed.SLICE_EMBED_MODEL,
    dimension: parsed.VECTOR_DIM,
  }, parsed.VECTOR_MIRROR_PROFILES);

  const config: AppConfig = {
    ...parsed,
    REQUIRE_AUTH: requireAuth,
    MULTINEX_CHANNEL: parsed.MULTINEX_CHANNEL || parsed.RELEASE_CHANNEL,
    FALKOR_GRAPH_NAMES: falkorGraphNames,
    VECTOR_PROFILES: vectorProfiles,
    SLICE_VECTOR_PROFILES: sliceVectorProfiles,
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: parsed.PLAN_STATE_TOOL_MODE,
      slice_projection: parsed.SLICE_PROJECTION_TOOL_MODE,
      hybrid_retrieval: parsed.HYBRID_RETRIEVAL_TOOL_MODE,
      bridge_sync: parsed.BRIDGE_SYNC_TOOL_MODE,
      reflection_handoff: parsed.REFLECTION_HANDOFF_TOOL_MODE,
      temporal_graph: parsed.TEMPORAL_GRAPH_TOOL_MODE,
    },
  };

  if (!config.OAUTH_AUTHORIZATION_SERVER_URL && config.BILLING_MANAGER_URL) {
    config.OAUTH_AUTHORIZATION_SERVER_URL = config.BILLING_MANAGER_URL;
  }

  if (config.QUANTUM_ENTROPY_MODE === "external" && config.QUANTUM_ENTROPY_URL.length === 0) {
    throw new Error("QUANTUM_ENTROPY_URL is required when QUANTUM_ENTROPY_MODE=external");
  }

  return config;
}
