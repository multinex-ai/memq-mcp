import type { Logger } from "./utils.ts";
import type { GatewayAuthContext } from "./types.ts";

export type ServerEventType =
  | "server_shutdown"
  | "server_degraded"
  | "server_recovered"
  | "backend_degraded"
  | "backend_recovered";

export interface ServerEvent {
  type: ServerEventType;
  timestamp: string;
  reconnectAfterMs?: number;
  reason?: string;
  backend?: string;
  details?: Record<string, unknown>;
}

export interface RegisteredClient {
  clientId: string;
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  capabilities: string[];
  connectedAt: number;
  lastActivity: number;
  auth: GatewayAuthContext | null;
  sseController?: ReadableStreamDefaultController<Uint8Array>;
  connectionType: "sse" | "http";
}

export interface ClientRegistryConfig {
  maxClients: number;
  staleThresholdMs: number;
  pruneIntervalMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_CONFIG: ClientRegistryConfig = {
  maxClients: 1000,
  staleThresholdMs: 5 * 60 * 1000,
  pruneIntervalMs: 60 * 1000,
  heartbeatIntervalMs: 15 * 1000,
};

export class ClientRegistry {
  private clients = new Map<string, RegisteredClient>();
  private pruneInterval: number | null = null;
  private readonly config: ClientRegistryConfig;
  private shutdownInProgress = false;

  constructor(
    private readonly logger: Logger,
    config: Partial<ClientRegistryConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.pruneInterval) return;

    this.pruneInterval = setInterval(() => {
      this.pruneStale();
    }, this.config.pruneIntervalMs);

    this.logger.info("client_registry_started", {
      max_clients: this.config.maxClients,
      stale_threshold_ms: this.config.staleThresholdMs,
      prune_interval_ms: this.config.pruneIntervalMs,
    });
  }

  stop(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    this.logger.info("client_registry_stopped", {
      active_clients: this.clients.size,
    });
  }

  register(client: RegisteredClient): boolean {
    if (this.shutdownInProgress) {
      this.logger.warn("client_register_rejected_shutdown", {
        client_id: client.clientId,
      });
      return false;
    }

    if (this.clients.size >= this.config.maxClients) {
      this.logger.warn("client_register_rejected_capacity", {
        client_id: client.clientId,
        current_clients: this.clients.size,
        max_clients: this.config.maxClients,
      });
      return false;
    }

    this.clients.set(client.clientId, client);

    this.logger.info("client_registered", {
      client_id: client.clientId,
      session_id: client.sessionId,
      client_name: client.clientName,
      connection_type: client.connectionType,
      total_clients: this.clients.size,
    });

    return true;
  }

  unregister(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);

    this.logger.info("client_unregistered", {
      client_id: clientId,
      session_id: client.sessionId,
      connection_duration_ms: Date.now() - client.connectedAt,
      total_clients: this.clients.size,
    });
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  touch(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastActivity = Date.now();
    }
  }

  getBySession(sessionId: string): RegisteredClient | undefined {
    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId) {
        return client;
      }
    }
    return undefined;
  }

  getSseClients(): RegisteredClient[] {
    return Array.from(this.clients.values()).filter(
      (c) => c.connectionType === "sse" && c.sseController,
    );
  }

  async broadcast(event: ServerEvent): Promise<number> {
    const sseClients = this.getSseClients();
    if (sseClients.length === 0) return 0;

    const encoder = new TextEncoder();
    const eventData = encoder.encode(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );

    let delivered = 0;

    for (const client of sseClients) {
      try {
        client.sseController?.enqueue(eventData);
        delivered++;
      } catch (error) {
        this.logger.warn("broadcast_failed", {
          client_id: client.clientId,
          event_type: event.type,
          error: String(error),
        });
        this.unregister(client.clientId);
      }
    }

    this.logger.info("broadcast_complete", {
      event_type: event.type,
      total_sse_clients: sseClients.length,
      delivered,
    });

    return delivered;
  }

  async broadcastShutdown(reason: string, reconnectAfterMs: number): Promise<number> {
    this.shutdownInProgress = true;

    const event: ServerEvent = {
      type: "server_shutdown",
      timestamp: new Date().toISOString(),
      reason,
      reconnectAfterMs,
      details: {
        active_clients: this.clients.size,
        sse_clients: this.getSseClients().length,
      },
    };

    const delivered = await this.broadcast(event);

    this.logger.info("shutdown_broadcast_complete", {
      reason,
      reconnect_after_ms: reconnectAfterMs,
      clients_notified: delivered,
    });

    return delivered;
  }

  async broadcastBackendStatus(
    backend: string,
    status: "degraded" | "recovered",
    details?: Record<string, unknown>,
  ): Promise<number> {
    const event: ServerEvent = {
      type: status === "degraded" ? "backend_degraded" : "backend_recovered",
      timestamp: new Date().toISOString(),
      backend,
      details,
    };

    return await this.broadcast(event);
  }

  pruneStale(): number {
    const now = Date.now();
    const threshold = now - this.config.staleThresholdMs;
    let pruned = 0;

    for (const [clientId, client] of this.clients.entries()) {
      if (client.lastActivity < threshold) {
        this.logger.info("client_pruned_stale", {
          client_id: clientId,
          session_id: client.sessionId,
          last_activity_ms_ago: now - client.lastActivity,
        });
        this.clients.delete(clientId);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.info("stale_prune_complete", {
        pruned,
        remaining: this.clients.size,
      });
    }

    return pruned;
  }

  stats(): {
    total: number;
    sse: number;
    http: number;
    shutdownInProgress: boolean;
  } {
    const sseCount = this.getSseClients().length;
    return {
      total: this.clients.size,
      sse: sseCount,
      http: this.clients.size - sseCount,
      shutdownInProgress: this.shutdownInProgress,
    };
  }

  async gracefulDrain(timeoutMs: number): Promise<void> {
    this.shutdownInProgress = true;

    const start = Date.now();
    const checkInterval = 100;

    while (Date.now() - start < timeoutMs) {
      const httpClients = this.clients.size - this.getSseClients().length;
      if (httpClients === 0) {
        this.logger.info("graceful_drain_complete", {
          elapsed_ms: Date.now() - start,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    this.logger.warn("graceful_drain_timeout", {
      timeout_ms: timeoutMs,
      remaining_clients: this.clients.size,
    });
  }
}
