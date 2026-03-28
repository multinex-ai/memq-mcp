import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { ensureFile } from "https://deno.land/std@0.224.0/fs/ensure_file.ts";
import { dirname } from "https://deno.land/std@0.224.0/path/dirname.ts";
import type { RuntimeSliceRecord } from "./slice_runtime.ts";

export class SliceJournal {
  private lock = Promise.resolve();

  constructor(readonly filePath: string) {}

  async init(): Promise<void> {
    await ensureDir(dirname(this.filePath));
    await ensureFile(this.filePath);
  }

  async appendMany(slices: RuntimeSliceRecord[]): Promise<void> {
    if (slices.length === 0) {
      return;
    }

    const payload = `${slices.map((slice) => JSON.stringify(slice)).join("\n")}\n`;
    this.lock = this.lock.then(async () => {
      await Deno.writeTextFile(this.filePath, payload, { append: true });
    });
    await this.lock;
  }

  async streamEntries(handler: (entry: RuntimeSliceRecord) => Promise<void>): Promise<void> {
    const text = await Deno.readTextFile(this.filePath);
    for (const line of text.split("\n")) {
      const raw = line.trim();
      if (!raw) continue;
      await handler(JSON.parse(raw) as RuntimeSliceRecord);
    }
  }
}
