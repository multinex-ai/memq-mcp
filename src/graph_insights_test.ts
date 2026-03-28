import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTemporalWindowQuery,
  parseCompactTable,
  parseInsightPreset,
  renderGraphInsightMarkdown,
  splitTelegramMessages,
} from "./graph_insights.ts";

Deno.test("parseCompactTable decodes compact rows", () => {
  const response = [
    [[1, "entity"], [1, "mentions"]],
    [
      [[2, "billing"], [3, 7]],
      [[2, "graphiti"], [3, 4]],
    ],
  ];

  assertEquals(parseCompactTable(response), {
    columns: ["entity", "mentions"],
    rows: [["billing", 7], ["graphiti", 4]],
  });
});

Deno.test("renderGraphInsightMarkdown includes contract modes", () => {
  const markdown = renderGraphInsightMarkdown({
    generated_at: "2026-03-19T00:00:00.000Z",
    graph: "mnemosyne",
    preset: "all",
    rollout_contract: {
      plan_state: "live",
      slice_projection: "live",
      hybrid_retrieval: "live",
      bridge_sync: "live",
      reflection_handoff: "live",
      temporal_graph: "live",
    },
    sections: [{ key: "overview", title: "overview", lines: ["Total memories: 12"] }],
  });

  assertStringIncludes(markdown, "Contract modes: plan_state=live");
  assertStringIncludes(markdown, "## overview");
});

Deno.test("splitTelegramMessages chunks long output safely", () => {
  const source = ["line".repeat(300), "line".repeat(300), "tail"].join("\n");
  const chunks = splitTelegramMessages(source, 700);
  assertEquals(chunks.every((chunk) => chunk.length <= 700), true);
  assertEquals(chunks.join(""), source);
});

Deno.test("buildTemporalWindowQuery includes requested terms", () => {
  const query = buildTemporalWindowQuery("billing timeline", 5);
  assertStringIncludes(query, "MATCH (f:TemporalFact)");
  assertStringIncludes(query, 'toLower(f.summary) CONTAINS "billing"');
  assertStringIncludes(query, 'toLower(f.summary) CONTAINS "timeline"');
});

Deno.test("parseInsightPreset defaults to all", () => {
  assertEquals(parseInsightPreset(undefined), "all");
});
