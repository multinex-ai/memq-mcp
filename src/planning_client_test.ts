import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AppConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { GatewayToolError } from "./errors.ts";
import { PlanningClient } from "./planning_client.ts";

function buildConfig(journalPath: string): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    SOUL_JOURNAL_PATH: journalPath,
    LOG_LEVEL: "error",
  };
}

Deno.test("planning client supports write read checkpoint and resume flows", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "mnx-plan-state-" });
  try {
    const config = buildConfig(`${tempDir}/journal.jsonl`);
    const client = new PlanningClient(config);

    const initialWrite = await client.writeState({
      plan_id: "plan-1",
      namespace: "runtime",
      status: "active",
      summary: "Begin the hosted runtime implementation",
      state_patch: {
        step: "implement",
        thread_id: "thread-1",
        messages: [{ role: "system", content: "Start the runtime bridge." }],
        artifacts: [{ kind: "note", value: "checkpoint candidate" }],
      },
      metadata: { owner: "gateway" },
      tags: ["runtime"],
    });

    assertEquals(initialWrite.state_version, 1);
    assertEquals(initialWrite.status, "active");

    const snapshot = await client.readSnapshot({
      plan_id: "plan-1",
      namespace: "runtime",
      include_messages: true,
      include_artifacts: true,
    });
    assertEquals(snapshot.thread_id, "thread-1");
    assertEquals(snapshot.state.step, "implement");
    assertEquals(snapshot.messages?.length, 1);
    assertEquals(snapshot.artifacts?.length, 1);

    const checkpoint = await client.createCheckpoint({
      plan_id: "plan-1",
      namespace: "runtime",
      label: "before-sync",
      summary: "Store the pre-sync plan state",
      include_state: true,
      metadata: { checkpoint: "before-sync" },
    });

    assertEquals(checkpoint.status, "checkpointed");
    assertEquals(checkpoint.state_version, 2);

    const mutatedWrite = await client.writeState({
      plan_id: "plan-1",
      namespace: "runtime",
      expected_state_version: checkpoint.state_version ?? 0,
      status: "active",
      summary: "Bridge sync mutates the working state",
      state_patch: {
        step: "mutated",
        thread_id: "thread-2",
        messages: [{ role: "assistant", content: "Mutated after checkpoint." }],
      },
      metadata: { owner: "bridge" },
      tags: ["bridge_sync"],
    });

    assertEquals(mutatedWrite.state_version, 3);

    const resumed = await client.resume({
      plan_id: "plan-1",
      namespace: "runtime",
      checkpoint_id: checkpoint.checkpoint_id,
      target_thread_id: "thread-restored",
      resume_reason: "Restore checkpoint before reflection handoff",
    });

    assertEquals(resumed.status, "active");
    assertEquals(resumed.thread_id, "thread-restored");
    assertEquals(resumed.state_version, 4);

    const restoredSnapshot = await client.readSnapshot({
      plan_id: "plan-1",
      namespace: "runtime",
      include_messages: true,
      include_artifacts: true,
    });

    assertEquals(restoredSnapshot.state.step, "implement");
    assertEquals(restoredSnapshot.messages?.[0]?.content, "Start the runtime bridge.");
    assertEquals(restoredSnapshot.checkpoint_id, checkpoint.checkpoint_id);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("planning client enforces expected state version conflicts", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "mnx-plan-version-" });
  try {
    const config = buildConfig(`${tempDir}/journal.jsonl`);
    const client = new PlanningClient(config);

    await client.writeState({
      plan_id: "plan-2",
      namespace: "runtime",
      status: "active",
      summary: "Seed plan state",
      state_patch: { step: "seed" },
      metadata: {},
      tags: [],
    });

    await assertRejects(
      () =>
        client.writeState({
          plan_id: "plan-2",
          namespace: "runtime",
          expected_state_version: 99,
          state_patch: { step: "conflict" },
          metadata: {},
          tags: [],
        }),
      GatewayToolError,
      "Expected state version 99 but found 1.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
