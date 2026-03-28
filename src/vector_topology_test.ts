import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveVectorProfiles, translateVector, vectorCollectionName } from "./vector_topology.ts";
import { embedText } from "./vector.ts";

Deno.test("resolveVectorProfiles keeps primary and appends unique mirrors", () => {
  const profiles = resolveVectorProfiles(
    { provider: "mnemosyne-runtime", model: "mnemosyne-hash-embed-v1", dimension: 256 },
    "mnemosyne-hash-embed-v1@512,mnemosyne-hash-embed-v1@512,openai/text-embedding-3-small@1536",
  );

  assertEquals(profiles.length, 3);
  assertEquals(profiles[0].dimension, 256);
  assertEquals(vectorCollectionName("soul_journal", profiles[0], profiles[0].id), "soul_journal");
  assertEquals(
    vectorCollectionName("soul_journal", profiles[1], profiles[0].id),
    "soul_journal__mnemosyne_runtime_mnemosyne_hash_embed_v1_512",
  );
});

Deno.test("translateVector adapts between dimensions deterministically", () => {
  const [primary, mirror] = resolveVectorProfiles(
    { provider: "mnemosyne-runtime", model: "mnemosyne-hash-embed-v1", dimension: 256 },
    "mnemosyne-hash-embed-v1@768",
  );
  const vector = embedText("dual brain mirrored vector search", 256, "mnemosyne-runtime/mnemosyne-hash-embed-v1");
  const translated = translateVector(vector, primary, mirror);
  const roundTrip = translateVector(translated, mirror, primary);

  assertEquals(translated.length, 768);
  assertEquals(roundTrip.length, 256);
  assertNotEquals(JSON.stringify(translated.slice(0, 16)), JSON.stringify(new Array(16).fill(0)));
  assertNotEquals(JSON.stringify(roundTrip.slice(0, 16)), JSON.stringify(new Array(16).fill(0)));
});
