import { z, ZodError } from "zod";
import {
  addMemoryInputSchema,
  bridgeSyncInputSchema,
  CONTRACT_TOOL_NAMES,
  contractStubResultSchema,
  type ContractToolCapability,
  type ContractToolName,
  dualBrainContractToolDefinitions,
  type GatewayAuthContext,
  getMemoryInputSchema,
  hybridRetrieveInputSchema,
  type McpTool,
  memoryStatusInputSchema,
  MNEMOSYNE_PROTOCOL_VERSION,
  MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
  planStateCheckpointInputSchema,
  planStateReadInputSchema,
  planStateResumeInputSchema,
  planStateWriteInputSchema,
  recentMemoryInputSchema,
  reflectionHandoffInputSchema,
  reflectMemoryInputSchema,
  type ReleaseContractToolMode,
  searchMemoryInputSchema,
  sliceProjectionInputSchema,
  temporalGraphQueryInputSchema,
} from "./types.ts";
import { MemoryService } from "./memory_service.ts";
import type { AppConfig } from "./config.ts";
import { MNEMOSYNE_GATEWAY_RUNTIME_VERSION } from "./build_info.ts";
import { GatewayTelemetry } from "./telemetry.ts";
import type { Logger } from "./utils.ts";
import { BillingManagerClient } from "./billing_client.ts";
import { GatewayToolError } from "./errors.ts";

const jsonRpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional().nullable(),
  method: z.string(),
  params: z.unknown().optional(),
});

const OAUTH_ACCESS_TOKEN_PREFIX = "mnxoa_";
const CONTRACT_DOCS_PATH = "products/munx-memorystack/docs/AGENT_MEMORY_PROTOCOL.md#stable-rollout-contract";
const MEMORY_TYPE_VALUES = ["episodic", "semantic", "procedural", "checkpoint", "hybrid", "reflection"];

const memoryFiltersJsonSchema = {
  type: "object",
  properties: {
    agent_id: { type: "string", minLength: 1, maxLength: 256 },
    memory_type: { type: "string", enum: MEMORY_TYPE_VALUES },
    task_id: { type: ["string", "null"], maxLength: 256 },
    tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
  },
  additionalProperties: false,
} as const;

const retrievalSourceValues = ["plan_state", "hot", "journal", "graph", "vector", "temporal"];
const planStateStatusValues = ["draft", "active", "checkpointed", "paused", "completed", "failed", "cancelled"];

const baseTools: readonly McpTool[] = [
  {
    name: "add_memory",
    description: "Persist memory into Soul Journal, graph, vector, and hot bus with dedup/reconciliation.",
    inputSchema: {
      type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 12000 },
          agent_id: { type: "string", minLength: 1, maxLength: 256 },
          memory_type: { type: "string", enum: MEMORY_TYPE_VALUES },
          task_id: { type: ["string", "null"], maxLength: 256 },
          tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["text"],
        additionalProperties: false,
      },
  },
  {
    name: "search_memory",
    description: "Cross-layer memory retrieval with fused ranking across hot, graph, and vector layers.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4000 },
        top_k: { type: "integer", minimum: 1, maximum: 25 },
        filters: memoryFiltersJsonSchema,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_memory",
    description: "Fetch a specific memory by ID for exact recall, replay, or citation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_memory",
    description: "Read the most recent HOT-context memories, optionally filtered by agent, task, type, or tags.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        filters: memoryFiltersJsonSchema,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "reflect_memory",
    description: "Run self-reflection over recent memory window and persist a new learning checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "integer", minimum: 10, maximum: 500 },
        force: { type: "boolean" },
        session_id: { type: "string", maxLength: 256 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "memory_status",
    description: "Return Mnemosyne backend health, limits, tier configuration, and contract feature flags.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

const contractToolSchemas: Record<ContractToolName, Record<string, unknown>> = {
  [CONTRACT_TOOL_NAMES.PLAN_STATE_READ]: {
    type: "object",
    properties: {
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      checkpoint_id: { type: ["string", "null"], maxLength: 256 },
      include_messages: { type: "boolean" },
      include_artifacts: { type: "boolean" },
    },
    required: ["plan_id"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.PLAN_STATE_WRITE]: {
    type: "object",
    properties: {
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      expected_state_version: { type: "integer", minimum: 0 },
      status: { type: "string", enum: planStateStatusValues },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      state_patch: { type: "object", additionalProperties: true },
      metadata: { type: "object", additionalProperties: true },
      tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
    },
    required: ["plan_id"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.PLAN_STATE_CHECKPOINT]: {
    type: "object",
    properties: {
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      label: { type: "string", minLength: 1, maxLength: 256 },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      include_state: { type: "boolean" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["plan_id"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.PLAN_STATE_RESUME]: {
    type: "object",
    properties: {
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      checkpoint_id: { type: "string", minLength: 1, maxLength: 256 },
      target_thread_id: { type: ["string", "null"], maxLength: 256 },
      resume_reason: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["plan_id", "checkpoint_id"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.SLICE_PROJECT]: {
    type: "object",
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 4000 },
      query: { type: "string", minLength: 1, maxLength: 4000 },
      plan_id: { type: ["string", "null"], maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      projection_mode: { type: "string", enum: ["focused", "balanced", "broad"] },
      sources: { type: "array", items: { type: "string", enum: retrievalSourceValues }, minItems: 1, maxItems: 6 },
      filters: memoryFiltersJsonSchema,
      max_slices: { type: "integer", minimum: 1, maximum: 50 },
      max_tokens: { type: "integer", minimum: 128, maximum: 20000 },
      include_sources: { type: "boolean" },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE]: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 4000 },
      plan_id: { type: ["string", "null"], maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      top_k: { type: "integer", minimum: 1, maximum: 25 },
      sources: { type: "array", items: { type: "string", enum: retrievalSourceValues }, minItems: 1, maxItems: 6 },
      filters: memoryFiltersJsonSchema,
      fusion_strategy: { type: "string", enum: ["balanced", "memory_first", "plan_first", "temporal_first"] },
      include_scores: { type: "boolean" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.BRIDGE_SYNC]: {
    type: "object",
    properties: {
      plan_id: { type: "string", minLength: 1, maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      phase: { type: "string", enum: ["pre_execution", "post_execution", "checkpoint", "resume", "reflection"] },
      outcome: { type: "string", enum: ["success", "partial", "failure", "cancelled"] },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      execution_id: { type: ["string", "null"], maxLength: 256 },
      state_delta: { type: "object", additionalProperties: true },
      memory_write_ids: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 64 },
      request_checkpoint: { type: "boolean" },
      request_reflection_handoff: { type: "boolean" },
      tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["plan_id", "phase", "outcome", "summary"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.REFLECTION_HANDOFF]: {
    type: "object",
    properties: {
      plan_id: { type: ["string", "null"], maxLength: 256 },
      namespace: { type: "string", minLength: 1, maxLength: 128 },
      checkpoint_id: { type: ["string", "null"], maxLength: 256 },
      session_id: { type: ["string", "null"], maxLength: 256 },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      source_memory_ids: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 64 },
      tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
      force: { type: "boolean" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["summary"],
    additionalProperties: false,
  },
  [CONTRACT_TOOL_NAMES.TEMPORAL_GRAPH_QUERY]: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 4000 },
      plan_id: { type: ["string", "null"], maxLength: 256 },
      subject_ids: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 }, maxItems: 32 },
      relation_types: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 }, maxItems: 32 },
      time_range: {
        type: "object",
        properties: {
          since: { type: "string", format: "date-time" },
          until: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      include_evidence: { type: "boolean" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const contractToolInputParsers: Record<ContractToolName, z.ZodType<unknown>> = {
  [CONTRACT_TOOL_NAMES.PLAN_STATE_READ]: planStateReadInputSchema,
  [CONTRACT_TOOL_NAMES.PLAN_STATE_WRITE]: planStateWriteInputSchema,
  [CONTRACT_TOOL_NAMES.PLAN_STATE_CHECKPOINT]: planStateCheckpointInputSchema,
  [CONTRACT_TOOL_NAMES.PLAN_STATE_RESUME]: planStateResumeInputSchema,
  [CONTRACT_TOOL_NAMES.SLICE_PROJECT]: sliceProjectionInputSchema,
  [CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE]: hybridRetrieveInputSchema,
  [CONTRACT_TOOL_NAMES.BRIDGE_SYNC]: bridgeSyncInputSchema,
  [CONTRACT_TOOL_NAMES.REFLECTION_HANDOFF]: reflectionHandoffInputSchema,
  [CONTRACT_TOOL_NAMES.TEMPORAL_GRAPH_QUERY]: temporalGraphQueryInputSchema,
};

type JsonRpc = z.infer<typeof jsonRpcSchema>;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class McpHandler {
  private readonly tools: McpTool[];
  private readonly billing: BillingManagerClient;

  constructor(
    private readonly memory: MemoryService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly telemetry: GatewayTelemetry,
  ) {
    this.billing = new BillingManagerClient(config, logger);
    this.tools = this.buildTools();
  }

  extractToken(headers: Headers): string | null {
    const bearer = headers.get("Authorization");
    if (bearer?.startsWith("Bearer ")) {
      return bearer.slice("Bearer ".length).trim() || null;
    }

    return headers.get("X-Munx-Visa-Token");
  }

  async verifyAuth(token: string | null): Promise<GatewayAuthContext | null> {
    const startedAt = Date.now();
    if (!this.config.REQUIRE_AUTH) {
      this.telemetry.recordAuthValidation("disabled", true, Date.now() - startedAt, {
        release_channel: this.config.RELEASE_CHANNEL,
      });
      return {
        apiKeyId: null,
        organizationId: null,
        product: "mnemosyne",
        accessLevel: "internal_free",
        planCode: "mnemosyne_internal_free",
        deploymentMode: "hosted",
        billingSource: "internal",
        features: ["mcp_access", "memory_read", "memory_write", "memory_reflect", "memory_recent", "memory_exact"],
        rateLimit: 6000,
        isInternal: true,
        source: "disabled",
      };
    }

    if (!token) {
      this.telemetry.recordAuthValidation("missing", false, Date.now() - startedAt, {
        release_channel: this.config.RELEASE_CHANNEL,
      });
      return null;
    }
    if (token === this.config.INTERNAL_BUS_TOKEN) {
      this.telemetry.recordAuthValidation("internal_bus", true, Date.now() - startedAt, {
        release_channel: this.config.RELEASE_CHANNEL,
      });
      return {
        apiKeyId: null,
        organizationId: null,
        product: "mnemosyne",
        accessLevel: "internal_free",
        planCode: "mnemosyne_internal_free",
        deploymentMode: "hosted",
        billingSource: "internal",
        features: ["mcp_access", "memory_read", "memory_write", "memory_reflect", "memory_recent", "memory_exact"],
        rateLimit: 6000,
        isInternal: true,
        source: "internal_bus",
      };
    }

    if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      const context = await this.billing.validateOauthToken(token);
      this.telemetry.recordAuthValidation("oauth_billing_manager", Boolean(context), Date.now() - startedAt, {
        release_channel: this.config.RELEASE_CHANNEL,
      });
      return context;
    }

    const context = await this.billing.validateToken(token);
    this.telemetry.recordAuthValidation("billing_manager", Boolean(context), Date.now() - startedAt, {
      release_channel: this.config.RELEASE_CHANNEL,
    });
    return context;
  }

  async handleRaw(body: unknown, auth?: GatewayAuthContext): Promise<JsonRpcResponse> {
    try {
      const request = jsonRpcSchema.parse(body);
      return await this.handle(request, auth);
    } catch (error) {
      if (error instanceof ZodError) {
        return this.error(null, -32600, "Invalid Request", { issues: error.issues });
      }
      return this.error(null, -32603, "Internal error", { message: String(error) });
    }
  }

  private buildTools(): McpTool[] {
    const tools = [...baseTools];
    for (const tool of dualBrainContractToolDefinitions) {
      if (this.contractToolMode(tool.capability) === "off") continue;
      tools.push({
        name: tool.name,
        description: `${tool.description} Contract version ${MNEMOSYNE_ROLLOUT_CONTRACT_VERSION}.`,
        inputSchema: contractToolSchemas[tool.name],
      });
    }
    return tools;
  }

  private async handle(request: JsonRpc, auth?: GatewayAuthContext): Promise<JsonRpcResponse> {
    const id = request.id ?? null;

    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: "pong" };
    }

    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MNEMOSYNE_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "mnemosyne", version: MNEMOSYNE_GATEWAY_RUNTIME_VERSION },
        },
      };
    }

    if (request.method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.tools,
        },
      };
    }

    if (request.method === "tools/call") {
      return await this.handleToolCall(id, request.params, auth);
    }

    return this.error(id, -32601, "Method not found", { method: request.method });
  }

  private contractToolMode(capability: ContractToolCapability): ReleaseContractToolMode {
    return this.config.DUAL_BRAIN_CONTRACT_TOOLS[capability];
  }

  private knownContractTool(name: string): (typeof dualBrainContractToolDefinitions)[number] | undefined {
    return dualBrainContractToolDefinitions.find((tool) => tool.name === name);
  }

  private contractToolDetails(
    tool: ContractToolName,
    capability: ContractToolCapability,
    mode: ReleaseContractToolMode,
    message: string,
  ): Record<string, unknown> {
    return contractStubResultSchema.parse({
      contract_version: MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
      tool,
      capability,
      mode,
      implemented: false,
      message,
      docs_path: CONTRACT_DOCS_PATH,
    });
  }

  private async handleToolCall(
    id: string | number | null,
    params: unknown,
    auth?: GatewayAuthContext,
  ): Promise<JsonRpcResponse> {
    const schema = z.object({
      name: z.string(),
      arguments: z.record(z.unknown()).optional().default({}),
    });

    let toolName = "unknown";
    const startedAt = Date.now();

    try {
      const payload = schema.parse(params ?? {});
      const name = payload.name;
      toolName = name;

      if (name === "add_memory") {
        const parsed = addMemoryInputSchema.parse(payload.arguments);
        const { metadata, ...memoryInput } = parsed;
        const result = await this.memory.addMemory(memoryInput, metadata);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, { ok: true });
        return this.toolResult(id, result);
      }

      if (name === "search_memory") {
        const parsed = searchMemoryInputSchema.parse(payload.arguments);
        const result = await this.memory.searchMemory(parsed);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, { ok: true });
        return this.toolResult(id, result);
      }

      if (name === "get_memory") {
        const parsed = getMemoryInputSchema.parse(payload.arguments);
        const result = await this.memory.getMemory(parsed);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, { ok: true });
        return this.toolResult(id, result);
      }

      if (name === "recent_memory") {
        const parsed = recentMemoryInputSchema.parse(payload.arguments);
        const result = await this.memory.recentMemory(parsed);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, { ok: true });
        return this.toolResult(id, result);
      }

      if (name === "reflect_memory") {
        const parsed = reflectMemoryInputSchema.parse(payload.arguments);
        const result = await this.memory.reflectMemory(parsed);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, { ok: true });
        return this.toolResult(id, result);
      }

      if (name === "memory_status") {
        const parsed = memoryStatusInputSchema.parse(payload.arguments);
        const result = await this.memory.memoryStatus(parsed);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, {
          ok: true,
          access_level: auth?.accessLevel ?? null,
          plan_code: auth?.planCode ?? null,
        });
        return this.toolResult(id, result);
      }

      const contractTool = this.knownContractTool(name);
      if (contractTool) {
        const parsedArguments = contractToolInputParsers[contractTool.name].parse(payload.arguments);
        const mode = this.contractToolMode(contractTool.capability);

        if (mode === "off") {
          await this.reportToolUsage(auth, name, 403, Date.now() - startedAt, {
            ok: false,
            reason: "feature_disabled",
            contract_version: MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
          });
          return this.toolError(
            id,
            "feature_disabled",
            `${name} is declared by the rollout contract but disabled in gateway config.`,
            this.contractToolDetails(
              name as ContractToolName,
              contractTool.capability,
              mode,
              "Enable the matching *_TOOL_MODE to surface this contract tool.",
            ),
          );
        }

        if (mode === "stub") {
          await this.reportToolUsage(auth, name, 501, Date.now() - startedAt, {
            ok: false,
            reason: "not_implemented",
            contract_version: MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
          });
          return this.toolError(
            id,
            "not_implemented",
            `${name} is exposed as a contract stub and has not been implemented yet.`,
            this.contractToolDetails(
              name as ContractToolName,
              contractTool.capability,
              mode,
              "The gateway validates input and advertises the stable contract, but execution is intentionally stubbed.",
            ),
          );
        }

        const result = await this.executeLiveContractTool(name as ContractToolName, parsedArguments, mode);
        await this.reportToolUsage(auth, name, 200, Date.now() - startedAt, {
          ok: true,
          contract_version: MNEMOSYNE_ROLLOUT_CONTRACT_VERSION,
        });
        return this.toolResult(id, result);
      }

      await this.reportToolUsage(auth, name, 404, Date.now() - startedAt, { ok: false, reason: "unknown_tool" });
      return this.toolError(id, "unknown_tool", `Unknown tool: ${name}`, {
        tool: name,
        available_tools: this.tools.map((tool) => tool.name),
      });
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.warn("tool_validation_failure", { error: String(error) });
        await this.reportToolUsage(auth, toolName, 400, Date.now() - startedAt, {
          ok: false,
          reason: "validation_error",
        });
        return this.toolError(id, "validation_error", "Tool input validation failed", {
          errors: error.issues,
        });
      }

      if (error instanceof GatewayToolError) {
        this.logger.warn("tool_execution_failure", {
          tool: toolName,
          code: error.code,
          error: error.message,
        });
        await this.reportToolUsage(auth, toolName, error.statusCode, Date.now() - startedAt, {
          ok: false,
          reason: error.code,
          ...error.details,
        });
        return this.toolError(id, error.code, error.message, error.details);
      }

      this.logger.error("tool_call_failed", { error: String(error) });
      await this.reportToolUsage(auth, toolName, 500, Date.now() - startedAt, {
        ok: false,
        reason: "execution_error",
      });
      return this.toolError(id, "execution_error", String(error), {});
    }
  }

  private async executeLiveContractTool(
    tool: ContractToolName,
    args: unknown,
    mode: ReleaseContractToolMode,
  ): Promise<unknown> {
    switch (tool) {
      case CONTRACT_TOOL_NAMES.PLAN_STATE_READ:
        return await this.memory.planStateRead(args as z.infer<typeof planStateReadInputSchema>);
      case CONTRACT_TOOL_NAMES.PLAN_STATE_WRITE:
        return await this.memory.planStateWrite(args as z.infer<typeof planStateWriteInputSchema>);
      case CONTRACT_TOOL_NAMES.PLAN_STATE_CHECKPOINT:
        return await this.memory.planStateCheckpoint(args as z.infer<typeof planStateCheckpointInputSchema>);
      case CONTRACT_TOOL_NAMES.PLAN_STATE_RESUME:
        return await this.memory.planStateResume(args as z.infer<typeof planStateResumeInputSchema>);
      case CONTRACT_TOOL_NAMES.SLICE_PROJECT:
        return await this.memory.sliceProjection(args as z.infer<typeof sliceProjectionInputSchema>);
      case CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE:
        return await this.memory.hybridRetrieve(args as z.infer<typeof hybridRetrieveInputSchema>);
      case CONTRACT_TOOL_NAMES.BRIDGE_SYNC:
        return await this.memory.bridgeSync(args as z.infer<typeof bridgeSyncInputSchema>);
      case CONTRACT_TOOL_NAMES.REFLECTION_HANDOFF:
        return await this.memory.reflectionHandoff(args as z.infer<typeof reflectionHandoffInputSchema>);
      case CONTRACT_TOOL_NAMES.TEMPORAL_GRAPH_QUERY:
        return await this.memory.temporalGraphQuery(args as z.infer<typeof temporalGraphQueryInputSchema>);
      default:
        throw new GatewayToolError(
          "implementation_missing",
          `${tool} is configured for live execution but the runtime implementation is not linked yet.`,
          this.contractToolDetails(
            tool,
            this.knownContractTool(tool)?.capability ?? "plan_state",
            mode,
            "Set the capability back to stub/off or link the live implementation before enabling this mode.",
          ),
          500,
        );
    }
  }

  private async reportToolUsage(
    auth: GatewayAuthContext | undefined,
    tool: string,
    statusCode: number,
    latencyMs: number,
    requestMetadata: Record<string, unknown>,
  ): Promise<void> {
    this.telemetry.recordToolCall(tool, statusCode, latencyMs, {
      access_level: auth?.accessLevel ?? null,
      plan_code: auth?.planCode ?? null,
      auth_source: auth?.source ?? "none",
      billing_source: auth?.billingSource ?? null,
    });
    if (!auth || auth.source === "disabled") return;
    await this.billing.reportUsage(auth, tool, statusCode, latencyMs, requestMetadata);
  }

  private toolResult(id: string | number | null, result: unknown): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }],
        isError: false,
      },
    };
  }

  private toolError(
    id: string | number | null,
    code: string,
    message: string,
    details: Record<string, unknown>,
  ): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: { code, message, details },
          }),
        }],
        isError: true,
      },
    };
  }

  private error(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        data,
      },
    };
  }
}
