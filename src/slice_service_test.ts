import { assertEquals, assertGreater } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_SLICE_NAMESPACE, DeterministicSliceEmbedder, InMemorySliceStore } from "./slice_runtime.ts";
import { SliceJournal } from "./slice_journal.ts";
import { SliceService } from "./slice_service.ts";
import { createLogger } from "./utils.ts";

Deno.test("slice runtime indexes into storage with deterministic embeddings and dedupe", async () => {
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new SliceService(config, logger, {
    store: new InMemorySliceStore(),
    journal: new SliceJournal(await Deno.makeTempFile({ suffix: ".slice-journal.jsonl" })),
    embedder: new DeterministicSliceEmbedder(32, "test-embed-v1", "test"),
  });
  await service.startup();

  const first = await service.indexSource({
    source_key: "docs/runtime-overview",
    source_kind: "document",
    max_tokens: 5,
    text:
      "Mnemosyne slices runtime context into reusable units for hybrid retrieval and projection across vector and journal channels.",
  });
  const second = await service.indexSource({
    source_key: "docs/runtime-overview",
    source_kind: "document",
    max_tokens: 5,
    text:
      "Mnemosyne slices runtime context into reusable units for hybrid retrieval and projection across vector and journal channels.",
  });

  assertEquals(first.namespace, DEFAULT_SLICE_NAMESPACE);
  assertGreater(first.total_slices, 1);
  assertEquals(first.embedding.dimension, 32);
  assertEquals(second.stored_slices, 0);
  assertEquals(second.deduped_slices, first.total_slices);

  const search = await service.searchStoredSlices({
    query: "hybrid retrieval projection",
    top_k: 3,
  });

  assertGreater(search.returned, 0);
  assertEquals(search.embedding.model, "test-embed-v1");
  assertEquals(search.results[0]?.source_key, "docs_runtime-overview");
});

Deno.test("slice projection builds bounded slices from runtime retrieval results", async () => {
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new SliceService(config, logger, {
    store: new InMemorySliceStore(),
    journal: new SliceJournal(await Deno.makeTempFile({ suffix: ".projection-slice-journal.jsonl" })),
    embedder: new DeterministicSliceEmbedder(32, "test-embed-v1", "test"),
    hybridRetriever: async () => ({
      query: "projection objective",
      plan_id: null,
      namespace: "default",
      fusion_strategy: "balanced",
      scanned_sources: ["vector", "graph", "journal"],
      returned: 3,
      results: [
        {
          id: "memory-1",
          source: "vector",
          text: "Vector memory keeps semantic retrieval explicit and stable for future runtime contracts.",
          score: 0.92,
          created_at: "2026-03-17T12:00:00.000Z",
          metadata: { kind: "memory", tags: ["vector"] },
          channels: ["vector"],
        },
        {
          id: "memory-2",
          source: "graph",
          text:
            "Graph memory preserves relationships between plan checkpoints and execution evidence for hybrid projection.",
          score: 0.81,
          created_at: "2026-03-17T12:01:00.000Z",
          metadata: { kind: "memory", tags: ["graph"] },
          channels: ["graph"],
        },
        {
          id: "memory-3",
          source: "journal",
          text: "The append-only slice journal gives the runtime a replayable audit trail for stored projections.",
          score: 0.76,
          created_at: "2026-03-17T12:02:00.000Z",
          metadata: { kind: "memory", tags: ["journal"] },
          channels: ["journal"],
        },
      ],
    }),
  });
  await service.startup();

  const projection = await service.project({
    objective: "Assemble execution-ready context for the next hybrid retrieval step",
    projection_mode: "balanced",
    max_slices: 2,
    max_tokens: 80,
    include_sources: true,
  });

  assertEquals(projection.slices.length, 2);
  assertEquals(projection.truncated, true);
  assertGreater(projection.total_estimated_tokens, 0);
  assertEquals(projection.slices[0]?.source_ref?.kind, "memory");
});
