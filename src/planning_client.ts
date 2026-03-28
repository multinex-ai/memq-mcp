import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { AppConfig } from "./config.ts";
import { GatewayToolError } from "./errors.ts";
import {
  type PlanStateCheckpointInput,
  type PlanStateCheckpointResult,
  planStateCheckpointResultSchema,
  type PlanStateReadInput,
  type PlanStateResumeInput,
  type PlanStateResumeResult,
  planStateResumeResultSchema,
  type PlanStateSnapshot,
  planStateSnapshotSchema,
  type PlanStateStatus,
  type PlanStateWriteInput,
  type PlanStateWriteResult,
  planStateWriteResultSchema,
} from "./types.ts";

const DEFAULT_NAMESPACE = "default";

type StoredPlanCheckpoint = {
  checkpoint_id: string;
  label: string | null;
  summary: string | null;
  status: PlanStateStatus;
  thread_id: string | null;
  state_version: number | null;
  created_at: string;
  state: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
};

type StoredPlanState = {
  plan_id: string;
  namespace: string;
  status: PlanStateStatus;
  checkpoint_id: string | null;
  thread_id: string | null;
  state_version: number;
  summary: string | null;
  updated_at: string | null;
  state: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  tags: string[];
  checkpoints: StoredPlanCheckpoint[];
};

type ExtractedStatePatch = {
  state: Record<string, unknown>;
  thread_id?: string | null;
  checkpoint_id?: string | null;
  messages?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function mergeRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = cloneRecord(base);
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isObjectRecord(existing) && isObjectRecord(value)) {
      out[key] = mergeRecords(existing, value);
      continue;
    }
    out[key] = cloneRecord(value);
  }
  return out;
}

function mergeTags(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function normalizeStructuredArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => isObjectRecord(entry) ? cloneRecord(entry) : { value: entry });
}

export class PlanningClient {
  private readonly rootDir: string;
  private initialized: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(config: AppConfig) {
    this.rootDir = join(dirname(config.SOUL_JOURNAL_PATH), "plan_state");
  }

  resolveNamespace(namespace?: string): string {
    const trimmed = namespace?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_NAMESPACE;
  }

  async init(): Promise<void> {
    await this.ensureReady();
  }

  async readSnapshot(input: PlanStateReadInput): Promise<PlanStateSnapshot> {
    const namespace = this.resolveNamespace(input.namespace);
    await this.waitForPendingWrites();
    const state = await this.readStateFile(input.plan_id, namespace);
    if (!state) {
      throw new GatewayToolError(
        "plan_state_not_found",
        `Plan state not found for ${input.plan_id}.`,
        { plan_id: input.plan_id, namespace },
        404,
      );
    }

    if (input.checkpoint_id) {
      const checkpoint = state.checkpoints.find((entry) => entry.checkpoint_id === input.checkpoint_id);
      if (!checkpoint) {
        throw new GatewayToolError(
          "plan_state_checkpoint_not_found",
          `Checkpoint ${input.checkpoint_id} was not found for ${input.plan_id}.`,
          { plan_id: input.plan_id, namespace, checkpoint_id: input.checkpoint_id },
          404,
        );
      }

      return planStateSnapshotSchema.parse({
        plan_id: state.plan_id,
        namespace: state.namespace,
        status: checkpoint.status,
        checkpoint_id: checkpoint.checkpoint_id,
        thread_id: checkpoint.thread_id,
        state_version: checkpoint.state_version,
        summary: checkpoint.summary,
        updated_at: checkpoint.created_at,
        state: cloneRecord(checkpoint.state),
        ...(input.include_messages ? { messages: cloneRecord(checkpoint.messages) } : {}),
        ...(input.include_artifacts ? { artifacts: cloneRecord(checkpoint.artifacts) } : {}),
      });
    }

    return planStateSnapshotSchema.parse({
      plan_id: state.plan_id,
      namespace: state.namespace,
      status: state.status,
      checkpoint_id: state.checkpoint_id,
      thread_id: state.thread_id,
      state_version: state.state_version,
      summary: state.summary,
      updated_at: state.updated_at,
      state: cloneRecord(state.state),
      ...(input.include_messages ? { messages: cloneRecord(state.messages) } : {}),
      ...(input.include_artifacts ? { artifacts: cloneRecord(state.artifacts) } : {}),
    });
  }

  async writeState(input: PlanStateWriteInput): Promise<PlanStateWriteResult> {
    const namespace = this.resolveNamespace(input.namespace);
    return await this.withWriteLock(async () => {
      const existing = await this.readStateFile(input.plan_id, namespace);
      const base = existing ?? this.createEmptyState(input.plan_id, namespace);

      if (input.expected_state_version !== undefined) {
        const actualVersion = existing?.state_version ?? 0;
        if (actualVersion !== input.expected_state_version) {
          throw new GatewayToolError(
            "plan_state_version_conflict",
            `Expected state version ${input.expected_state_version} but found ${actualVersion}.`,
            {
              plan_id: input.plan_id,
              namespace,
              expected_state_version: input.expected_state_version,
              actual_state_version: actualVersion,
            },
            409,
          );
        }
      }

      const next = cloneRecord(base);
      const extractedPatch = this.extractStatePatch(input.state_patch);
      next.state = mergeRecords(next.state, extractedPatch.state);
      next.metadata = mergeRecords(next.metadata, input.metadata);
      next.tags = mergeTags(next.tags, input.tags);

      if (Object.prototype.hasOwnProperty.call(extractedPatch, "thread_id")) {
        next.thread_id = extractedPatch.thread_id ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(extractedPatch, "checkpoint_id")) {
        next.checkpoint_id = extractedPatch.checkpoint_id ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(extractedPatch, "messages")) {
        next.messages = cloneRecord(extractedPatch.messages ?? []);
      }
      if (Object.prototype.hasOwnProperty.call(extractedPatch, "artifacts")) {
        next.artifacts = cloneRecord(extractedPatch.artifacts ?? []);
      }
      if (input.status) {
        next.status = input.status;
      }
      if (input.summary !== undefined) {
        next.summary = input.summary;
      }

      const applied = existing === null || this.fingerprint(base) !== this.fingerprint(next);
      next.updated_at = applied ? new Date().toISOString() : (base.updated_at ?? new Date().toISOString());
      next.state_version = applied ? base.state_version + 1 : base.state_version;

      if (applied) {
        await this.writeStateFile(next);
      }

      return planStateWriteResultSchema.parse({
        plan_id: next.plan_id,
        namespace: next.namespace,
        status: next.status,
        state_version: next.state_version,
        checkpoint_id: next.checkpoint_id,
        applied,
        updated_at: next.updated_at,
      });
    });
  }

  async createCheckpoint(input: PlanStateCheckpointInput): Promise<PlanStateCheckpointResult> {
    const namespace = this.resolveNamespace(input.namespace);
    return await this.withWriteLock(async () => {
      const existing = await this.readStateFile(input.plan_id, namespace);
      if (!existing) {
        throw new GatewayToolError(
          "plan_state_not_found",
          `Plan state not found for ${input.plan_id}.`,
          { plan_id: input.plan_id, namespace },
          404,
        );
      }

      const createdAt = new Date().toISOString();
      const checkpointId = crypto.randomUUID();
      const checkpointStatus = this.checkpointStatus(existing.status);

      const checkpoint: StoredPlanCheckpoint = {
        checkpoint_id: checkpointId,
        label: input.label ?? null,
        summary: input.summary ?? existing.summary,
        status: checkpointStatus,
        thread_id: existing.thread_id,
        state_version: existing.state_version,
        created_at: createdAt,
        state: input.include_state ? cloneRecord(existing.state) : {},
        messages: input.include_state ? cloneRecord(existing.messages) : [],
        artifacts: input.include_state ? cloneRecord(existing.artifacts) : [],
        metadata: mergeRecords(existing.metadata, input.metadata),
      };

      const next = cloneRecord(existing);
      next.checkpoints.push(checkpoint);
      next.checkpoint_id = checkpointId;
      next.status = checkpointStatus;
      next.state_version = existing.state_version + 1;
      next.updated_at = createdAt;
      next.metadata = mergeRecords(next.metadata, {
        last_checkpoint: {
          checkpoint_id: checkpointId,
          label: input.label ?? null,
          created_at: createdAt,
        },
      });

      await this.writeStateFile(next);

      return planStateCheckpointResultSchema.parse({
        plan_id: next.plan_id,
        namespace: next.namespace,
        checkpoint_id: checkpointId,
        status: checkpointStatus,
        state_version: next.state_version,
        created_at: createdAt,
      });
    });
  }

  async resume(input: PlanStateResumeInput): Promise<PlanStateResumeResult> {
    const namespace = this.resolveNamespace(input.namespace);
    return await this.withWriteLock(async () => {
      const existing = await this.readStateFile(input.plan_id, namespace);
      if (!existing) {
        throw new GatewayToolError(
          "plan_state_not_found",
          `Plan state not found for ${input.plan_id}.`,
          { plan_id: input.plan_id, namespace },
          404,
        );
      }

      const checkpoint = existing.checkpoints.find((entry) => entry.checkpoint_id === input.checkpoint_id);
      if (!checkpoint) {
        throw new GatewayToolError(
          "plan_state_checkpoint_not_found",
          `Checkpoint ${input.checkpoint_id} was not found for ${input.plan_id}.`,
          { plan_id: input.plan_id, namespace, checkpoint_id: input.checkpoint_id },
          404,
        );
      }

      const resumedAt = new Date().toISOString();
      const next = cloneRecord(existing);
      next.state = cloneRecord(checkpoint.state);
      next.messages = cloneRecord(checkpoint.messages);
      next.artifacts = cloneRecord(checkpoint.artifacts);
      next.checkpoint_id = checkpoint.checkpoint_id;
      next.thread_id = input.target_thread_id ?? checkpoint.thread_id ?? existing.thread_id ?? crypto.randomUUID();
      next.status = "active";
      next.summary = input.resume_reason ?? checkpoint.summary ?? existing.summary;
      next.state_version = existing.state_version + 1;
      next.updated_at = resumedAt;
      next.metadata = mergeRecords(next.metadata, {
        last_resume: {
          checkpoint_id: checkpoint.checkpoint_id,
          resumed_at: resumedAt,
          resume_reason: input.resume_reason ?? null,
        },
      });

      await this.writeStateFile(next);

      return planStateResumeResultSchema.parse({
        plan_id: next.plan_id,
        namespace: next.namespace,
        checkpoint_id: checkpoint.checkpoint_id,
        resumed: true,
        status: next.status,
        thread_id: next.thread_id,
        state_version: next.state_version,
        resumed_at: resumedAt,
      });
    });
  }

  private async ensureReady(): Promise<void> {
    this.initialized ??= ensureDir(this.rootDir);
    await this.initialized;
  }

  private async waitForPendingWrites(): Promise<void> {
    await this.lock.catch(() => undefined);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    const previous = this.lock.catch(() => undefined);
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createEmptyState(planId: string, namespace: string): StoredPlanState {
    return {
      plan_id: planId,
      namespace,
      status: "draft",
      checkpoint_id: null,
      thread_id: null,
      state_version: 0,
      summary: null,
      updated_at: null,
      state: {},
      messages: [],
      artifacts: [],
      metadata: {},
      tags: [],
      checkpoints: [],
    };
  }

  private checkpointStatus(status: PlanStateStatus): PlanStateStatus {
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return status;
    }
    return "checkpointed";
  }

  private extractStatePatch(statePatch: Record<string, unknown>): ExtractedStatePatch {
    const extracted: ExtractedStatePatch = {
      state: {},
    };

    for (const [key, value] of Object.entries(statePatch)) {
      if (key === "thread_id" && (typeof value === "string" || value === null)) {
        extracted.thread_id = value;
        continue;
      }
      if (key === "checkpoint_id" && (typeof value === "string" || value === null)) {
        extracted.checkpoint_id = value;
        continue;
      }
      if (key === "messages") {
        extracted.messages = normalizeStructuredArray(value);
        continue;
      }
      if (key === "artifacts") {
        extracted.artifacts = normalizeStructuredArray(value);
        continue;
      }
      extracted.state[key] = cloneRecord(value);
    }

    return extracted;
  }

  private fingerprint(value: StoredPlanState): string {
    return JSON.stringify({
      status: value.status,
      checkpoint_id: value.checkpoint_id,
      thread_id: value.thread_id,
      summary: value.summary,
      state: value.state,
      messages: value.messages,
      artifacts: value.artifacts,
      metadata: value.metadata,
      tags: value.tags,
      checkpoints: value.checkpoints,
    });
  }

  private statePath(planId: string, namespace: string): string {
    return join(this.rootDir, encodeURIComponent(namespace), `${encodeURIComponent(planId)}.json`);
  }

  private async readStateFile(planId: string, namespace: string): Promise<StoredPlanState | null> {
    await this.ensureReady();
    const filePath = this.statePath(planId, namespace);
    try {
      const raw = await Deno.readTextFile(filePath);
      if (raw.trim().length === 0) {
        return null;
      }
      return JSON.parse(raw) as StoredPlanState;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  private async writeStateFile(state: StoredPlanState): Promise<void> {
    const filePath = this.statePath(state.plan_id, state.namespace);
    await ensureDir(dirname(filePath));
    await Deno.writeTextFile(filePath, JSON.stringify(state, null, 2));
  }
}
