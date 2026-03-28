type PointPayload = Record<string, unknown>;

type PointRecord = {
  id: string;
  vector: number[];
  payload: PointPayload;
};

type CollectionRecord = {
  points: Map<string, PointRecord>;
};

const PORT = Number(Deno.env.get("QDRANT_MOCK_PORT") ?? "6333");
const collections = new Map<string, CollectionRecord>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getCollection(name: string): CollectionRecord {
  let collection = collections.get(name);
  if (!collection) {
    collection = { points: new Map() };
    collections.set(name, collection);
  }
  return collection;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchFilter(point: PointRecord, filter: Record<string, unknown> | undefined): boolean {
  const must = Array.isArray(filter?.must) ? filter.must : [];
  for (const clause of must) {
    const key = typeof clause?.key === "string" ? clause.key : "";
    const expected = clause?.match && typeof clause.match === "object" ? clause.match.value : undefined;
    if (!key) {
      continue;
    }
    if (point.payload[key] !== expected) {
      return false;
    }
  }
  return true;
}

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(200, { title: "ok" });
  }

  if (parts[0] !== "collections" || parts.length < 2) {
    return json(404, { status: "error", message: "not found" });
  }

  const collectionName = parts[1];
  const collection = getCollection(collectionName);

  if (request.method === "PUT" && parts.length === 2) {
    return json(200, { status: "ok", result: true });
  }

  if (request.method === "PUT" && parts[2] === "points") {
    const body = await request.json();
    const points = Array.isArray(body?.points) ? body.points : [];
    for (const point of points) {
      const id = String(point?.id ?? crypto.randomUUID());
      collection.points.set(id, {
        id,
        vector: Array.isArray(point?.vector) ? point.vector.map((value: unknown) => Number(value)) : [],
        payload: typeof point?.payload === "object" && point.payload !== null ? point.payload as PointPayload : {},
      });
    }
    return json(200, { status: "ok", result: { operation_id: 1 } });
  }

  if (request.method === "POST" && parts[2] === "points" && parts[3] === "payload") {
    const body = await request.json();
    const pointIds = Array.isArray(body?.points) ? body.points.map((value: unknown) => String(value)) : [];
    const payload = typeof body?.payload === "object" && body.payload !== null ? body.payload as PointPayload : {};
    for (const pointId of pointIds) {
      const current = collection.points.get(pointId);
      if (!current) {
        continue;
      }
      collection.points.set(pointId, {
        ...current,
        payload: { ...current.payload, ...payload },
      });
    }
    return json(200, { status: "ok", result: { operation_id: 1 } });
  }

  if (request.method === "POST" && parts[2] === "points" && parts[3] === "scroll") {
    const body = await request.json();
    const limit = Number(body?.limit ?? 10);
    const withVector = Boolean(body?.with_vector);
    const matched = [...collection.points.values()]
      .filter((point) => matchFilter(point, body?.filter))
      .slice(0, Math.max(0, limit))
      .map((point) => ({
        id: point.id,
        payload: point.payload,
        ...(withVector ? { vector: point.vector } : {}),
      }));
    return json(200, { status: "ok", result: { points: matched, next_page_offset: null } });
  }

  if (request.method === "POST" && parts[2] === "points" && parts[3] === "search") {
    const body = await request.json();
    const vector = Array.isArray(body?.vector) ? body.vector.map((value: unknown) => Number(value)) : [];
    const limit = Number(body?.limit ?? 10);
    const withVector = Boolean(body?.with_vector);
    const results = [...collection.points.values()]
      .map((point) => ({
        id: point.id,
        score: cosineSimilarity(vector, point.vector),
        payload: point.payload,
        ...(withVector ? { vector: point.vector } : {}),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit));
    return json(200, { status: "ok", result: results });
  }

  if (request.method === "GET" && parts[2] === "points" && parts[3]) {
    const point = collection.points.get(parts[3]);
    if (!point) {
      return json(404, { status: "error", message: "point not found" });
    }
    return json(200, {
      status: "ok",
      result: {
        id: point.id,
        payload: point.payload,
        vector: point.vector,
      },
    });
  }

  return json(404, { status: "error", message: "not found" });
});
