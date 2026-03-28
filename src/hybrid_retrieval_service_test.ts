import { assertEquals, assertGreater } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadConfig } from "./config.ts";
import { HybridRetrievalService } from "./hybrid_retrieval_service.ts";

Deno.test("hybrid retrieval fuses vector graph hot and journal results with filters", async () => {
  const config = loadConfig();
  const service = new HybridRetrievalService(config, {
    embedQuery: () => [1, 0, 0, 0],
    vectorSearch: async () => [{
      id: "memory-1",
      agent_id: "archon",
      memory_type: "procedural",
      task_id: "task-1",
      tags: ["release", "vector"],
      text: "Pinned the vector-backed slice runtime collection before rollout.",
      created_at: "2026-03-17T12:00:00.000Z",
      content_hash: "hash-1",
      reinforcement_count: 3,
      metadata: {},
      embedding: [1, 0, 0, 0],
      similarity: 0.96,
    }],
    graphSearch: async () => [{
      id: "memory-1",
      agent_id: "archon",
      memory_type: "procedural",
      task_id: "task-1",
      tags: ["release", "graph"],
      text: "Pinned the vector-backed slice runtime collection before rollout.",
      created_at: "2026-03-17T12:00:00.000Z",
    }],
    hotSearch: async () => [{
      id: "memory-2",
      agent_id: "archon",
      memory_type: "procedural",
      task_id: "task-1",
      tags: ["release", "hot"],
      text: "Recent hot memory captured the rollout guardrail for slice storage.",
      created_at: "2026-03-17T12:05:00.000Z",
    }],
    journalSearch: async () => [{
      id: "memory-3",
      agent_id: "mnemon",
      memory_type: "checkpoint",
      task_id: null,
      tags: ["journal"],
      text: "The journal recorded a projection checkpoint for the runtime slice layer.",
      content_hash: "hash-3",
      created_at: "2026-03-17T12:10:00.000Z",
    }],
    planStateSearch: async () => [],
  });

  const result = await service.retrieve({
    query: "slice runtime rollout",
    namespace: "runtime",
    fusion_strategy: "memory_first",
    include_scores: true,
    filters: { memory_type: "procedural" },
    top_k: 5,
  });

  assertEquals(result.scanned_sources, ["vector", "graph", "hot", "journal"]);
  assertEquals(result.results.length, 2);
  assertEquals(result.results[0]?.id, "memory-1");
  assertGreater(Number(result.results[0]?.score ?? 0), 0.9);
  assertEquals(result.results[0]?.channels, ["vector", "graph"]);
  assertEquals(result.results[1]?.source, "hot");
});

Deno.test("hybrid retrieval includes plan-state rows when a plan id is present", async () => {
  const config = loadConfig();
  const service = new HybridRetrievalService(config, {
    embedQuery: () => [1, 0, 0, 0],
    vectorSearch: async () => [],
    graphSearch: async () => [],
    hotSearch: async () => [],
    journalSearch: async () => [],
    planStateSearch: async () => [{
      id: "plan-1",
      plan_id: "plan-1",
      namespace: "runtime",
      status: "active",
      checkpoint_id: "checkpoint-1",
      thread_id: "thread-1",
      state_version: 4,
      title: "Roll out the hosted runtime tools",
      text: "Plan state tracks bridge sync, checkpoint handoff, and reflection readiness for the hosted runtime tools.",
      created_at: "2026-03-17T12:15:00.000Z",
      task_id: "plan-1",
      tags: ["plan_state", "active"],
    }],
  });

  const result = await service.retrieve({
    query: "hosted runtime bridge handoff",
    plan_id: "plan-1",
    namespace: "runtime",
    fusion_strategy: "plan_first",
    include_scores: true,
    top_k: 3,
  });

  assertEquals(result.scanned_sources, ["plan_state", "vector", "graph", "hot", "journal"]);
  assertEquals(result.results.length, 1);
  assertEquals(result.results[0]?.source, "plan_state");
  assertEquals(result.results[0]?.metadata.plan_id, "plan-1");
  assertGreater(Number(result.results[0]?.score ?? 0), 0.6);
});
