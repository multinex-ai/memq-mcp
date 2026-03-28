import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectReplayCandidates, type ReplayCandidate } from "./replay_policy.ts";

const baseCandidates: ReplayCandidate[] = [
  {
    id: "recent-low-signal",
    agent_id: "agent",
    memory_type: "episodic",
    task_id: null,
    tags: ["note"],
    text: "Observed nominal activity and routine state.",
    created_at: "2026-03-11T12:04:00Z"
  },
  {
    id: "failure-procedure",
    agent_id: "agent",
    memory_type: "procedural",
    task_id: "task-1",
    tags: ["protocol", "failure"],
    text: "The deploy failed after a regression. Agents should pin the gateway image before rollout.",
    created_at: "2026-03-11T12:03:00Z"
  },
  {
    id: "constraint",
    agent_id: "agent",
    memory_type: "semantic",
    task_id: "task-1",
    tags: ["constraint", "auth"],
    text: "The gateway must not allow unauthenticated writes and should require billing validation.",
    created_at: "2026-03-11T12:02:00Z"
  },
  {
    id: "contradiction",
    agent_id: "agent",
    memory_type: "semantic",
    task_id: "task-1",
    tags: ["contradiction"],
    text: "The previous release notes are stale and no longer valid after the protocol change.",
    created_at: "2026-03-11T12:01:00Z"
  }
];

Deno.test("priority replay surfaces high-signal failure and constraint memories", () => {
  const selection = selectReplayCandidates(baseCandidates, {
    mode: "priority_deterministic",
    maxSources: 2,
    tieEpsilon: 0.01
  });

  assertEquals(selection.selected.length, 2);
  assertEquals(selection.selected[0]?.id, "failure-procedure");
  assert(selection.selected.some((candidate) => candidate.id === "constraint"));
  assert(selection.diagnostics.top_signals.failure >= 1);
  assert(selection.diagnostics.top_signals.procedure >= 1);
});

Deno.test("priority replay prng tie-break is stable for the same candidate set", () => {
  const tieCandidates: ReplayCandidate[] = [
    {
      id: "a",
      agent_id: "agent",
      memory_type: "episodic",
      task_id: null,
      tags: [],
      text: "Routine note with neutral value.",
      created_at: "2026-03-11T12:00:00Z"
    },
    {
      id: "b",
      agent_id: "agent",
      memory_type: "episodic",
      task_id: null,
      tags: [],
      text: "Routine note with neutral value.",
      created_at: "2026-03-11T12:00:00Z"
    },
    {
      id: "c",
      agent_id: "agent",
      memory_type: "episodic",
      task_id: null,
      tags: [],
      text: "Routine note with neutral value.",
      created_at: "2026-03-11T12:00:00Z"
    }
  ];

  const first = selectReplayCandidates(tieCandidates, {
    mode: "priority_prng",
    maxSources: 2,
    tieEpsilon: 1
  });
  const second = selectReplayCandidates(tieCandidates, {
    mode: "priority_prng",
    maxSources: 2,
    tieEpsilon: 1
  });

  assertEquals(first.selected.map((candidate) => candidate.id), second.selected.map((candidate) => candidate.id));
  assertEquals(first.diagnostics.strategy, "priority_prng_tiebreak");
});

Deno.test("priority replay quantum tie-break honors provided entropy sample", () => {
  const tieCandidates: ReplayCandidate[] = [
    {
      id: "a",
      agent_id: "agent",
      memory_type: "episodic",
      task_id: null,
      tags: [],
      text: "Routine note with neutral value.",
      created_at: "2026-03-11T12:00:00Z"
    },
    {
      id: "b",
      agent_id: "agent",
      memory_type: "episodic",
      task_id: null,
      tags: [],
      text: "Routine note with neutral value.",
      created_at: "2026-03-11T12:00:00Z"
    }
  ];

  const selection = selectReplayCandidates(tieCandidates, {
    mode: "priority_quantum",
    maxSources: 1,
    tieEpsilon: 1,
    quantumSample: {
      mode: "external",
      provider: "anu",
      source: "anu",
      raw_hex: "ffffffff00000000",
      sample_bits: 64,
      unit_interval: 0.91,
      acquired_at: "2026-03-11T12:00:00Z"
    }
  });

  assertEquals(selection.selected.length, 1);
  assertEquals(selection.diagnostics.strategy, "priority_quantum_tiebreak");
  assert(selection.diagnostics.quantum_sample !== null);
});
