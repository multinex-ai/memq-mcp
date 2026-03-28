import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AppConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { GatewayToolError } from "./errors.ts";
import { MemoryService } from "./memory_service.ts";
import { McpHandler } from "./mcp.ts";
import { GatewayTelemetry } from "./telemetry.ts";
import { CONTRACT_TOOL_NAMES, type HybridRetrieveResult } from "./types.ts";
import { createLogger } from "./utils.ts";

type ConfigOverrides = Partial<Omit<AppConfig, "DUAL_BRAIN_CONTRACT_TOOLS">> & {
  DUAL_BRAIN_CONTRACT_TOOLS?: Partial<AppConfig["DUAL_BRAIN_CONTRACT_TOOLS"]>;
};

type ToolErrorPayload = {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
};

function buildConfig(overrides: ConfigOverrides = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    LOG_LEVEL: "error",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
    CLOUDGAZE_OTLP_BASE_URL: "",
    ...overrides,
    DUAL_BRAIN_CONTRACT_TOOLS: {
      ...base.DUAL_BRAIN_CONTRACT_TOOLS,
      ...(overrides.DUAL_BRAIN_CONTRACT_TOOLS ?? {}),
    },
  };
}

class FakeMemoryService extends MemoryService {
  readonly calls: string[] = [];
  throwOnRead = false;

  override async planStateRead(_input: unknown): Promise<Record<string, unknown>> {
    this.calls.push("planStateRead");
    if (this.throwOnRead) {
      throw new GatewayToolError(
        "plan_state_not_found",
        "Plan state not found for plan-404.",
        { plan_id: "plan-404" },
        404,
      );
    }
    return {
      plan_id: "plan-1",
      namespace: "runtime",
      status: "active",
      checkpoint_id: null,
      thread_id: "thread-1",
      state_version: 2,
      summary: "Hosted runtime bridge plan",
      updated_at: "2026-03-17T12:00:00.000Z",
      state: { step: "sync" },
    };
  }

  override async hybridRetrieve(_input: unknown): Promise<HybridRetrieveResult> {
    this.calls.push("hybridRetrieve");
    return {
      query: "hosted runtime sync",
      plan_id: "plan-1",
      namespace: "runtime",
      fusion_strategy: "plan_first",
      scanned_sources: ["plan_state", "vector"],
      returned: 1,
      results: [{
        id: "plan-1",
        source: "plan_state",
        title: "Hosted runtime bridge plan",
        text: "Plan state tracks hosted runtime sync and reflection handoff.",
        score: 0.92,
        created_at: "2026-03-17T12:00:00.000Z",
        metadata: { plan_id: "plan-1" },
        channels: ["plan_state"],
      }],
    };
  }

  override async bridgeSync(_input: unknown): Promise<Record<string, unknown>> {
    this.calls.push("bridgeSync");
    return {
      sync_id: "sync-1",
      plan_id: "plan-1",
      namespace: "runtime",
      phase: "checkpoint",
      outcome: "success",
      accepted_memory_write_ids: 2,
      checkpoint_requested: true,
      reflection_handoff_requested: true,
      recorded_at: "2026-03-17T12:01:00.000Z",
    };
  }

  override async reflectionHandoff(_input: unknown): Promise<Record<string, unknown>> {
    this.calls.push("reflectionHandoff");
    return {
      handoff_id: "handoff-1",
      plan_id: "plan-1",
      checkpoint_id: "checkpoint-1",
      session_id: "session-1",
      accepted_source_count: 2,
      scheduled: true,
      created_at: "2026-03-17T12:02:00.000Z",
    };
  }
}

function buildHandler(
  overrides: ConfigOverrides = {},
  memory = new MemoryService(buildConfig(overrides), createLogger("error")),
): McpHandler {
  const config = buildConfig(overrides);
  const logger = createLogger(config.LOG_LEVEL);
  const telemetry = new GatewayTelemetry(config, logger);
  return new McpHandler(memory, config, logger, telemetry);
}

function extractToolNames(response: Awaited<ReturnType<McpHandler["handleRaw"]>>): string[] {
  const result = response.result;
  assert(typeof result === "object" && result !== null && "tools" in result);
  const tools = (result as { tools: Array<{ name: string }> }).tools;
  return tools.map((tool) => tool.name);
}

function extractToolError(response: Awaited<ReturnType<McpHandler["handleRaw"]>>): ToolErrorPayload {
  const result = response.result;
  assert(typeof result === "object" && result !== null && "content" in result);
  const content = (result as { content: Array<{ text: string }> }).content;
  const first = content[0];
  assert(first);
  return JSON.parse(first.text) as ToolErrorPayload;
}

function extractToolResult(response: Awaited<ReturnType<McpHandler["handleRaw"]>>): Record<string, unknown> {
  const result = response.result;
  assert(typeof result === "object" && result !== null && "content" in result);
  const content = (result as { content: Array<{ text: string }> }).content;
  const first = content[0];
  assert(first);
  return JSON.parse(first.text) as Record<string, unknown>;
}

Deno.test("contract tools stay hidden by default", async () => {
  const handler = buildHandler();
  const response = await handler.handleRaw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const toolNames = extractToolNames(response);

  assert(!toolNames.includes(CONTRACT_TOOL_NAMES.PLAN_STATE_READ));
  assert(!toolNames.includes(CONTRACT_TOOL_NAMES.SLICE_PROJECT));
  assert(!toolNames.includes(CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE));
});

Deno.test("disabled contract calls return feature_disabled", async () => {
  const handler = buildHandler({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "off",
    },
  });

  const response = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.PLAN_STATE_READ,
      arguments: {
        plan_id: "plan-1",
      },
    },
  });

  const payload = extractToolError(response);
  assertEquals(payload.error.code, "feature_disabled");
  assertEquals(payload.error.details.mode, "off");
  assertEquals(payload.error.details.capability, "plan_state");
});

Deno.test("stub modes advertise and reject contract tools explicitly", async () => {
  const handler = buildHandler({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "stub",
      slice_projection: "stub",
    },
  });

  const listResponse = await handler.handleRaw({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const toolNames = extractToolNames(listResponse);
  assert(toolNames.includes(CONTRACT_TOOL_NAMES.PLAN_STATE_READ));
  assert(toolNames.includes(CONTRACT_TOOL_NAMES.PLAN_STATE_WRITE));
  assert(toolNames.includes(CONTRACT_TOOL_NAMES.PLAN_STATE_CHECKPOINT));
  assert(toolNames.includes(CONTRACT_TOOL_NAMES.PLAN_STATE_RESUME));
  assert(toolNames.includes(CONTRACT_TOOL_NAMES.SLICE_PROJECT));

  const callResponse = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.PLAN_STATE_READ,
      arguments: {
        plan_id: "plan-1",
      },
    },
  });

  const payload = extractToolError(callResponse);
  assertEquals(payload.error.code, "not_implemented");
  assertEquals(payload.error.details.mode, "stub");
  assertEquals(payload.error.details.contract_version, "2026-03-17");
});

Deno.test("live runtime tools dispatch to memory service implementations", async () => {
  const config = buildConfig({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "live",
      hybrid_retrieval: "live",
      bridge_sync: "live",
      reflection_handoff: "live",
    },
  });
  const fakeMemory = new FakeMemoryService(config, createLogger("error"));
  const handler = buildHandler({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "live",
      hybrid_retrieval: "live",
      bridge_sync: "live",
      reflection_handoff: "live",
    },
  }, fakeMemory);

  const readResponse = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.PLAN_STATE_READ,
      arguments: { plan_id: "plan-1" },
    },
  });
  const readPayload = extractToolResult(readResponse);
  assertEquals(readPayload.ok, true);

  const hybridResponse = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.HYBRID_RETRIEVE,
      arguments: { query: "hosted runtime sync", plan_id: "plan-1" },
    },
  });
  const hybridPayload = extractToolResult(hybridResponse);
  assertEquals(hybridPayload.ok, true);

  const syncResponse = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.BRIDGE_SYNC,
      arguments: {
        plan_id: "plan-1",
        phase: "checkpoint",
        outcome: "success",
        summary: "Checkpointed the hosted runtime bridge flow.",
      },
    },
  });
  const syncPayload = extractToolResult(syncResponse);
  assertEquals(syncPayload.ok, true);

  const handoffResponse = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.REFLECTION_HANDOFF,
      arguments: {
        plan_id: "plan-1",
        summary: "Send the runtime trace into reflection.",
      },
    },
  });
  const handoffPayload = extractToolResult(handoffResponse);
  assertEquals(handoffPayload.ok, true);
  assertEquals(fakeMemory.calls, ["planStateRead", "hybridRetrieve", "bridgeSync", "reflectionHandoff"]);
});

Deno.test("live runtime tool errors preserve explicit gateway error codes", async () => {
  const config = buildConfig({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "live",
    },
  });
  const fakeMemory = new FakeMemoryService(config, createLogger("error"));
  fakeMemory.throwOnRead = true;
  const handler = buildHandler({
    DUAL_BRAIN_CONTRACT_TOOLS: {
      plan_state: "live",
    },
  }, fakeMemory);

  const response = await handler.handleRaw({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: CONTRACT_TOOL_NAMES.PLAN_STATE_READ,
      arguments: { plan_id: "plan-404" },
    },
  });

  const payload = extractToolError(response);
  assertEquals(payload.error.code, "plan_state_not_found");
  assertEquals(payload.error.details.plan_id, "plan-404");
});
