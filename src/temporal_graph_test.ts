import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeTemporalSearchBonus,
  extractTemporalFacts,
  queryHasTemporalIntent,
  rankTemporalGraphRows,
  summarizeTemporalMetadata,
} from "./temporal_graph.ts";

Deno.test("extractTemporalFacts normalizes Graphiti-style metadata containers", () => {
  const memoryId = "2456dbf8-f547-45a1-892d-f72f8d8b9a66";
  const facts = extractTemporalFacts({
    graphiti: {
      episode_id: "episode-9",
      namespace: "delivery",
      facts: [{
        subject: { id: "project-alpha" },
        relation: "depends_on",
        object: { id: "service-auth" },
        summary: "Project Alpha depends on the auth service.",
        observedAt: "2026-03-17T10:05:00.000Z",
        validAt: "2026-03-17T10:00:00.000Z",
      }],
    },
  }, {
    fallbackText: "fallback",
    fallbackEvidenceId: memoryId,
    defaultPlanId: "plan-7",
  });

  assertEquals(facts.length, 1);
  assertEquals(facts[0], {
    subject_id: "project-alpha",
    relation_type: "depends_on",
    object_id: "service-auth",
    summary: "Project Alpha depends on the auth service.",
    valid_at: "2026-03-17T10:00:00.000Z",
    observed_at: "2026-03-17T10:05:00.000Z",
    valid_until: null,
    evidence_ids: [memoryId],
    episode_id: "episode-9",
    plan_id: "plan-7",
    graphiti_namespace: "delivery",
    weight: null,
  });
});

Deno.test("temporal metadata summary and search bonus detect temporal intent", () => {
  const createdAt = "2026-03-17T10:00:00.000Z";
  const metadata = {
    temporal_graph: {
      facts: [{
        subject_id: "project-alpha",
        relation_type: "deployed_to",
        object_id: "cluster-prod",
        summary: "Project Alpha deployed to prod.",
        observed_at: "2026-03-17T10:05:00.000Z",
        evidence_ids: ["2456dbf8-f547-45a1-892d-f72f8d8b9a66"],
      }],
    },
  };

  const summary = summarizeTemporalMetadata(metadata, createdAt);
  assertEquals(summary.hasTemporalFacts, true);
  assertEquals(summary.factCount, 1);
  assertEquals(summary.evidenceCount, 1);
  assertEquals(summary.latestTimestamp, "2026-03-17T10:05:00.000Z");
  assertEquals(queryHasTemporalIntent("latest deployment timeline"), true);

  const bonus = computeTemporalSearchBonus(metadata, createdAt, "latest deployment timeline");
  assertEquals(bonus.hasTemporalFacts, true);
  assertEquals(bonus.bonus > 0.08, true);
});

Deno.test("rankTemporalGraphRows filters by time window and preserves evidence opt-in", () => {
  const results = rankTemporalGraphRows([
    {
      subject_id: "project-alpha",
      relation_type: "depends_on",
      object_id: "service-auth",
      summary: "Project Alpha depends on the auth service.",
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
    },
    {
      subject_id: "project-alpha",
      relation_type: "depends_on",
      object_id: "service-legacy",
      summary: "Legacy dependency from the previous quarter.",
      valid_at: "2025-12-01T10:00:00.000Z",
      observed_at: "2025-12-01T10:05:00.000Z",
      valid_until: null,
      sort_ts: "2025-12-01T10:05:00.000Z",
      evidence_ids: [],
      episode_id: "episode-0",
      source_memory_id: "b09cb16b-8870-4475-b7ab-f374fa21df76",
      plan_id: "plan-7",
      graphiti_namespace: null,
      weight: null,
    },
  ], {
    query: "project alpha auth dependency",
    plan_id: "plan-7",
    subject_ids: ["project-alpha"],
    relation_types: ["depends_on"],
    time_range: {
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-03-31T23:59:59.000Z",
    },
    limit: 10,
    include_evidence: false,
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].object_id, "service-auth");
  assertEquals(results[0].evidence_ids, undefined);
  assertEquals((results[0].score ?? 0) > 0.7, true);
});
