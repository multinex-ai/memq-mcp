import type { AppConfig } from "../config.ts";
import type { Logger } from "../utils.ts";
import { withRetry } from "../utils.ts";
import type { RuntimeSliceRecord, SliceSearchResult, SliceStore, SliceStoreQuery } from "../slice_runtime.ts";
import { translateVector, vectorCollectionName, type VectorProfile, vectorProfileId } from "../vector_topology.ts";

type QdrantSlicePoint = {
  id: string;
  score?: number;
  payload?: Record<string, unknown>;
  vector?: number[];
};

type ProfileCollection = {
  profile: VectorProfile;
  collection: string;
};

export class QdrantSliceStore implements SliceStore {
  private readonly headers: HeadersInit;
  private readonly primaryProfile: VectorProfile;
  private readonly collections: ProfileCollection[];

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.QDRANT_API_KEY) headers["api-key"] = config.QDRANT_API_KEY;
    this.headers = headers;
    this.primaryProfile = config.SLICE_VECTOR_PROFILES[0];
    this.collections = config.SLICE_VECTOR_PROFILES.map((profile) => ({
      profile,
      collection: vectorCollectionName(config.SLICE_QDRANT_COLLECTION, profile, this.primaryProfile.id),
    }));
  }

  status(): Record<string, unknown> {
    return {
      primary_collection: this.config.SLICE_QDRANT_COLLECTION,
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

  async getByContentHash(namespace: string, contentHash: string): Promise<RuntimeSliceRecord | null> {
    const primary = this.collections[0];
    const url = `${this.config.QDRANT_URL}/collections/${primary.collection}/points/scroll`;
    const payload = {
      with_payload: true,
      with_vector: true,
      limit: 1,
      filter: {
        must: [
          { key: "namespace", match: { value: namespace } },
          { key: "content_hash", match: { value: contentHash } },
        ],
      },
    };

    return await withRetry(
      "qdrant_slice_find_by_hash",
      this.config.DB_RETRY_ATTEMPTS,
      this.config.DB_RETRY_BASE_DELAY_SECONDS,
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(`slice lookup failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json() as { result?: { points?: QdrantSlicePoint[] } };
        const point = data.result?.points?.[0];
        return point ? this.toSliceRecord(point) : null;
      },
      this.logger,
    );
  }

  async putMany(slices: RuntimeSliceRecord[]): Promise<{ stored: RuntimeSliceRecord[]; deduped: number }> {
    const stored: RuntimeSliceRecord[] = [];
    let deduped = 0;

    for (const slice of slices) {
      const existing = await this.getByContentHash(slice.namespace, slice.content_hash);
      if (existing) {
        deduped += 1;
        continue;
      }
      stored.push(slice);
    }

    if (stored.length === 0) {
      return { stored: [], deduped };
    }

    await Promise.all(this.collections.map(async ({ collection, profile }) => {
      const url = `${this.config.QDRANT_URL}/collections/${collection}/points?wait=true`;
      const payload = {
        points: stored.map((slice) => ({
          id: slice.id,
          vector: translateVector(slice.embedding, this.primaryProfile, profile),
          payload: {
            id: slice.id,
            namespace: slice.namespace,
            source_key: slice.source_key,
            source_kind: slice.source_kind,
            sequence: slice.sequence,
            text: slice.text,
            token_estimate: slice.token_estimate,
            content_hash: slice.content_hash,
            created_at: slice.created_at,
            metadata: slice.metadata,
            source_ref: slice.source_ref ?? null,
            embedding_provider: profile.provider,
            embedding_model: profile.model,
            embedding_dimension: profile.dimension,
            vector_profile: profile.id,
            canonical_vector_profile: this.primaryProfile.id,
          },
        })),
      };

      await withRetry(
        "qdrant_slice_upsert",
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
            throw new Error(`slice upsert failed: ${res.status} ${await res.text()}`);
          }
        },
        this.logger,
      );
    }));

    return { stored, deduped };
  }

  async search(query: SliceStoreQuery): Promise<SliceSearchResult[]> {
    const sourceProfile = this.resolveSourceProfile(query.vector);
    const sourceKeys = query.source_keys ? new Set(query.source_keys) : null;
    const sourceKinds = query.source_kinds ? new Set(query.source_kinds) : null;
    const minScore = query.minScore ?? 0;

    const points = await Promise.all(this.collections.map(async ({ collection, profile }) => {
      const payload = {
        vector: translateVector(query.vector, sourceProfile, profile),
        limit: Math.max(query.limit * 4, query.limit),
        with_payload: true,
        with_vector: true,
        filter: {
          must: [{ key: "namespace", match: { value: query.namespace } }],
        },
      };
      const url = `${this.config.QDRANT_URL}/collections/${collection}/points/search`;

      return await withRetry(
        "qdrant_slice_search",
        this.config.DB_RETRY_ATTEMPTS,
        this.config.DB_RETRY_BASE_DELAY_SECONDS,
        async () => {
          const res = await fetch(url, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
          });
          if (!res.ok) {
            throw new Error(`slice search failed: ${res.status} ${await res.text()}`);
          }
          const data = await res.json() as { result?: QdrantSlicePoint[] };
          return data.result ?? [];
        },
        this.logger,
      );
    }));

    const merged = new Map<string, QdrantSlicePoint>();
    for (const group of points) {
      for (const point of group) {
        const current = merged.get(String(point.id));
        if (!current || Number(point.score ?? 0) > Number(current.score ?? 0)) {
          merged.set(String(point.id), point);
        }
      }
    }

    return [...merged.values()]
      .map((point) => ({
        ...this.toSliceRecord(point),
        score: Number(point.score ?? 0),
      }))
      .filter((slice) => slice.score >= minScore)
      .filter((slice) => !sourceKeys || sourceKeys.has(slice.source_key))
      .filter((slice) => !sourceKinds || sourceKinds.has(slice.source_kind))
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit);
  }

  private async ensureCollection(collection: string, profile: VectorProfile): Promise<void> {
    const url = `${this.config.QDRANT_URL}/collections/${collection}`;
    const body = {
      vectors: {
        size: profile.dimension,
        distance: "Cosine",
      },
    };

    await withRetry(
      "qdrant_slice_init",
      this.config.DB_RETRY_ATTEMPTS,
      this.config.DB_RETRY_BASE_DELAY_SECONDS,
      async () => {
        const res = await fetch(url, {
          method: "PUT",
          headers: this.headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.QDRANT_TIMEOUT_MS),
        });
        if (res.status === 409) {
          return;
        }
        if (!res.ok) {
          throw new Error(`slice collection init failed: ${res.status} ${await res.text()}`);
        }
      },
      this.logger,
    );
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

  private toSliceRecord(point: QdrantSlicePoint): RuntimeSliceRecord {
    const payload = point.payload ?? {};
    const storedProfile = this.profileFromPayload(payload);
    const storedVector = Array.isArray(point.vector) ? point.vector.map((value) => Number(value)) : [];
    return {
      id: String(payload.id ?? point.id),
      namespace: String(payload.namespace ?? "default"),
      source_key: String(payload.source_key ?? "slice"),
      source_kind: String(payload.source_kind ?? "document") as RuntimeSliceRecord["source_kind"],
      sequence: Number(payload.sequence ?? 0),
      text: String(payload.text ?? ""),
      token_estimate: Number(payload.token_estimate ?? 0),
      content_hash: String(payload.content_hash ?? ""),
      created_at: String(payload.created_at ?? new Date().toISOString()),
      metadata: (payload.metadata ?? {}) as Record<string, unknown>,
      source_ref: payload.source_ref && typeof payload.source_ref === "object"
        ? {
          id: String((payload.source_ref as Record<string, unknown>).id ?? ""),
          kind: String((payload.source_ref as Record<string, unknown>).kind ?? "slice"),
        }
        : undefined,
      embedding: storedVector.length > 0 ? translateVector(storedVector, storedProfile, this.primaryProfile) : [],
      embedding_provider: String(payload.embedding_provider ?? this.primaryProfile.provider),
      embedding_model: String(payload.embedding_model ?? this.primaryProfile.model),
      embedding_dimension: Number(payload.embedding_dimension ?? this.primaryProfile.dimension),
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
