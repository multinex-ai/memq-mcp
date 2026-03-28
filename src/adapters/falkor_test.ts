import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTemporalGraphQuery,
  matchesHotMemoryText,
  parseCompactGraphRows,
  parseTemporalGraphRows,
} from "./falkor.ts";

Deno.test("parseCompactGraphRows decodes compact Falkor values into canonical memory rows", () => {
  const response = [
    [
      [1, "m.id"],
      [1, "agent"],
      [1, "type"],
      [1, "task"],
      [1, "tags"],
      [1, "text"],
      [1, "created_at"],
    ],
    [
      [
        [2, "2456dbf8-f547-45a1-892d-f72f8d8b9a66"],
        [2, "archon"],
        [2, "procedural"],
        [2, "mnemosyne-demo-001"],
        [6, [[2, "release"], [2, "gateway"], [2, "replay"], [2, "demo"]]],
        [2, "Pinned the Mnemosyne gateway release image to GHCR v2.5.0."],
        [2, "2026-03-13T04:40:25.506Z"],
      ],
      [
        [2, "b09cb16b-8870-4475-b7ab-f374fa21df76"],
        [2, "mnemon"],
        [2, "reflection"],
        [1, null],
        [6, [[2, "reflection"], [2, "checkpoint"]]],
        [2, "Reflection checkpoint."],
        [2, "2026-03-13T04:40:29.015Z"],
      ],
    ],
  ];

  const rows = parseCompactGraphRows(response);
  assertEquals(rows, [
    {
      id: "2456dbf8-f547-45a1-892d-f72f8d8b9a66",
      agent_id: "archon",
      memory_type: "procedural",
      task_id: "mnemosyne-demo-001",
      tags: ["release", "gateway", "replay", "demo"],
      text: "Pinned the Mnemosyne gateway release image to GHCR v2.5.0.",
      created_at: "2026-03-13T04:40:25.506Z",
    },
    {
      id: "b09cb16b-8870-4475-b7ab-f374fa21df76",
      agent_id: "mnemon",
      memory_type: "reflection",
      task_id: null,
      tags: ["reflection", "checkpoint"],
      text: "Reflection checkpoint.",
      created_at: "2026-03-13T04:40:29.015Z",
    },
  ]);
});

Deno.test("matchesHotMemoryText matches reordered multi-term queries across recent memory text", () => {
  const text = "Pinned the Mnemosyne gateway release image to GHCR v2.5.0 and kept Soul Journal replay isolated.";

  assertEquals(matchesHotMemoryText(text, "gateway replay image"), true);
  assertEquals(matchesHotMemoryText(text, "gateway missing-term"), false);
  assertEquals(matchesHotMemoryText(text, "gateway"), true);
});

Deno.test("parseTemporalGraphRows decodes temporal fact rows including evidence ids", () => {
  const response = [
    [
      [1, "subject_id"],
      [1, "relation_type"],
      [1, "object_id"],
      [1, "summary"],
      [1, "valid_at"],
      [1, "observed_at"],
      [1, "valid_until"],
      [1, "sort_ts"],
      [1, "evidence_ids"],
      [1, "episode_id"],
      [1, "source_memory_id"],
      [1, "plan_id"],
    ],
    [[
      [2, "project-alpha"],
      [2, "depends_on"],
      [2, "service-auth"],
      [2, "Project Alpha depended on the auth service."],
      [2, "2026-03-17T10:00:00.000Z"],
      [2, "2026-03-17T10:05:00.000Z"],
      [1, null],
      [2, "2026-03-17T10:05:00.000Z"],
      [6, [[2, "2456dbf8-f547-45a1-892d-f72f8d8b9a66"]]],
      [2, "episode-1"],
      [2, "2456dbf8-f547-45a1-892d-f72f8d8b9a66"],
      [2, "plan-7"],
    ]],
  ];

  assertEquals(parseTemporalGraphRows(response), [{
    subject_id: "project-alpha",
    relation_type: "depends_on",
    object_id: "service-auth",
    summary: "Project Alpha depended on the auth service.",
    valid_at: "2026-03-17T10:00:00.000Z",
    observed_at: "2026-03-17T10:05:00.000Z",
    valid_until: null,
    sort_ts: "2026-03-17T10:05:00.000Z",
    evidence_ids: ["2456dbf8-f547-45a1-892d-f72f8d8b9a66"],
    episode_id: "episode-1",
    source_memory_id: "2456dbf8-f547-45a1-892d-f72f8d8b9a66",
    plan_id: "plan-7",
    graphiti_namespace: null,
    weight: null,
  }]);
});

Deno.test("buildTemporalGraphQuery includes plan, subject, relation, and time filters", () => {
  const query = buildTemporalGraphQuery({
    query: "project auth timeline",
    plan_id: "plan-7",
    subject_ids: ["project-alpha"],
    relation_types: ["depends_on"],
    time_range: {
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-03-31T23:59:59.000Z",
    },
    limit: 10,
    include_evidence: true,
  }, 30);

  assertEquals(query.includes("MATCH (f:TemporalFact)"), true);
  assertEquals(query.includes('f.plan_id = "plan-7"'), true);
  assertEquals(query.includes('f.subject_id IN ["project-alpha"]'), true);
  assertEquals(query.includes('f.relation_type IN ["depends_on"]'), true);
  assertEquals(query.includes('toLower(f.summary) CONTAINS "project"'), true);
  assertEquals(query.includes('toLower(f.summary) CONTAINS "auth"'), true);
  assertEquals(query.includes('toLower(f.summary) CONTAINS "timeline"'), true);
  assertEquals(
    query.includes('coalesce(f.valid_until, f.observed_at, f.valid_at, f.sort_ts) >= "2026-03-01T00:00:00.000Z"'),
    true,
  );
  assertEquals(query.includes('coalesce(f.valid_at, f.observed_at, f.sort_ts) <= "2026-03-31T23:59:59.000Z"'), true);
  assertEquals(query.endsWith("LIMIT 30"), true);
});
