import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/utils.ts";
import { MemoryService } from "../src/memory_service.ts";
import { JournalWriter } from "../src/journal.ts";
import { addMemoryInputSchema } from "../src/types.ts";

const sourcePath = Deno.env.get("MNEMOSYNE_REPLAY_SOURCE_JOURNAL");
if (!sourcePath) {
  throw new Error("MNEMOSYNE_REPLAY_SOURCE_JOURNAL is required");
}

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const memory = new MemoryService(config, logger);
const sourceJournal = new JournalWriter(sourcePath);

await memory.startup();

let processed = 0;
let skipped = 0;

await sourceJournal.streamEntries(async (entry) => {
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
    tags: Array.isArray(entry.tags) ? entry.tags.map((value) => String(value)) : []
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

await memory.shutdown();

console.log(JSON.stringify({
  processed,
  skipped,
  sourcePath,
  targetPath: config.SOUL_JOURNAL_PATH
}));
