import {
  bytesToUnitInterval,
  deriveQuantumReflectPlan,
  hexToBytes,
  normalizeEntropyBytes,
  parseEntropyPayload
} from "./quantum_entropy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("hexToBytes parses hex payloads", () => {
  const bytes = hexToBytes("0a0b0c0d");
  assert(bytes.length === 4, "expected four bytes");
  assert(bytes[0] === 0x0a && bytes[3] === 0x0d, "expected parsed byte values");
});

Deno.test("normalizeEntropyBytes accepts string arrays", () => {
  const bytes = normalizeEntropyBytes(["0a0b", "0c0d"]);
  assert(bytes.length === 4, "expected merged bytes");
  assert(bytes[1] === 0x0b && bytes[2] === 0x0c, "expected ordered merged bytes");
});

Deno.test("parseEntropyPayload accepts provider-tagged object responses", () => {
  const payload = parseEntropyPayload({
    provider: "anu-qrng",
    source: "quantum",
    data: ["0a0b", "0c0d"]
  });

  assert(payload.provider === "anu-qrng", "expected provider to survive parsing");
  assert(payload.source === "quantum", "expected source to survive parsing");
  assert(payload.bytes.length === 4, "expected parsed bytes");
});

Deno.test("parseEntropyPayload accepts ANU QRNG array responses", () => {
  const payload = parseEntropyPayload({
    type: "hex16",
    length: 1,
    size: 32,
    data: ["0123456789abcdeffedcba9876543210"],
    success: true
  });

  assert(payload.bytes.length === 16, "expected 16 bytes from anu hex16 payload");
  assert(payload.bytes[0] === 0x01, "expected first byte to parse correctly");
  assert(payload.bytes[15] === 0x10, "expected last byte to parse correctly");
});

Deno.test("bytesToUnitInterval maps bytes into 0..1", () => {
  const low = bytesToUnitInterval(Uint8Array.from([0, 0, 0, 0]));
  const high = bytesToUnitInterval(Uint8Array.from([255, 255, 255, 255]));

  assert(low === 0, "expected zero bytes to map to 0");
  assert(high === 1, "expected max bytes to map to 1");
});

Deno.test("deriveQuantumReflectPlan jitters around the base cadence", () => {
  const sample = {
    mode: "external" as const,
    provider: "anu-qrng",
    source: "quantum",
    raw_hex: "ffffffff",
    sample_bits: 32,
    unit_interval: 1,
    acquired_at: "2026-03-11T00:00:00.000Z"
  };

  const plan = deriveQuantumReflectPlan(25, 8, sample);

  assert(plan.strategy === "quantum", "expected quantum strategy");
  assert(plan.threshold === 33, "expected positive jitter to increase threshold");
  assert(plan.jitter_offset === 8, "expected max positive offset");
});
