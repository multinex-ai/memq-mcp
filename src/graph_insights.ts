import { z } from "zod";
import { buildTemporalGraphQuery, parseTemporalGraphRows } from "./adapters/falkor.ts";

type CompactScalar = [number, unknown];

function isCompactScalar(value: unknown): value is CompactScalar {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number";
}

function decodeCompactValue(value: unknown): unknown {
  if (!isCompactScalar(value)) return value;

  const [kind, payload] = value;
  switch (kind) {
    case 1:
      return payload ?? null;
    case 2:
      return typeof payload === "string" ? payload : String(payload ?? "");
    case 3:
    case 4: {
      const numeric = typeof payload === "number" ? payload : Number(payload ?? 0);
      return Number.isFinite(numeric) ? numeric : 0;
    }
    case 5:
      return Boolean(payload);
    case 6:
      return Array.isArray(payload) ? payload.map((entry) => decodeCompactValue(entry)) : [];
    default:
      return payload;
  }
}

export type GraphQueryResult = {
  columns: string[];
  rows: unknown[][];
};

export function parseCompactTable(response: unknown): GraphQueryResult {
  if (!Array.isArray(response) || response.length < 2) {
    return { columns: [], rows: [] };
  }

  const rawColumns = Array.isArray(response[0]) ? response[0] : [];
  const rawRows = Array.isArray(response[1]) ? response[1] : [];

  const columns = rawColumns.map((column) => {
    const decoded = decodeCompactValue(column);
    return typeof decoded === "string" ? decoded : String(decoded ?? "");
  });

  const rows = rawRows.map((row) =>
    Array.isArray(row) ? row.map((cell) => decodeCompactValue(cell)) : []
  );

  return { columns, rows };
}

const insightPresetSchema = z.enum([
  "overview",
  "top-entities",
  "agent-activity",
  "temporal-relations",
  "episodes",
  "recent-reflections",
  "all",
]);

export type InsightPreset = z.infer<typeof insightPresetSchema>;

export const insightSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  lines: z.array(z.string()),
});

export type InsightSection = z.infer<typeof insightSectionSchema>;

export const graphInsightReportSchema = z.object({
  generated_at: z.string(),
  graph: z.string(),
  preset: insightPresetSchema,
  sections: z.array(insightSectionSchema),
  rollout_contract: z.object({
    plan_state: z.string(),
    slice_projection: z.string(),
    hybrid_retrieval: z.string(),
    bridge_sync: z.string(),
    reflection_handoff: z.string(),
    temporal_graph: z.string(),
  }),
});

export type GraphInsightReport = z.infer<typeof graphInsightReportSchema>;

export type RolloutContractModes = GraphInsightReport["rollout_contract"];

function toCountRow(table: GraphQueryResult): number {
  const first = table.rows[0]?.[0];
  return typeof first === "number" ? first : Number(first ?? 0);
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

type QueryFactory = {
  cypher: string;
  formatter: (table: GraphQueryResult) => string[];
};

export const GRAPH_INSIGHT_QUERIES: Record<Exclude<InsightPreset, "all">, QueryFactory[]> = {
  overview: [
    {
      cypher: "MATCH (m:Memory) RETURN count(m)",
      formatter: (table) => [`Total memories: ${toCountRow(table)}`],
    },
    {
      cypher: "MATCH (:Agent)-[r:AUTHORED]->(:Memory) RETURN count(r)",
      formatter: (table) => [`Authored links: ${toCountRow(table)}`],
    },
    {
      cypher: "MATCH (:Memory)-[r:REFLECTS_ON]->(:Memory) RETURN count(r)",
      formatter: (table) => [`Reflection links: ${toCountRow(table)}`],
    },
    {
      cypher: "MATCH (:Memory)-[r:MENTIONS]->(:Entity) RETURN count(r)",
      formatter: (table) => [`Entity mention links: ${toCountRow(table)}`],
    },
    {
      cypher: "MATCH (f:TemporalFact) RETURN count(f)",
      formatter: (table) => [`Temporal facts: ${toCountRow(table)}`],
    },
  ],
  "top-entities": [{
    cypher:
      "MATCH (m:Memory)-[:MENTIONS]->(e:Entity) RETURN e.name, count(m) AS mentions ORDER BY mentions DESC LIMIT 10",
    formatter: (table) =>
      table.rows.length === 0
        ? ["No entity mentions captured yet."]
        : table.rows.map((row, index) => `${index + 1}. ${toString(row[0])} — ${toNumber(row[1])} mentions`),
  }],
  "agent-activity": [{
    cypher:
      "MATCH (a:Agent)-[:AUTHORED]->(m:Memory) RETURN a.id, count(m) AS memories ORDER BY memories DESC LIMIT 10",
    formatter: (table) =>
      table.rows.length === 0
        ? ["No authored memories captured yet."]
        : table.rows.map((row, index) => `${index + 1}. ${toString(row[0])} — ${toNumber(row[1])} memories`),
  }],
  "temporal-relations": [{
    cypher:
      "MATCH (f:TemporalFact) RETURN f.relation_type, count(f) AS relations ORDER BY relations DESC LIMIT 10",
    formatter: (table) =>
      table.rows.length === 0
        ? ["No temporal relations captured yet."]
        : table.rows.map((row, index) => `${index + 1}. ${toString(row[0])} — ${toNumber(row[1])} facts`),
  }],
  episodes: [{
    cypher:
      "MATCH (f:TemporalFact)-[:IN_EPISODE]->(ep:Episode) RETURN ep.id, ep.plan_id, ep.graphiti_namespace, count(f) AS facts ORDER BY facts DESC LIMIT 10",
    formatter: (table) =>
      table.rows.length === 0
        ? ["No episodes captured yet."]
        : table.rows.map((row, index) =>
          `${index + 1}. ${toString(row[0])} — plan=${toString(row[1] || "none")} namespace=${
            toString(row[2] || "none")
          } facts=${toNumber(row[3])}`
        ),
  }],
  "recent-reflections": [{
    cypher:
      "MATCH (r:Memory)-[:REFLECTS_ON]->(m:Memory) RETURN r.created_at, left(r.text, 120), m.id ORDER BY r.created_at DESC LIMIT 8",
    formatter: (table) =>
      table.rows.length === 0
        ? ["No reflection links captured yet."]
        : table.rows.map((row, index) =>
          `${index + 1}. ${toString(row[0])} — ${toString(row[1])} (source ${toString(row[2])})`
        ),
  }],
};

export function presetKeys(preset: InsightPreset): Array<Exclude<InsightPreset, "all">> {
  return preset === "all"
    ? ["overview", "top-entities", "agent-activity", "temporal-relations", "episodes", "recent-reflections"]
    : [preset];
}

export function renderGraphInsightMarkdown(report: GraphInsightReport): string {
  const lines: string[] = [
    `# Mnemosyne Graph Insights`,
    ``,
    `Generated: ${report.generated_at}`,
    `Graph: ${report.graph}`,
    `Preset: ${report.preset}`,
    ``,
    `Contract modes: plan_state=${report.rollout_contract.plan_state}, slice_projection=${report.rollout_contract.slice_projection}, hybrid_retrieval=${report.rollout_contract.hybrid_retrieval}, bridge_sync=${report.rollout_contract.bridge_sync}, reflection_handoff=${report.rollout_contract.reflection_handoff}, temporal_graph=${report.rollout_contract.temporal_graph}`,
  ];

  for (const section of report.sections) {
    lines.push("", `## ${section.title}`);
    lines.push(...section.lines);
  }

  return `${lines.join("\n")}\n`;
}

export function splitTelegramMessages(markdown: string, maxLength = 3500): string[] {
  if (markdown.length <= maxLength) return [markdown];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const remaining = markdown.length - cursor;
    if (remaining <= maxLength) {
      chunks.push(markdown.slice(cursor));
      break;
    }

    const window = markdown.slice(cursor, cursor + maxLength);
    const preferredBreak = window.lastIndexOf("\n");
    const splitAt = preferredBreak > 0 ? cursor + preferredBreak + 1 : cursor + maxLength;
    chunks.push(markdown.slice(cursor, splitAt));
    cursor = splitAt;
  }

  return chunks;
}

export function formatTemporalRowsForSection(
  title: string,
  rows: ReturnType<typeof parseTemporalGraphRows>,
): InsightSection {
  return {
    key: "temporal-window",
    title,
    lines: rows.length === 0
      ? ["No temporal rows matched."]
      : rows.slice(0, 10).map((row, index) =>
        `${index + 1}. ${row.subject_id} -[${row.relation_type}]-> ${row.object_id ?? "null"} @ ${
          row.sort_ts ?? row.observed_at ?? row.valid_at ?? "unknown"
        }`
      ),
  };
}

export function parseInsightPreset(value: string | undefined): InsightPreset {
  return insightPresetSchema.parse(value ?? "all");
}

export function buildTemporalWindowQuery(query: string, limit: number) {
  return buildTemporalGraphQuery({
    query,
    limit,
    include_evidence: true,
  }, Math.max(limit, 10));
}
