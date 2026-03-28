import { createClient, type RedisClientType } from "redis";
import type { AppConfig } from "../config.ts";
import type { MemoryRecord, TemporalGraphQueryInput } from "../types.ts";
import { extractTemporalFacts, type TemporalGraphRow, temporalPrimaryTimestamp } from "../temporal_graph.ts";
import type { Logger } from "../utils.ts";
import { withRetry } from "../utils.ts";

function esc(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function cypherNullableString(value: string | null | undefined): string {
  return typeof value === "string" ? `\"${esc(value)}\"` : "null";
}

function cypherStringArray(values: string[]): string {
  return `[${values.map((value) => `\"${esc(value)}\"`).join(",")}]`;
}

type CompactScalar = [number, unknown];

function isCompactScalar(value: unknown): value is CompactScalar {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number";
}

function decodeCompactValue(value: unknown): unknown {
  if (!isCompactScalar(value)) {
    return value;
  }

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
      if (Array.isArray(payload)) {
        return payload.map((entry) => decodeCompactValue(entry));
      }
      return payload;
  }
}

function tokenizeHotSearchQuery(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length > 1);
}

export function matchesHotMemoryText(text: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return false;
  }

  const normalizedText = text.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) {
    return true;
  }

  const terms = tokenizeHotSearchQuery(normalizedQuery);
  return terms.length > 0 && terms.every((term) => normalizedText.includes(term));
}

export function parseCompactGraphRows(response: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(response) || response.length < 2) return [];
  const rows = response[1];
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const values = Array.isArray(row) ? row.map((cell) => decodeCompactValue(cell)) : [];
    return {
      id: typeof values[0] === "string" ? values[0] : "",
      agent_id: typeof values[1] === "string" ? values[1] : "unknown",
      memory_type: typeof values[2] === "string" ? values[2] : "episodic",
      task_id: values[3] === null || values[3] === undefined ? null : String(values[3]),
      tags: Array.isArray(values[4]) ? values[4].map((tag) => String(tag)) : [],
      text: typeof values[5] === "string" ? values[5] : String(values[5] ?? ""),
      created_at: typeof values[6] === "string" ? values[6] : String(values[6] ?? ""),
    };
  });
}

export function parseTemporalGraphRows(response: unknown): TemporalGraphRow[] {
  if (!Array.isArray(response) || response.length < 2) return [];
  const rows = response[1];
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const values = Array.isArray(row) ? row.map((cell) => decodeCompactValue(cell)) : [];
    return {
      subject_id: typeof values[0] === "string" ? values[0] : "",
      relation_type: typeof values[1] === "string" ? values[1] : "",
      object_id: values[2] === null || values[2] === undefined ? null : String(values[2]),
      summary: typeof values[3] === "string" ? values[3] : String(values[3] ?? ""),
      valid_at: values[4] === null || values[4] === undefined ? null : String(values[4]),
      observed_at: values[5] === null || values[5] === undefined ? null : String(values[5]),
      valid_until: values[6] === null || values[6] === undefined ? null : String(values[6]),
      sort_ts: values[7] === null || values[7] === undefined ? null : String(values[7]),
      evidence_ids: Array.isArray(values[8]) ? values[8].map((value) => String(value)) : [],
      episode_id: values[9] === null || values[9] === undefined ? null : String(values[9]),
      source_memory_id: values[10] === null || values[10] === undefined ? null : String(values[10]),
      plan_id: values[11] === null || values[11] === undefined ? null : String(values[11]),
      graphiti_namespace: null,
      weight: null,
    };
  }).filter((row) => row.subject_id.length > 0 && row.relation_type.length > 0 && row.summary.length > 0);
}

export function buildTemporalGraphQuery(input: TemporalGraphQueryInput, limit: number): string {
  const normalizedQuery = input.query.trim().toLowerCase();
  const queryTerms = tokenizeHotSearchQuery(normalizedQuery);
  const phraseTerms = queryTerms.length > 0 ? queryTerms : [normalizedQuery];
  const textFilter = phraseTerms.map((term) => {
    const q = esc(term);
    return `(
      toLower(f.summary) CONTAINS \"${q}\" OR
      toLower(f.relation_type) CONTAINS \"${q}\" OR
      toLower(f.subject_id) CONTAINS \"${q}\" OR
      (f.object_id IS NOT NULL AND toLower(f.object_id) CONTAINS \"${q}\") OR
      (f.episode_id IS NOT NULL AND toLower(f.episode_id) CONTAINS \"${q}\")
    )`.replace(/\s+/g, " ");
  }).join(" AND ");
  const filters = [`(${textFilter})`];

  if (input.plan_id) {
    filters.push(`f.plan_id = \"${esc(input.plan_id)}\"`);
  }
  if (input.subject_ids && input.subject_ids.length > 0) {
    filters.push(`f.subject_id IN ${cypherStringArray(input.subject_ids)}`);
  }
  if (input.relation_types && input.relation_types.length > 0) {
    filters.push(`f.relation_type IN ${cypherStringArray(input.relation_types)}`);
  }
  if (input.time_range?.since) {
    filters.push(`coalesce(f.valid_until, f.observed_at, f.valid_at, f.sort_ts) >= \"${esc(input.time_range.since)}\"`);
  }
  if (input.time_range?.until) {
    filters.push(`coalesce(f.valid_at, f.observed_at, f.sort_ts) <= \"${esc(input.time_range.until)}\"`);
  }

  return [
    "MATCH (f:TemporalFact)",
    `WHERE ${filters.join(" AND ")}`,
    "RETURN f.subject_id, f.relation_type, f.object_id, f.summary, f.valid_at, f.observed_at, f.valid_until, f.sort_ts, f.evidence_ids, f.episode_id, f.source_memory_id, f.plan_id",
    "ORDER BY coalesce(f.sort_ts, f.observed_at, f.valid_at) DESC, f.summary ASC",
    `LIMIT ${Math.max(1, limit)}`,
  ].join(" ");
}

export class FalkorAdapter {
  private client: RedisClientType | null = null;
  private graphAvailable = true;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {}

  async init(): Promise<void> {
    this.client = createClient({
      url: this.config.FALKOR_REDIS_URL,
      socket: {
        connectTimeout: this.config.FALKOR_TIMEOUT_MS,
        reconnectStrategy: (retries) => Math.min(5000, 100 * 2 ** retries),
      },
    });

    this.client.on("error", (err) => {
      this.logger.warn("falkor_client_error", { error: String(err) });
    });

    await this.client.connect();

    try {
      for (const graphName of this.config.FALKOR_GRAPH_NAMES) {
        await this.command(["GRAPH.QUERY", graphName, "CREATE (:__Bootstrap {name:'ok'})", "--compact"]);
        await this.command(["GRAPH.QUERY", graphName, "MATCH (n:__Bootstrap) DELETE n", "--compact"]);
      }
      this.graphAvailable = true;
    } catch (error) {
      this.graphAvailable = false;
      this.logger.warn("falkor_graph_unavailable", {
        error: String(error),
        falkor_graph: this.config.FALKOR_GRAPH,
        graph_names: this.config.FALKOR_GRAPH_NAMES,
      });
    }
  }

  status(): Record<string, unknown> {
    return {
      primary_graph: this.config.FALKOR_GRAPH,
      graph_names: this.config.FALKOR_GRAPH_NAMES,
      mirrored: this.config.FALKOR_GRAPH_NAMES.length > 1,
      graph_available: this.graphAvailable,
    };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async health(): Promise<void> {
    await this.command(["PING"]);
  }

  async upsertMemory(record: MemoryRecord, entities: string[]): Promise<void> {
    if (!this.graphAvailable) {
      await this.getAndSetLatestMemoryId(record.id);
      return;
    }

    const tagList = record.tags.map((tag) => `\"${esc(tag)}\"`).join(",");
    const metadata = esc(JSON.stringify(record.metadata));
    const text = esc(record.text);
    const taskId = record.task_id ? `\"${esc(record.task_id)}\"` : "null";

    const query = [
      `MERGE (a:Agent {id:\"${esc(record.agent_id)}\"})`,
      `MERGE (m:Memory {id:\"${esc(record.id)}\"})`,
      `SET m.text=\"${text}\", m.memory_type=\"${
        esc(record.memory_type)
      }\", m.task_id=${taskId}, m.tags=[${tagList}], m.created_at=\"${esc(record.created_at)}\", m.content_hash=\"${
        esc(record.content_hash)
      }\", m.metadata=\"${metadata}\"`,
      "MERGE (a)-[:AUTHORED]->(m)",
      `WITH m MATCH (prev:Memory) WHERE prev.id <> \"${
        esc(record.id)
      }\" RETURN prev ORDER BY prev.created_at DESC LIMIT 1`,
    ].join(" ");

    await this.graphQueryAll(query);

    const prevId = await this.getAndSetLatestMemoryId(record.id);
    if (prevId && prevId !== record.id) {
      await this.graphQueryAll(
        `MATCH (p:Memory {id:\"${esc(prevId)}\"}), (m:Memory {id:\"${esc(record.id)}\"}) MERGE (p)-[:PRECEDES]->(m)`,
      );
    }

    for (const entity of entities) {
      await this.graphQueryAll(
        `MATCH (m:Memory {id:\"${esc(record.id)}\"}) MERGE (e:Entity {name:\"${
          esc(entity)
        }\"}) MERGE (m)-[:MENTIONS]->(e)`,
      );
    }

    const temporalFacts = extractTemporalFacts(record.metadata, {
      fallbackText: record.text,
      fallbackEvidenceId: record.id,
      defaultPlanId: record.task_id,
    });
    if (temporalFacts.length > 0) {
      await this.replaceTemporalFacts(record, temporalFacts);
    }
  }

  async linkReflection(reflectionId: string, sourceIds: string[]): Promise<void> {
    if (!this.graphAvailable) {
      return;
    }

    for (const sourceId of sourceIds) {
      await this.graphQueryAll(
        `MATCH (r:Memory {id:\"${esc(reflectionId)}\"}), (m:Memory {id:\"${
          esc(sourceId)
        }\"}) MERGE (r)-[:REFLECTS_ON]->(m)`,
      );
    }
  }

  async graphSearch(query: string, topK: number): Promise<Array<Record<string, unknown>>> {
    if (!this.graphAvailable) {
      return [];
    }

    const q = esc(query.toLowerCase());
    const cypher = [
      "MATCH (m:Memory)",
      "OPTIONAL MATCH (a:Agent)-[:AUTHORED]->(m)",
      "OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)",
      `WHERE toLower(m.text) CONTAINS \"${q}\" OR toLower(e.name) CONTAINS \"${q}\"`,
      "RETURN m.id, coalesce(a.id, 'unknown'), m.memory_type, m.task_id, m.tags, m.text, m.created_at",
      `LIMIT ${Math.max(1, topK)}`,
    ].join(" ");

    const rows = await Promise.all(this.config.FALKOR_GRAPH_NAMES.map(async (graphName) => {
      const response = await this.command(["GRAPH.QUERY", graphName, cypher, "--compact"]);
      return parseCompactGraphRows(response);
    }));
    const merged = new Map<string, Record<string, unknown>>();
    for (const group of rows) {
      for (const row of group) {
        const id = String(row.id ?? "");
        if (!id || merged.has(id)) continue;
        merged.set(id, row);
      }
    }
    return [...merged.values()].slice(0, topK);
  }

  async publishHotMemory(
    record: Pick<MemoryRecord, "id" | "agent_id" | "text" | "created_at" | "memory_type" | "task_id" | "tags"> & {
      deduped: boolean;
    },
  ): Promise<void> {
    const payload = {
      id: record.id,
      agent_id: record.agent_id,
      text: record.text,
      created_at: record.created_at,
      memory_type: record.memory_type,
      task_id: record.task_id,
      tags: record.tags,
      deduped: record.deduped ? "1" : "0",
    };
    const payloadText = JSON.stringify(payload);

    await this.command(["PUBLISH", "memory.events", payloadText]);
    const streamFields = Object.entries(payload).flatMap((
      [key, value],
    ) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]);
    await this.command(["XADD", "memory.stream", "MAXLEN", "~", "10000", "*", ...streamFields]);
    await this.command(["LPUSH", "memory.recent", payloadText]);
    await this.command(["LTRIM", "memory.recent", "0", "499"]);
  }

  async hotSearch(query: string, topK: number): Promise<Array<Record<string, unknown>>> {
    const items = await this.command(["LRANGE", "memory.recent", "0", "500"]);
    const out: Array<Record<string, unknown>> = [];

    const list = Array.isArray(items) ? items : [];
    for (const item of list) {
      try {
        const parsed = JSON.parse(String(item)) as Record<string, unknown>;
        const text = String(parsed.text ?? "");
        if (matchesHotMemoryText(text, query)) {
          out.push({
            id: String(parsed.id ?? ""),
            agent_id: String(parsed.agent_id ?? "unknown"),
            memory_type: String(parsed.memory_type ?? "episodic"),
            task_id: parsed.task_id === null || parsed.task_id === undefined ? null : String(parsed.task_id),
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)) : [],
            text,
            created_at: String(parsed.created_at ?? ""),
          });
        }
        if (out.length >= topK) break;
      } catch {
        continue;
      }
    }
    return out;
  }

  async listRecent(limit: number): Promise<Array<Record<string, unknown>>> {
    const items = await this.command(["LRANGE", "memory.recent", "0", String(Math.max(0, limit - 1))]);
    const out: Array<Record<string, unknown>> = [];
    for (const item of Array.isArray(items) ? items : []) {
      try {
        out.push(JSON.parse(String(item)) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    return out;
  }

  async temporalGraphQuery(input: TemporalGraphQueryInput, limit: number): Promise<TemporalGraphRow[]> {
    if (!this.graphAvailable) {
      return [];
    }

    const rows = await Promise.all(this.config.FALKOR_GRAPH_NAMES.map(async (graphName) => {
      const response = await this.command([
        "GRAPH.QUERY",
        graphName,
        buildTemporalGraphQuery(input, limit),
        "--compact",
      ]);
      return parseTemporalGraphRows(response);
    }));
    const merged = new Map<string, TemporalGraphRow>();
    for (const group of rows) {
      for (const row of group) {
        const key = `${row.subject_id}:${row.relation_type}:${row.object_id ?? ""}:${row.summary}`;
        if (!merged.has(key)) {
          merged.set(key, row);
        }
      }
    }
    return [...merged.values()].slice(0, limit);
  }

  private async replaceTemporalFacts(
    record: Pick<MemoryRecord, "id" | "created_at">,
    facts: ReturnType<typeof extractTemporalFacts>,
  ): Promise<void> {
    await this.graphQueryAll(
      `MATCH (m:Memory {id:\"${
        esc(record.id)
      }\"}) OPTIONAL MATCH (m)-[:EVIDENCE_FOR]->(f:TemporalFact) DETACH DELETE f`,
    );

    for (const [index, fact] of facts.entries()) {
      const temporalFactId = `${record.id}:temporal:${index}`;
      const sortTs = temporalPrimaryTimestamp(fact, record.created_at);
      const queryParts = [
        `MATCH (m:Memory {id:\"${esc(record.id)}\"})`,
        `MERGE (f:TemporalFact {id:\"${esc(temporalFactId)}\"})`,
        `SET f.subject_id=\"${esc(fact.subject_id)}\", f.relation_type=\"${esc(fact.relation_type)}\", f.object_id=${
          cypherNullableString(fact.object_id)
        }, f.summary=\"${esc(fact.summary)}\", f.valid_at=${cypherNullableString(fact.valid_at)}, f.observed_at=${
          cypherNullableString(fact.observed_at)
        }, f.valid_until=${cypherNullableString(fact.valid_until)}, f.sort_ts=\"${esc(sortTs)}\", f.evidence_ids=${
          cypherStringArray(fact.evidence_ids)
        }, f.episode_id=${cypherNullableString(fact.episode_id)}, f.plan_id=${
          cypherNullableString(fact.plan_id)
        }, f.graphiti_namespace=${cypherNullableString(fact.graphiti_namespace)}, f.source_memory_id=\"${
          esc(record.id)
        }\"`,
        `MERGE (subject:TemporalEntity {id:\"${esc(fact.subject_id)}\"})`,
        `SET subject.name = coalesce(subject.name, \"${esc(fact.subject_id)}\")`,
        `MERGE (subject)-[:TEMPORAL_SUBJECT]->(f)`,
        "MERGE (m)-[:EVIDENCE_FOR]->(f)",
      ];

      if (fact.object_id) {
        queryParts.push(
          `MERGE (object:TemporalEntity {id:\"${esc(fact.object_id)}\"})`,
          `SET object.name = coalesce(object.name, \"${esc(fact.object_id)}\")`,
          "MERGE (f)-[:TEMPORAL_OBJECT]->(object)",
        );
      }

      if (fact.episode_id) {
        queryParts.push(
          `MERGE (episode:Episode {id:\"${esc(fact.episode_id)}\"})`,
          `SET episode.plan_id = ${cypherNullableString(fact.plan_id)}, episode.graphiti_namespace = ${
            cypherNullableString(fact.graphiti_namespace)
          }`,
          "MERGE (f)-[:IN_EPISODE]->(episode)",
        );
      }

      await this.graphQueryAll(queryParts.join(" "));
    }
  }

  private async getAndSetLatestMemoryId(memoryId: string): Promise<string | null> {
    const key = `memory:latest:id`;
    const prev = await this.command(["GET", key]);
    await this.command(["SET", key, memoryId]);
    return prev ? String(prev) : null;
  }

  private async graphQueryAll(cypher: string): Promise<void> {
    await Promise.all(this.config.FALKOR_GRAPH_NAMES.map((graphName) => (
      this.command(["GRAPH.QUERY", graphName, cypher, "--compact"])
    )));
  }

  private async command(args: string[]): Promise<unknown> {
    const client = this.client;
    if (!client) throw new Error("falkor client not initialized");

    return await withRetry(
      "falkor_command",
      this.config.DB_RETRY_ATTEMPTS,
      this.config.DB_RETRY_BASE_DELAY_SECONDS,
      async () => {
        return await client.sendCommand(args);
      },
      this.logger,
    );
  }
}
