import { createClient } from "redis";
import { loadConfig } from "../src/config.ts";
import { parseTemporalGraphRows } from "../src/adapters/falkor.ts";
import {
  buildTemporalWindowQuery,
  type GraphInsightReport,
  GRAPH_INSIGHT_QUERIES,
  parseCompactTable,
  parseInsightPreset,
  presetKeys,
  renderGraphInsightMarkdown,
  splitTelegramMessages,
  formatTemporalRowsForSection,
} from "../src/graph_insights.ts";

type CliOptions = {
  preset: ReturnType<typeof parseInsightPreset>;
  output: "markdown" | "json";
  temporalQuery: string;
  temporalLimit: number;
  publishTelegram: boolean;
  telegramChatId: string | null;
};

function resolveHostRedisUrl(configUrl: string): string {
  const envUrl = Deno.env.get("FALKOR_REDIS_URL");
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl;
  }

  return configUrl === "redis://falkordb:6379" ? "redis://127.0.0.1:6380" : configUrl;
}

function parseArgs(args: string[]): CliOptions {
  let preset = parseInsightPreset("all");
  let output: "markdown" | "json" = "markdown";
  let temporalQuery = "timeline";
  let temporalLimit = 10;
  let publishTelegram = false;
  let telegramChatId: string | null = Deno.env.get("TELEGRAM_CHAT_ID") ?? null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--preset":
        preset = parseInsightPreset(next);
        index += 1;
        break;
      case "--output":
        if (next !== "markdown" && next !== "json") {
          throw new Error(`Invalid --output value: ${next}`);
        }
        output = next;
        index += 1;
        break;
      case "--temporal-query":
        temporalQuery = next ?? temporalQuery;
        index += 1;
        break;
      case "--temporal-limit":
        temporalLimit = Number(next ?? temporalLimit);
        index += 1;
        break;
      case "--telegram":
        publishTelegram = true;
        break;
      case "--chat-id":
        telegramChatId = next ?? null;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { preset, output, temporalQuery, temporalLimit, publishTelegram, telegramChatId };
}

async function graphQuery(
  client: ReturnType<typeof createClient>,
  graph: string,
  cypher: string,
): Promise<unknown> {
  return await client.sendCommand(["GRAPH.QUERY", graph, cypher, "--compact"]);
}

async function fetchRolloutContract(baseUrl: string, token: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${baseUrl}/mcp/v1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "graph-insights",
      method: "tools/call",
      params: {
        name: "memory_status",
        arguments: {},
      },
    }),
  });

  if (!response.ok) {
    if (response.status === 401 && !token) {
      throw new Error("memory_status requires Authorization: Bearer <billing-issued-key>; set MNEMOSYNE_API_KEY.");
    }
    throw new Error(`memory_status failed: ${response.status} ${await response.text()}`);
  }

  const envelope = await response.json() as Record<string, unknown>;
  const result = (envelope.result as Record<string, unknown> | undefined) ?? {};
  const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
  const text = content.find((entry) => entry.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("memory_status returned no text payload");
  }
  const payload = JSON.parse(text) as { ok: boolean; result?: Record<string, unknown> };
  if (!payload.ok || !payload.result) {
    throw new Error("memory_status reported failure");
  }

  const rollout = (payload.result.rollout_contract as Record<string, unknown> | undefined) ?? {};
  const capabilities = (rollout.capabilities as Record<string, unknown> | undefined) ?? {};

  return {
    plan_state: String(capabilities.plan_state ?? "off"),
    slice_projection: String(capabilities.slice_projection ?? "off"),
    hybrid_retrieval: String(capabilities.hybrid_retrieval ?? "off"),
    bridge_sync: String(capabilities.bridge_sync ?? "off"),
    reflection_handoff: String(capabilities.reflection_handoff ?? "off"),
    temporal_graph: String(capabilities.temporal_graph ?? "off"),
  };
}

async function publishToTelegram(markdown: string, chatId: string, token: string) {
  for (const chunk of splitTelegramMessages(markdown)) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  const config = loadConfig();
  const gatewayUrl = Deno.env.get("MNEMOSYNE_GATEWAY_URL") ?? "http://127.0.0.1:8000";
  const token = Deno.env.get("MNEMOSYNE_API_KEY") ?? null;
  const redisUrl = resolveHostRedisUrl(config.FALKOR_REDIS_URL);

  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    const rolloutContract = await fetchRolloutContract(gatewayUrl, token);
    const sections = [];

    for (const key of presetKeys(options.preset)) {
      const queries = GRAPH_INSIGHT_QUERIES[key];
      const lines: string[] = [];
      for (const query of queries) {
        const table = parseCompactTable(await graphQuery(client, config.FALKOR_GRAPH, query.cypher));
        lines.push(...query.formatter(table));
      }
      sections.push({
        key,
        title: key.replaceAll("-", " "),
        lines,
      });
    }

    const temporalRows = parseTemporalGraphRows(
      await graphQuery(client, config.FALKOR_GRAPH, buildTemporalWindowQuery(options.temporalQuery, options.temporalLimit)),
    );
    sections.push(formatTemporalRowsForSection(`temporal window: ${options.temporalQuery}`, temporalRows));

    const report: GraphInsightReport = {
      generated_at: new Date().toISOString(),
      graph: config.FALKOR_GRAPH,
      preset: options.preset,
      sections,
      rollout_contract: rolloutContract,
    };

    const markdown = renderGraphInsightMarkdown(report);
    if (options.output === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(markdown);
    }

    if (options.publishTelegram) {
      const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (!telegramToken) {
        throw new Error("TELEGRAM_BOT_TOKEN is required when using --telegram");
      }
      if (!options.telegramChatId) {
        throw new Error("TELEGRAM_CHAT_ID or --chat-id is required when using --telegram");
      }
      await publishToTelegram(markdown, options.telegramChatId, telegramToken);
      console.error("Published graph insight report to Telegram.");
    }
  } finally {
    await client.quit();
  }
}
