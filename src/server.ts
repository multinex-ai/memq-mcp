import { Application, type Context, Router } from "oak";
import { loadConfig } from "./config.ts";
import { MNEMOSYNE_GATEWAY_RUNTIME_VERSION } from "./build_info.ts";
import { createLogger } from "./utils.ts";
import { MemoryService } from "./memory_service.ts";
import { McpHandler } from "./mcp.ts";
import { GatewayTelemetry } from "./telemetry.ts";
import { ClientRegistry, type RegisteredClient } from "./client_registry.ts";

function json(ctx: Context, status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>) {
  ctx.response.status = status;
  ctx.response.type = "application/json";
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    ctx.response.headers.set(k, v);
  }
  ctx.response.body = body;
}

function oauthProtectedResourceMetadata(
  config: ReturnType<typeof loadConfig>,
  origin: string,
): Record<string, unknown> {
  return {
    resource: `${origin}/mcp/v1`,
    authorization_servers: [
      config.OAUTH_AUTHORIZATION_SERVER_URL || config.BILLING_MANAGER_URL || "https://billing.multinex.ai",
    ],
    scopes_supported: ["mnemosyne.mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://multinex.ai/mnemosyne",
  };
}

function oauthUnauthorizedHeaders(origin: string): Record<string, string> {
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp/v1`;
  return {
    "WWW-Authenticate": `Bearer realm="mnemosyne", scope="mnemosyne.mcp", resource_metadata="${resourceMetadataUrl}"`,
  };
}

export async function runServer(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const telemetry = new GatewayTelemetry(config, logger);
  const memory = new MemoryService(config, logger);
  const mcp = new McpHandler(memory, config, logger, telemetry);
  const clientRegistry = new ClientRegistry(logger, {
    maxClients: config.MAX_SSE_CONNECTIONS * 2,
    staleThresholdMs: 5 * 60 * 1000,
    pruneIntervalMs: 60 * 1000,
    heartbeatIntervalMs: 15 * 1000,
  });

  await memory.startup();
  clientRegistry.start();

  const app = new Application();
  const router = new Router();

  const sessions = new Map<string, number>();

  async function withRouteTelemetry(
    ctx: Context,
    route: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await telemetry.runSpan(
        `mnemosyne.http.${ctx.request.method.toLowerCase()}.${route.replaceAll("/", ".").replaceAll(":", "")}`,
        {
          "http.request.method": ctx.request.method,
          "url.path": route,
          release_channel: config.RELEASE_CHANNEL,
          require_auth: config.REQUIRE_AUTH,
          ...attributes,
        },
        async () => {
          await fn();
        },
      );
    } catch (error) {
      if (!ctx.response.status) {
        ctx.response.status = 500;
      }
      throw error;
    } finally {
      telemetry.recordHttpRequest(route, ctx.request.method, ctx.response.status || 500, Date.now() - startedAt, {
        release_channel: config.RELEASE_CHANNEL,
        require_auth: config.REQUIRE_AUTH,
        ...attributes,
      });
    }
  }

  router.get("/health", async (ctx: any) => {
    await withRouteTelemetry(ctx, "/health", {}, async () => {
      const detail = await memory.health();
      const quantum = memory.quantumStatus();
      const registryStats = clientRegistry.stats();
      const allHealthy = Object.values(detail).every((value) => value === "ok");
      json(ctx, allHealthy ? 200 : 503, {
        status: allHealthy ? "ok" : "degraded",
        service: "mnemosyne",
        server_version: MNEMOSYNE_GATEWAY_RUNTIME_VERSION,
        release_channel: config.RELEASE_CHANNEL,
        require_auth: config.REQUIRE_AUTH,
        multinex_channel: config.MULTINEX_CHANNEL,
        marketplace_provider: config.MULTINEX_MARKETPLACE_PROVIDER || null,
        marketplace_offer: config.MULTINEX_MARKETPLACE_OFFER || null,
        marketplace_plan: config.MULTINEX_MARKETPLACE_PLAN || null,
        ...detail,
        vector_dim: String(config.VECTOR_DIM),
        vector_profiles: JSON.stringify(config.VECTOR_PROFILES),
        graph_mirrors: JSON.stringify(config.FALKOR_GRAPH_NAMES),
        auto_reflect_every: String(config.AUTO_REFLECT_EVERY),
        similarity_dedup_threshold: String(config.SIMILARITY_DEDUP_THRESHOLD),
        quantum_entropy_mode: String(quantum.mode ?? "off"),
        quantum_entropy_active: String(Boolean(quantum.active)),
        quantum_entropy_provider: String(quantum.provider ?? "none"),
        active_sse_connections: String(registryStats.sse),
        active_http_clients: String(registryStats.http),
        total_registered_clients: String(registryStats.total),
        max_sse_connections: String(config.MAX_SSE_CONNECTIONS),
        shutdown_in_progress: String(registryStats.shutdownInProgress),
      });
    });
  });

  router.get("/.well-known/oauth-protected-resource", (ctx: any) => {
    json(ctx, 200, oauthProtectedResourceMetadata(config, ctx.request.url.origin));
  });

  router.get("/.well-known/oauth-protected-resource/mcp/v1", (ctx: any) => {
    json(ctx, 200, oauthProtectedResourceMetadata(config, ctx.request.url.origin));
  });

  router.post("/mcp/v1", async (ctx: any) => {
    await withRouteTelemetry(ctx, "/mcp/v1", {}, async () => {
      const auth = await mcp.verifyAuth(mcp.extractToken(ctx.request.headers));
      if (!auth) {
        json(ctx, 401, { error: "Unauthorized" }, oauthUnauthorizedHeaders(ctx.request.url.origin));
        return;
      }

      const body = await ctx.request.body({ type: "json" }).value;
      const maybeBody = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const method = typeof maybeBody.method === "string" ? maybeBody.method : "";

      const sessionHeader = ctx.request.headers.get("Mcp-Session-Id");
      let sessionId = sessionHeader;

      if (!sessionId && method === "initialize") {
        sessionId = crypto.randomUUID();
        sessions.set(sessionId, Date.now());
      }

      const response = await mcp.handleRaw(body, auth) as Record<string, unknown>;
      json(ctx, 200, response, sessionId ? { "Mcp-Session-Id": sessionId } : undefined);
    });
  });

  router.get("/sse", async (ctx: any) => {
    await withRouteTelemetry(ctx, "/sse", {}, async () => {
      const auth = await mcp.verifyAuth(mcp.extractToken(ctx.request.headers));
      if (!auth) {
        json(ctx, 401, { error: "Unauthorized" }, oauthUnauthorizedHeaders(ctx.request.url.origin));
        return;
      }

      const registryStats = clientRegistry.stats();
      if (registryStats.sse >= config.MAX_SSE_CONNECTIONS) {
        json(ctx, 503, { error: "Too many active SSE connections" });
        return;
      }

      if (registryStats.shutdownInProgress) {
        json(ctx, 503, { error: "Server is shutting down", retry_after_ms: 5000 });
        return;
      }

      const sessionId = crypto.randomUUID();
      const clientId = crypto.randomUUID();
      sessions.set(sessionId, Date.now());

      let heartbeatInterval: number | null = null;
      let registeredClient: RegisteredClient | null = null;

      const cleanup = () => {
        if (heartbeatInterval !== null) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        sessions.delete(sessionId);
        clientRegistry.unregister(clientId);
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();

          registeredClient = {
            clientId,
            sessionId,
            clientName: ctx.request.headers.get("X-Client-Name") || undefined,
            clientVersion: ctx.request.headers.get("X-Client-Version") || undefined,
            capabilities: [],
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            auth,
            sseController: controller,
            connectionType: "sse",
          };

          if (!clientRegistry.register(registeredClient)) {
            controller.close();
            return;
          }

          controller.enqueue(enc.encode(`event: endpoint\ndata: /messages/${sessionId}\n\n`));
          controller.enqueue(enc.encode(`event: client_id\ndata: ${clientId}\n\n`));

          heartbeatInterval = setInterval(async () => {
            try {
              const health = await memory.health();
              const allHealthy = Object.values(health).every((v) => v === "ok");

              const heartbeat = {
                ts: Date.now(),
                status: allHealthy ? "ok" : "degraded",
                backends: health,
                server_version: MNEMOSYNE_GATEWAY_RUNTIME_VERSION,
              };

              controller.enqueue(enc.encode(`event: heartbeat\ndata: ${JSON.stringify(heartbeat)}\n\n`));
              clientRegistry.touch(clientId);
            } catch {
              cleanup();
              controller.close();
            }
          }, 15000);
        },
        cancel() {
          cleanup();
        },
      });

      ctx.response.status = 200;
      ctx.response.headers.set("Content-Type", "text/event-stream");
      ctx.response.headers.set("Cache-Control", "no-cache");
      ctx.response.headers.set("Connection", "keep-alive");
      ctx.response.headers.set("X-Mnemosyne-Client-Id", clientId);
      ctx.response.body = stream;
    });
  });

  async function handleMessage(ctx: Context, routeSessionId?: string) {
    await withRouteTelemetry(ctx, routeSessionId ? "/messages/:sessionId" : "/messages", {
      session_bound: Boolean(routeSessionId),
    }, async () => {
      const auth = await mcp.verifyAuth(mcp.extractToken(ctx.request.headers));
      if (!auth) {
        json(ctx, 401, { error: "Unauthorized" }, oauthUnauthorizedHeaders(ctx.request.url.origin));
        return;
      }

      const headerSession = ctx.request.headers.get("Mcp-Session-Id");
      const sessionId = routeSessionId ?? headerSession;
      if (sessionId && !sessions.has(sessionId)) {
        json(ctx, 404, { error: "Session not found" });
        return;
      }

      const body = await ctx.request.body({ type: "json" }).value;
      const response = await mcp.handleRaw(body, auth) as Record<string, unknown>;
      json(ctx, 200, response);
    });
  }

  router.post("/messages", async (ctx: any) => {
    await handleMessage(ctx);
  });

  router.post("/messages/:sessionId", async (ctx: any) => {
    await handleMessage(ctx, ctx.params.sessionId);
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  app.addEventListener("error", (event) => {
    logger.error("server_error", { error: String(event.error) });
  });

  logger.info("gateway_boot", {
    port: config.PORT,
    qdrant_url: config.QDRANT_URL,
    falkor_url: config.FALKOR_REDIS_URL,
    release_channel: config.RELEASE_CHANNEL,
    require_auth: config.REQUIRE_AUTH,
    server_version: MNEMOSYNE_GATEWAY_RUNTIME_VERSION,
  });

  const gracefulShutdownTimeoutMs = 30_000;
  const clientReconnectDelayMs = 5_000;

  const stop = async (signal: string) => {
    logger.info("gateway_shutdown_start", { signal });

    // Notify all connected SSE clients about impending shutdown
    const notified = await clientRegistry.broadcastShutdown(
      `graceful_shutdown_${signal.toLowerCase()}`,
      clientReconnectDelayMs,
    );
    logger.info("shutdown_clients_notified", { count: notified });

    // Give clients a moment to receive the notification
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Drain in-flight HTTP requests
    await clientRegistry.gracefulDrain(gracefulShutdownTimeoutMs);

    // Stop the client registry (clears prune interval)
    clientRegistry.stop();

    // Shutdown backends
    await memory.shutdown();
    await telemetry.shutdown();

    logger.info("gateway_shutdown_complete");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGTERM", () => stop("SIGTERM"));
  Deno.addSignalListener("SIGINT", () => stop("SIGINT"));

  await app.listen({ port: config.PORT });
}
