import { ensureFile } from "https://deno.land/std@0.224.0/fs/ensure_file.ts";
import { dirname } from "https://deno.land/std@0.224.0/path/dirname.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import type { JournalEntry } from "./types.ts";

export class JournalWriter {
  private lock = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await ensureDir(dirname(this.filePath));
    await ensureFile(this.filePath);
  }

  async append(entry: JournalEntry): Promise<void> {
    const payload = `${JSON.stringify(entry)}\n`;
    this.lock = this.lock.then(async () => {
      await Deno.writeTextFile(this.filePath, payload, { append: true });
    });
    await this.lock;
  }

  async streamEntries(handler: (entry: Record<string, unknown>) => Promise<void>): Promise<void> {
    const text = await Deno.readTextFile(this.filePath);
    for (const line of text.split("\n")) {
      const raw = line.trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      await handler(parsed);
    }
  }
}
