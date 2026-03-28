import { z } from "zod";
import type { TemporalGraphEdgeResult, TemporalGraphQueryInput } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function pickNullableString(record: Record<string, unknown>, keys: string[]): string | null | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return undefined;
}

function pickStringList(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return uniqueStrings(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean));
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function maybeTimestamp(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isoTimestampSchema.safeParse(value).success ? value : undefined;
}

function tokenizeQuery(query: string): string[] {
  return uniqueStrings(query.toLowerCase().split(/[^a-z0-9:-]+/u).filter((term) => term.length > 1));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const identifierSchema = z.string().trim().min(1).max(256);
const relationTypeSchema = z.string().trim().min(1).max(128);
const summarySchema = z.string().trim().min(1).max(4000);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const temporalFactSchema = z.object({
  subject_id: identifierSchema,
  relation_type: relationTypeSchema,
  object_id: identifierSchema.nullable().optional(),
  summary: summarySchema,
  valid_at: isoTimestampSchema.nullable().optional(),
  observed_at: isoTimestampSchema.nullable().optional(),
  valid_until: isoTimestampSchema.nullable().optional(),
  evidence_ids: z.array(z.string().uuid()).max(64).default([]),
  episode_id: identifierSchema.nullable().optional(),
  plan_id: identifierSchema.nullable().optional(),
  graphiti_namespace: z.string().trim().min(1).max(128).nullable().optional(),
  weight: z.number().min(0).max(1).nullable().optional(),
}).strict();

export type TemporalFact = z.infer<typeof temporalFactSchema>;

export type TemporalGraphRow = TemporalFact & {
  source_memory_id: string | null;
  sort_ts: string | null;
};

export type TemporalMetadataSummary = {
  facts: TemporalFact[];
  hasTemporalFacts: boolean;
  factCount: number;
  evidenceCount: number;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
};

function looksLikeTemporalFact(record: Record<string, unknown>): boolean {
  return Boolean(
    pickString(record, ["subject_id", "subjectId"]) &&
      pickString(record, ["relation_type", "relationType", "relation", "predicate"]),
  );
}

function collectTemporalCandidates(metadata: Record<string, unknown>): Array<{
  record: Record<string, unknown>;
  defaults: Partial<TemporalFact>;
}> {
  const candidates: Array<{ record: Record<string, unknown>; defaults: Partial<TemporalFact> }> = [];

  const pushFromContainer = (container: Record<string, unknown>, inherited: Partial<TemporalFact> = {}) => {
    const defaults: Partial<TemporalFact> = {
      episode_id: pickNullableString(container, ["episode_id", "episodeId"]) ?? inherited.episode_id,
      plan_id: pickNullableString(container, ["plan_id", "planId"]) ?? inherited.plan_id,
      graphiti_namespace: pickNullableString(container, ["graphiti_namespace", "graphitiNamespace", "namespace"]) ??
        inherited.graphiti_namespace,
    };

    if (looksLikeTemporalFact(container)) {
      candidates.push({ record: container, defaults });
    }

    for (const key of ["facts", "edges", "relations"]) {
      const value = container[key];
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        const record = asRecord(entry);
        if (!record) continue;
        candidates.push({ record, defaults });
      }
    }
  };

  for (const key of ["temporal_graph", "temporal", "graphiti"]) {
    const container = asRecord(metadata[key]);
    if (container) {
      pushFromContainer(container);
      const nestedTemporal = asRecord(container.temporal);
      if (nestedTemporal) {
        pushFromContainer(nestedTemporal, {
          episode_id: pickNullableString(container, ["episode_id", "episodeId"]),
          plan_id: pickNullableString(container, ["plan_id", "planId"]),
          graphiti_namespace: pickNullableString(container, ["graphiti_namespace", "graphitiNamespace", "namespace"]),
        });
      }
    }
  }

  const directFacts = metadata.temporal_facts;
  if (Array.isArray(directFacts)) {
    for (const entry of directFacts) {
      const record = asRecord(entry);
      if (!record) continue;
      candidates.push({ record, defaults: {} });
    }
  }

  if (looksLikeTemporalFact(metadata)) {
    candidates.push({ record: metadata, defaults: {} });
  }

  return candidates;
}

function normalizeTemporalFact(
  candidate: Record<string, unknown>,
  defaults: Partial<TemporalFact>,
  options: {
    fallbackText?: string;
    fallbackEvidenceId?: string;
    defaultPlanId?: string | null;
  },
): TemporalFact | null {
  const subjectRecord = asRecord(candidate.subject);
  const objectRecord = asRecord(candidate.object);
  const subject_id = pickString(candidate, ["subject_id", "subjectId", "source_id", "sourceId"]) ??
    pickString(subjectRecord ?? {}, ["id"]);
  const relation_type = pickString(candidate, ["relation_type", "relationType", "relation", "predicate"]);
  if (!subject_id || !relation_type) return null;

  const summary = pickString(candidate, ["summary", "text", "description"]) ?? options.fallbackText?.trim();
  if (!summary) return null;

  const rawEvidenceIds = pickStringList(candidate, ["evidence_ids", "evidenceIds"]) ?? [];
  const evidence_ids = uniqueStrings(
    options.fallbackEvidenceId ? [...rawEvidenceIds, options.fallbackEvidenceId] : rawEvidenceIds,
  ).filter((value) => z.string().uuid().safeParse(value).success);

  const parsed = temporalFactSchema.safeParse({
    subject_id: pickString(subjectRecord ?? {}, ["id"]) ?? subject_id,
    relation_type,
    object_id: pickNullableString(candidate, ["object_id", "objectId", "target_id", "targetId"]) ??
      pickNullableString(objectRecord ?? {}, ["id"]) ??
      defaults.object_id ??
      null,
    summary,
    valid_at: maybeTimestamp(
      pickNullableString(candidate, ["valid_at", "validAt", "start_at", "startAt", "effective_at", "effectiveAt"]) ??
        defaults.valid_at,
    ) ?? null,
    observed_at: maybeTimestamp(
      pickNullableString(candidate, ["observed_at", "observedAt", "timestamp", "happened_at", "happenedAt"]) ??
        defaults.observed_at,
    ) ?? null,
    valid_until: maybeTimestamp(
      pickNullableString(candidate, ["valid_until", "validUntil", "expires_at", "expiresAt", "end_at", "endAt"]) ??
        defaults.valid_until,
    ) ?? null,
    evidence_ids,
    episode_id: pickNullableString(candidate, ["episode_id", "episodeId"]) ?? defaults.episode_id ?? null,
    plan_id: pickNullableString(candidate, ["plan_id", "planId"]) ?? defaults.plan_id ?? options.defaultPlanId ?? null,
    graphiti_namespace: pickNullableString(candidate, ["graphiti_namespace", "graphitiNamespace", "namespace"]) ??
      defaults.graphiti_namespace ??
      null,
    weight: pickNumber(candidate, ["weight", "confidence"]) ?? defaults.weight ?? null,
  });

  return parsed.success ? parsed.data : null;
}

export function extractTemporalFacts(
  metadata: Record<string, unknown>,
  options: {
    fallbackText?: string;
    fallbackEvidenceId?: string;
    defaultPlanId?: string | null;
  } = {},
): TemporalFact[] {
  const facts: TemporalFact[] = [];
  const seen = new Set<string>();

  for (const candidate of collectTemporalCandidates(metadata)) {
    const fact = normalizeTemporalFact(candidate.record, candidate.defaults, options);
    if (!fact) continue;

    const dedupeKey = [
      fact.subject_id,
      fact.relation_type,
      fact.object_id ?? "",
      fact.valid_at ?? "",
      fact.observed_at ?? "",
      fact.valid_until ?? "",
      fact.summary,
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    facts.push(fact);
  }

  return facts;
}

export function temporalPrimaryTimestamp(
  fact: Pick<TemporalFact, "observed_at" | "valid_at" | "valid_until">,
  fallbackCreatedAt: string,
): string {
  return fact.observed_at ?? fact.valid_at ?? fact.valid_until ?? fallbackCreatedAt;
}

export function summarizeTemporalMetadata(
  metadata: Record<string, unknown>,
  fallbackCreatedAt: string,
): TemporalMetadataSummary {
  const facts = extractTemporalFacts(metadata);
  const timestamps = facts
    .flatMap((fact) => [fact.valid_at, fact.observed_at, fact.valid_until, fallbackCreatedAt])
    .filter((value): value is string => typeof value === "string");

  return {
    facts,
    hasTemporalFacts: facts.length > 0,
    factCount: facts.length,
    evidenceCount: facts.reduce((sum, fact) => sum + fact.evidence_ids.length, 0),
    earliestTimestamp: timestamps.length > 0 ? timestamps.slice().sort()[0] : null,
    latestTimestamp: timestamps.length > 0 ? timestamps.slice().sort().at(-1) ?? null : null,
  };
}

export function queryHasTemporalIntent(query: string): boolean {
  return /\b(when|before|after|during|timeline|history|recent|latest|current|earlier|previous|since|until|window|temporal)\b/i
    .test(query) ||
    /\d{4}-\d{2}-\d{2}/.test(query);
}

export function computeTemporalSearchBonus(
  metadata: Record<string, unknown>,
  fallbackCreatedAt: string,
  query: string,
): { bonus: number; hasTemporalFacts: boolean; factCount: number; evidenceCount: number } {
  const summary = summarizeTemporalMetadata(metadata, fallbackCreatedAt);
  if (!summary.hasTemporalFacts) {
    return { bonus: 0, hasTemporalFacts: false, factCount: 0, evidenceCount: 0 };
  }

  let bonus = 0.04;
  if (queryHasTemporalIntent(query)) bonus += 0.04;
  bonus += Math.min(0.03, summary.factCount * 0.01);
  bonus += Math.min(0.03, summary.evidenceCount * 0.005);

  return {
    bonus: clamp01(Number(bonus.toFixed(6))),
    hasTemporalFacts: true,
    factCount: summary.factCount,
    evidenceCount: summary.evidenceCount,
  };
}

export function temporalRowMatchesTimeRange(
  row: Pick<TemporalGraphRow, "valid_at" | "observed_at" | "valid_until" | "sort_ts">,
  timeRange: TemporalGraphQueryInput["time_range"],
): boolean {
  if (!timeRange) return true;
  const start = row.valid_at ?? row.observed_at ?? row.sort_ts;
  const end = row.valid_until ?? row.observed_at ?? row.valid_at ?? row.sort_ts;

  if (timeRange.since && end && end < timeRange.since) return false;
  if (timeRange.until && start && start > timeRange.until) return false;
  return true;
}

function queryCoverage(
  query: string,
  row: Pick<TemporalGraphRow, "subject_id" | "relation_type" | "object_id" | "summary">,
): number {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return 0;

  const haystack = [row.subject_id, row.relation_type, row.object_id ?? "", row.summary].join(" ").toLowerCase();
  if (haystack.includes(trimmed)) return 1;

  const terms = tokenizeQuery(trimmed);
  if (terms.length === 0) return 0;
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

function temporalWindowScore(row: TemporalGraphRow, timeRange: TemporalGraphQueryInput["time_range"]): number {
  if (!timeRange) return row.valid_at || row.observed_at || row.sort_ts ? 0.05 : 0;
  if (!temporalRowMatchesTimeRange(row, timeRange)) return 0;

  const anchor = timeRange.until ?? timeRange.since ?? null;
  const rowAnchor = row.observed_at ?? row.valid_at ?? row.sort_ts;
  if (!anchor || !rowAnchor) return 0.14;

  const deltaMs = Math.abs(Date.parse(anchor) - Date.parse(rowAnchor));
  if (!Number.isFinite(deltaMs)) return 0.14;
  const deltaDays = deltaMs / 86_400_000;
  return Math.max(0.05, 0.2 - Math.min(0.15, deltaDays * 0.01));
}

export function rankTemporalGraphRows(
  rows: TemporalGraphRow[],
  input: TemporalGraphQueryInput,
): TemporalGraphEdgeResult[] {
  const subjectIds = new Set(input.subject_ids ?? []);
  const relationTypes = new Set(input.relation_types ?? []);

  const ranked = rows
    .filter((row) => {
      if (subjectIds.size > 0 && !subjectIds.has(row.subject_id)) return false;
      if (relationTypes.size > 0 && !relationTypes.has(row.relation_type)) return false;
      if (input.plan_id && row.plan_id !== input.plan_id) return false;
      return temporalRowMatchesTimeRange(row, input.time_range);
    })
    .map((row) => {
      const match = queryCoverage(input.query, row);
      const subjectBoost = subjectIds.size > 0 && subjectIds.has(row.subject_id) ? 0.16 : 0;
      const relationBoost = relationTypes.size > 0 && relationTypes.has(row.relation_type) ? 0.14 : 0;
      const evidenceBoost = Math.min(0.15, row.evidence_ids.length * 0.03);
      const objectBoost = row.object_id ? 0.04 : 0;
      const timeBoost = temporalWindowScore(row, input.time_range);
      const score = clamp01(0.45 * match + subjectBoost + relationBoost + evidenceBoost + objectBoost + timeBoost);

      return {
        subject_id: row.subject_id,
        relation_type: row.relation_type,
        object_id: row.object_id ?? null,
        summary: row.summary,
        valid_at: row.valid_at ?? null,
        observed_at: row.observed_at ?? null,
        score: Number(score.toFixed(6)),
        evidence_ids: input.include_evidence ? row.evidence_ids : undefined,
        sort_ts: row.sort_ts ??
          temporalPrimaryTimestamp(row, row.valid_at ?? row.observed_at ?? new Date(0).toISOString()),
      };
    })
    .sort((a, b) => {
      if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      return String(b.sort_ts).localeCompare(String(a.sort_ts));
    })
    .slice(0, input.limit);

  return ranked.map(({ sort_ts: _sortTs, ...row }) => row);
}
