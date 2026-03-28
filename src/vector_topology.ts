import { createHash } from "node:crypto";

export type VectorProfile = {
  provider: string;
  model: string;
  dimension: number;
  id: string;
};

function hashBytes(input: string): Uint8Array {
  return createHash("sha256").update(input).digest();
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}

export function vectorProfileId(provider: string, model: string, dimension: number): string {
  return `${provider}/${model}@${dimension}`;
}

export function sanitizeProfileId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function parseVectorMirrorProfiles(
  raw: string,
  defaults: {
    provider: string;
    model: string;
    dimension: number;
  },
): VectorProfile[] {
  const seen = new Set<string>();
  const out: VectorProfile[] = [];

  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [profilePart, dimensionPart] = entry.split("@");
    const dimension = Number(dimensionPart);
    if (!Number.isInteger(dimension) || dimension < 32 || dimension > 8192) {
      throw new Error(`invalid VECTOR_MIRROR_PROFILES entry: ${entry}`);
    }

    const segments = profilePart.split("/").map((value) => value.trim()).filter(Boolean);
    const provider = segments.length > 1 ? segments[0] : defaults.provider;
    const model = segments.length > 1 ? segments.slice(1).join("/") : (segments[0] || defaults.model);
    const id = vectorProfileId(provider, model, dimension);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ provider, model, dimension, id });
  }

  return out;
}

export function resolveVectorProfiles(
  primary: {
    provider: string;
    model: string;
    dimension: number;
  },
  rawMirrors: string,
): VectorProfile[] {
  const primaryProfile: VectorProfile = {
    ...primary,
    id: vectorProfileId(primary.provider, primary.model, primary.dimension),
  };
  const mirrors = parseVectorMirrorProfiles(rawMirrors, primary);
  const profiles = [primaryProfile];
  const seen = new Set<string>([primaryProfile.id]);

  for (const mirror of mirrors) {
    if (seen.has(mirror.id)) continue;
    seen.add(mirror.id);
    profiles.push(mirror);
  }

  return profiles;
}

export function vectorCollectionName(baseCollection: string, profile: VectorProfile, primaryProfileId: string): string {
  if (profile.id === primaryProfileId) {
    return baseCollection;
  }
  return `${baseCollection}__${sanitizeProfileId(profile.id)}`;
}

export function translateVector(
  vector: number[],
  source: VectorProfile,
  target: VectorProfile,
): number[] {
  if (vector.length !== source.dimension) {
    throw new Error(`source vector dimension mismatch: expected ${source.dimension}, got ${vector.length}`);
  }

  if (source.id === target.id) {
    return normalize(vector.slice());
  }

  const out = new Array<number>(target.dimension).fill(0);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value) || value === 0) continue;

    const digest = hashBytes(`${source.id}->${target.id}:${index}`);
    const first = ((digest[0] << 8) + digest[1]) % target.dimension;
    const second = ((digest[2] << 8) + digest[3]) % target.dimension;
    const firstWeight = 0.55 + (digest[4] / 255) * 0.35;
    const secondWeight = 1 - firstWeight;
    const firstSign = digest[5] % 2 === 0 ? 1 : -1;
    const secondSign = digest[6] % 2 === 0 ? 1 : -1;

    out[first] += value * firstWeight * firstSign;
    out[second] += value * secondWeight * secondSign;
  }

  return normalize(out);
}
