import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/utils.ts";
import { MemoryService } from "../src/memory_service.ts";
import { JournalWriter } from "../src/journal.ts";
import { addMemoryInputSchema } from "../src/types.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const memory = new MemoryService(config, logger);
const journal = new JournalWriter(config.SOUL_JOURNAL_PATH);

await memory.startup();

let processed = 0;
let skipped = 0;

await journal.streamEntries(async (entry) => {
  const text = typeof entry.text === "string" ? entry.text : "";
  if (!text.trim()) {
    skipped += 1;
    return;
  }

  const payload = {
    text,
    agent_id: typeof entry.agent_id === "string" ? entry.agent_id : "system",
    memory_type: typeof entry.memory_type === "string" ? entry.memory_type : "episodic",
    task_id: typeof entry.task_id === "string" ? entry.task_id : null,
    tags: Array.isArray(entry.tags) ? entry.tags.map((v) => String(v)) : []
  };

  try {
    const parsed = addMemoryInputSchema.parse(payload);
    await memory.addMemory(parsed, {
      replay: true,
      source_created_at: entry.created_at,
      source_id: entry.id,
      source_schema_version: entry.schema_version ?? 1
    });
    processed += 1;
  } catch {
    skipped += 1;
  }
});

logger.info("replay_complete", { processed, skipped });
await memory.shutdown();
