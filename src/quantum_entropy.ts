import type { AppConfig } from "./config.ts";
import { withRetry, type Logger } from "./utils.ts";

export type QuantumEntropySample = {
  mode: "off" | "external";
  provider: string;
  source: string;
  raw_hex: string;
  sample_bits: number;
  unit_interval: number;
  acquired_at: string;
};

export type QuantumEntropyStatus = {
  mode: "off" | "external";
  configured: boolean;
  active: boolean;
  provider: string | null;
  source: string | null;
  timeout_ms: number;
  reflect_jitter_pct: number;
  last_sample_at: string | null;
  last_error: string | null;
};

export type AutoReflectPlan = {
  strategy: "fixed" | "quantum";
  cadence: number;
  threshold: number;
  jitter_offset: number;
  jitter_range: number;
  sample: QuantumEntropySample | null;
};

type EntropyPayload = {
  bytes: Uint8Array;
  provider: string | null;
  source: string | null;
};

export class QuantumEntropyClient {
  private lastSample: QuantumEntropySample | null = null;
  private lastError: string | null = null;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {}

  status(): QuantumEntropyStatus {
    const configured = this.config.QUANTUM_ENTROPY_MODE === "external" && this.config.QUANTUM_ENTROPY_URL.length > 0;

    return {
      mode: this.config.QUANTUM_ENTROPY_MODE,
      configured,
      active: configured && this.lastSample !== null,
      provider: this.lastSample?.provider ?? null,
      source: this.lastSample?.source ?? null,
      timeout_ms: this.config.QUANTUM_ENTROPY_TIMEOUT_MS,
      reflect_jitter_pct: this.config.QUANTUM_REFLECT_JITTER_PCT,
      last_sample_at: this.lastSample?.acquired_at ?? null,
      last_error: this.lastError
    };
  }

  async planReflectThreshold(cadence: number): Promise<AutoReflectPlan> {
    if (cadence <= 0) {
      return {
        strategy: "fixed",
        cadence,
        threshold: 0,
        jitter_offset: 0,
        jitter_range: 0,
        sample: null
      };
    }

    if (this.config.QUANTUM_ENTROPY_MODE !== "external" || this.config.QUANTUM_REFLECT_JITTER_PCT === 0) {
      return this.fixedPlan(cadence);
    }

    const sample = await this.sample();
    if (!sample) {
      return this.fixedPlan(cadence);
    }

    const jitterRange = Math.max(1, Math.floor(cadence * this.config.QUANTUM_REFLECT_JITTER_PCT));
    return deriveQuantumReflectPlan(cadence, jitterRange, sample);
  }

  async sampleDecisionEntropy(): Promise<QuantumEntropySample | null> {
    if (this.config.QUANTUM_ENTROPY_MODE !== "external") {
      return null;
    }

    return await this.sample();
  }

  private fixedPlan(cadence: number): AutoReflectPlan {
    return {
      strategy: "fixed",
      cadence,
      threshold: cadence,
      jitter_offset: 0,
      jitter_range: 0,
      sample: null
    };
  }

  private async sample(): Promise<QuantumEntropySample | null> {
    try {
      const payload = await withRetry(
        "quantum_entropy_fetch",
        this.config.DB_RETRY_ATTEMPTS,
        this.config.DB_RETRY_BASE_DELAY_SECONDS,
        async () => await this.fetchExternalEntropy(),
        this.logger
      );

      const sample = buildSample(payload, this.config.QUANTUM_ENTROPY_MODE);
      this.lastSample = sample;
      this.lastError = null;
      this.logger.info("quantum_entropy_sampled", {
        provider: sample.provider,
        source: sample.source,
        sample_bits: sample.sample_bits
      });
      return sample;
    } catch (error) {
      this.lastError = String(error);
      this.logger.warn("quantum_entropy_unavailable", { error: this.lastError });
      return null;
    }
  }

  private async fetchExternalEntropy(): Promise<EntropyPayload> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.QUANTUM_ENTROPY_TIMEOUT_MS);

    try {
      const headers = new Headers({ Accept: "application/json" });
      if (this.config.QUANTUM_ENTROPY_HEADER_NAME && this.config.QUANTUM_ENTROPY_HEADER_VALUE) {
        headers.set(this.config.QUANTUM_ENTROPY_HEADER_NAME, this.config.QUANTUM_ENTROPY_HEADER_VALUE);
      }

      const response = await fetch(this.config.QUANTUM_ENTROPY_URL, {
        method: this.config.QUANTUM_ENTROPY_METHOD,
        headers,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`quantum entropy endpoint returned ${response.status}`);
      }

      const json = await response.json();
      const parsed = parseEntropyPayload(json);
      const sourceUrl = safeSourceHost(this.config.QUANTUM_ENTROPY_URL);

      return {
        bytes: parsed.bytes,
        provider: parsed.provider ?? sourceUrl,
        source: parsed.source ?? sourceUrl
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function deriveQuantumReflectPlan(
  cadence: number,
  jitterRange: number,
  sample: QuantumEntropySample
): AutoReflectPlan {
  const centered = (sample.unit_interval * 2) - 1;
  const jitterOffset = Math.round(centered * jitterRange);

  return {
    strategy: "quantum",
    cadence,
    threshold: Math.max(5, cadence + jitterOffset),
    jitter_offset: jitterOffset,
    jitter_range: jitterRange,
    sample
  };
}

function safeSourceHost(urlString: string): string {
  try {
    return new URL(urlString).host;
  } catch {
    return "external";
  }
}

function buildSample(payload: EntropyPayload, mode: "off" | "external"): QuantumEntropySample {
  return {
    mode,
    provider: payload.provider ?? "external",
    source: payload.source ?? "external",
    raw_hex: toHex(payload.bytes),
    sample_bits: payload.bytes.length * 8,
    unit_interval: bytesToUnitInterval(payload.bytes),
    acquired_at: new Date().toISOString()
  };
}

export function parseEntropyPayload(input: unknown): EntropyPayload {
  if (input instanceof Uint8Array) {
    return { bytes: input, provider: null, source: null };
  }

  if (Array.isArray(input)) {
    return { bytes: normalizeEntropyBytes(input), provider: null, source: null };
  }

  if (!input || typeof input !== "object") {
    throw new Error("entropy payload must be an object, byte array, or hex string");
  }

  const record = input as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider : null;
  const source = typeof record.source === "string" ? record.source : null;

  const candidates = [
    record.bytes,
    record.data,
    record.entropy,
    record.random,
    record.hex,
    record.value
  ];

  for (const candidate of candidates) {
    const bytes = tryNormalizeEntropyBytes(candidate);
    if (bytes) {
      return { bytes, provider, source };
    }
  }

  throw new Error("entropy payload did not contain bytes, data, entropy, random, hex, or value");
}

function tryNormalizeEntropyBytes(candidate: unknown): Uint8Array | null {
  if (candidate === undefined || candidate === null) return null;
  try {
    return normalizeEntropyBytes(candidate);
  } catch {
    return null;
  }
}

export function normalizeEntropyBytes(candidate: unknown): Uint8Array {
  if (candidate instanceof Uint8Array) {
    if (candidate.length === 0) throw new Error("entropy byte array is empty");
    return candidate;
  }

  if (typeof candidate === "string") {
    return hexToBytes(candidate);
  }

  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error("entropy payload array is empty");
  }

  if (candidate.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)) {
    return Uint8Array.from(candidate as number[]);
  }

  if (candidate.every((value) => typeof value === "string")) {
    const merged = (candidate as string[]).join("");
    return hexToBytes(merged);
  }

  throw new Error("unsupported entropy payload format");
}

export function hexToBytes(value: string): Uint8Array {
  const sanitized = value.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (sanitized.length === 0 || sanitized.length % 2 !== 0 || !/^[a-fA-F0-9]+$/.test(sanitized)) {
    throw new Error("entropy hex string must contain an even number of hex characters");
  }

  const out = new Uint8Array(sanitized.length / 2);
  for (let i = 0; i < sanitized.length; i += 2) {
    out[i / 2] = Number.parseInt(sanitized.slice(i, i + 2), 16);
  }
  return out;
}

export function bytesToUnitInterval(bytes: Uint8Array): number {
  const sampleLength = Math.min(bytes.length, 6);
  let accumulator = 0;

  for (let i = 0; i < sampleLength; i += 1) {
    accumulator = (accumulator * 256) + bytes[i];
  }

  const max = (256 ** sampleLength) - 1;
  if (max <= 0) return 0.5;
  return accumulator / max;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}
