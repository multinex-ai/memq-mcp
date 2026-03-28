import type { AppConfig } from "../config.ts";
import type { MemoryRecord } from "../types.ts";
import type { Logger } from "../utils.ts";
import { withRetry } from "../utils.ts";
import { translateVector, vectorCollectionName, type VectorProfile, vectorProfileId } from "../vector_topology.ts";

type QdrantPoint = {
  id: string;
  score?: number;
  payload?: Record<string, unknown>;
  vector?: number[];
};

type ProfileCollection = {
  profile: VectorProfile;
  collection: string;
};

export class QdrantAdapter {
  private readonly headers: HeadersInit;
  private readonly primaryProfile: VectorProfile;
  private readonly collections: ProfileCollection[];

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.QDRANT_API_KEY) headers["api-key"] = config.QDRANT_API_KEY;
    this.headers = headers;
    this.primaryProfile = config.VECTOR_PROFILES[0];
    this.collections = config.VECTOR_PROFILES.map((profile) => ({
      profile,
      collection: vectorCollectionName(config.QDRANT_COLLECTION, profile, this.primaryProfile.id),
    }));
  }

  status(): Record<string, unknown> {
    return {
      primary_collection: this.config.QDRANT_COLLECTION,
      profiles: this.collections.map(({ profile, collection }) => ({
        collection,
        profile,
        primary: profile.id === this.primaryProfile.id,
      })),
    };
  }

  async init(): Promise<void> {
    await Promise.all(this.collections.map(({ collection, profile }) => this.ensureCollection(collection, profile)));
  }

  async health(): Promise<void> {
    const url = `${this.config.QDRANT_URL}/healthz`;
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`qdrant health failed: ${res.status}`);
  }

  async upsertMemory(record: MemoryRecord): Promise<void> {
    await Promise.all(this.collections.map(async ({ collection, profile }) => {
      const url = `${this.config.QDRANT_URL}/collections/${collection}/points?wait=true`;
      const vector = translateVector(record.embedding, this.primaryProfile, profile);
      const payload = {
        points: [{
          id: record.id,
          vector,
          payload: {
            id: record.id,
            agent_id: record.agent_id,
            memory_type: record.memory_type,
            task_id: record.task_id,
            tags: record.tags,
            text: record.text,
            created_at: record.created_at,
            content_hash: record.content_hash,
            reinforcement_count: record.reinforcement_count,
            metadata: record.metadata,
            embedding_provider: profile.provider,
            embedding_model: profile.model,
            embedding_dimension: profile.dimension,
            vector_profile: profile.id,
            canonical_vector_profile: this.primaryProfile.id,
          },
        }],
      };

      await withRetry(
        "qdrant_upsert",
        this.config.DB_RETRY_ATTEMPTS,
        this.config.DB_RETRY_BASE_DELAY_SECONDS,
        async () => {
          const res = await fetch(url, {
            method: "PUT",
            headers: this.headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
          });
          if (!res.ok) {
            throw new Error(`qdrant upsert failed: ${res.status} ${await res.text()}`);
          }
        },
        this.logger,
      );
    }));
  }

  async incrementReinforcement(id: string): Promise<void> {
    await Promise.all(this.collections.map(async ({ collection }) => {
      const url = `${this.config.QDRANT_URL}/collections/${collection}/points/payload?wait=true`;
      const payload = {
        points: [id],
        payload: {
          reinforcement_count: 2,
        },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn("qdrant_increment_reinforcement_failed", { id, collection, status: res.status });
      }
    }));
  }

  async findByContentHash(contentHash: string): Promise<MemoryRecord | null> {
    const primary = this.collections[0];
    const url = `${this.config.QDRANT_URL}/collections/${primary.collection}/points/scroll`;
    const payload = {
      with_payload: true,
      with_vector: true,
      limit: 1,
      filter: {
        must: [{
          key: "content_hash",
          match: { value: contentHash },
        }],
      },
    };

    return await withRetry(
      "qdrant_find_by_hash",
      this.config.DB_RETRY_ATTEMPTS,
      this.config.DB_RETRY_BASE_DELAY_SECONDS,
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`qdrant find hash failed: ${res.status} ${await res.text()}`);
        const data = await res.json() as { result?: { points?: QdrantPoint[] } };
        const points = data.result?.points ?? [];
        if (points.length === 0) return null;
        return this.toMemoryRecord(points[0]);
      },
      this.logger,
    );
  }

  async findById(id: string): Promise<MemoryRecord | null> {
    const primary = this.collections[0];
    const url =
      `${this.config.QDRANT_URL}/collections/${primary.collection}/points/${id}?with_payload=true&with_vector=true`;

    return await withRetry(
      "qdrant_find_by_id",
      this.config.DB_RETRY_ATTEMPTS,
      this.config.DB_RETRY_BASE_DELAY_SECONDS,
      async () => {
        const res = await fetch(url, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`qdrant find by id failed: ${res.status} ${await res.text()}`);
        const data = await res.json() as { result?: QdrantPoint | null };
        if (!data.result) return null;
        return this.toMemoryRecord(data.result);
      },
      this.logger,
    );
  }

  async findNearest(vector: number[]): Promise<{ record: MemoryRecord; similarity: number } | null> {
    const points = await this.searchPointsAcrossProfiles(vector, 1, true);
    if (points.length === 0) {
      return null;
    }
    return {
      record: this.toMemoryRecord(points[0]),
      similarity: Number(points[0].score ?? 0),
    };
  }

  async search(vector: number[], limit: number): Promise<Array<MemoryRecord & { similarity: number }>> {
    const points = await this.searchPointsAcrossProfiles(vector, limit, false);
    return points.map((point) => ({ ...this.toMemoryRecord(point), similarity: Number(point.score ?? 0) }));
  }

  private async ensureCollection(collection: string, profile: VectorProfile): Promise<void> {
    const url = `${this.config.QDRANT_URL}/collections/${collection}`;
    const body = {
      vectors: {
        size: profile.dimension,
        distance: "Cosine",
      },
    };

    await withRetry("qdrant_init", this.config.DB_RETRY_ATTEMPTS, this.config.DB_RETRY_BASE_DELAY_SECONDS, async () => {
      const res = await fetch(url, {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
      });
      if (res.status === 409) {
        return undefined;
      }
      if (!res.ok) {
        throw new Error(`qdrant init failed: ${res.status} ${await res.text()}`);
      }
      return undefined;
    }, this.logger);
  }

  private resolveSourceProfile(vector: number[]): VectorProfile {
    if (vector.length === this.primaryProfile.dimension) {
      return this.primaryProfile;
    }
    const exact = this.collections.find(({ profile }) => profile.dimension === vector.length);
    if (exact) {
      return exact.profile;
    }
    return {
      provider: this.primaryProfile.provider,
      model: this.primaryProfile.model,
      dimension: vector.length,
      id: vectorProfileId(this.primaryProfile.provider, `${this.primaryProfile.model}-adhoc`, vector.length),
    };
  }

  private async searchPointsAcrossProfiles(
    vector: number[],
    limit: number,
    withVector: boolean,
  ): Promise<QdrantPoint[]> {
    const sourceProfile = this.resolveSourceProfile(vector);
    const results = await Promise.all(this.collections.map(async ({ collection, profile }) => {
      const translated = translateVector(vector, sourceProfile, profile);
      const url = `${this.config.QDRANT_URL}/collections/${collection}/points/search`;
      const payload = {
        vector: translated,
        limit: Math.max(limit * 3, limit),
        with_payload: true,
        with_vector: withVector,
      };

      return await withRetry(
        "qdrant_search",
        this.config.DB_RETRY_ATTEMPTS,
        this.config.DB_RETRY_BASE_DELAY_SECONDS,
        async () => {
          const res = await fetch(url, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`qdrant search failed: ${res.status} ${await res.text()}`);
          const data = await res.json() as { result?: QdrantPoint[] };
          return data.result ?? [];
        },
        this.logger,
      );
    }));

    const merged = new Map<string, QdrantPoint>();
    for (const points of results) {
      for (const point of points) {
        const current = merged.get(String(point.id));
        if (!current || Number(point.score ?? 0) > Number(current.score ?? 0)) {
          merged.set(String(point.id), point);
        }
      }
    }

    return [...merged.values()]
      .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0))
      .slice(0, limit);
  }

  private toMemoryRecord(point: QdrantPoint): MemoryRecord {
    const payload = point.payload ?? {};
    const storedProfile = this.profileFromPayload(payload);
    const storedVector = Array.isArray(point.vector) ? point.vector.map((value) => Number(value)) : [];
    return {
      id: String(payload.id ?? point.id),
      agent_id: String(payload.agent_id ?? "unknown"),
      memory_type: String(payload.memory_type ?? "episodic"),
      task_id: payload.task_id === null || payload.task_id === undefined ? null : String(payload.task_id),
      tags: Array.isArray(payload.tags) ? payload.tags.map((value) => String(value)) : [],
      text: String(payload.text ?? ""),
      created_at: String(payload.created_at ?? new Date().toISOString()),
      content_hash: String(payload.content_hash ?? ""),
      reinforcement_count: Number(payload.reinforcement_count ?? 1),
      metadata: (payload.metadata ?? {}) as Record<string, unknown>,
      embedding: storedVector.length > 0 ? translateVector(storedVector, storedProfile, this.primaryProfile) : [],
    };
  }

  private profileFromPayload(payload: Record<string, unknown>): VectorProfile {
    const provider = String(payload.embedding_provider ?? this.primaryProfile.provider);
    const model = String(payload.embedding_model ?? this.primaryProfile.model);
    const dimension = Number(payload.embedding_dimension ?? this.primaryProfile.dimension);
    return {
      provider,
      model,
      dimension,
      id: String(payload.vector_profile ?? vectorProfileId(provider, model, dimension)),
    };
  }
}
