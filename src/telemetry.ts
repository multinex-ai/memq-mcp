import { type Attributes, metrics, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { AppConfig } from "./config.ts";
import { MNEMOSYNE_GATEWAY_RUNTIME_VERSION } from "./build_info.ts";
import type { Logger } from "./utils.ts";

function normalizeBaseUrl(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function resolveOtlpEndpoint(config: AppConfig, signal: "traces" | "metrics"): string | null {
  const explicit = signal === "traces"
    ? config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    : config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (explicit) return explicit;

  const base = config.CLOUDGAZE_OTLP_BASE_URL || config.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return null;
  return `${normalizeBaseUrl(base)}/v1/${signal}`;
}

function detectCloudProvider(config: AppConfig): { provider?: string; platform?: string; region?: string } {
  if (config.CLOUD_PROVIDER || config.CLOUD_PLATFORM || config.CLOUD_REGION) {
    return {
      provider: config.CLOUD_PROVIDER || undefined,
      platform: config.CLOUD_PLATFORM || undefined,
      region: config.CLOUD_REGION || undefined,
    };
  }

  if (Deno.env.get("K_SERVICE")) {
    return {
      provider: "gcp",
      platform: "gcp_cloud_run",
      region: Deno.env.get("K_REGION") || undefined,
    };
  }

  if (Deno.env.get("AWS_REGION") || Deno.env.get("AWS_EXECUTION_ENV")) {
    return {
      provider: "aws",
      platform: Deno.env.get("ECS_CONTAINER_METADATA_URI_V4") ? "aws_ecs" : "aws_compute",
      region: Deno.env.get("AWS_REGION") || undefined,
    };
  }

  if (Deno.env.get("AZURE_REGION") || Deno.env.get("WEBSITE_SITE_NAME")) {
    return {
      provider: "azure",
      platform: Deno.env.get("WEBSITE_SITE_NAME") ? "azure_app_service" : "azure_compute",
      region: Deno.env.get("AZURE_REGION") || Deno.env.get("REGION_NAME") || undefined,
    };
  }

  return {};
}

function buildResourceAttributes(config: AppConfig): Attributes {
  const cloud = detectCloudProvider(config);
  const attributes: Attributes = {
    "service.namespace": config.OTEL_SERVICE_NAMESPACE,
    "service.name": config.OTEL_SERVICE_NAME,
    "service.version": MNEMOSYNE_GATEWAY_RUNTIME_VERSION,
    "service.instance.id": config.OTEL_SERVICE_INSTANCE_ID,
    "deployment.environment.name": config.OTEL_DEPLOYMENT_ENVIRONMENT,
    "multinex.product": "mnemosyne",
    "multinex.channel": config.MULTINEX_CHANNEL,
    "multinex.release_channel": config.RELEASE_CHANNEL,
  };

  if (cloud.provider) attributes["cloud.provider"] = cloud.provider;
  if (cloud.platform) attributes["cloud.platform"] = cloud.platform;
  if (cloud.region) attributes["cloud.region"] = cloud.region;
  if (config.K8S_CLUSTER_NAME) attributes["k8s.cluster.name"] = config.K8S_CLUSTER_NAME;
  if (config.MULTINEX_MARKETPLACE_PROVIDER) {
    attributes["multinex.marketplace.provider"] = config.MULTINEX_MARKETPLACE_PROVIDER;
  }
  if (config.MULTINEX_MARKETPLACE_OFFER) attributes["multinex.marketplace.offer"] = config.MULTINEX_MARKETPLACE_OFFER;
  if (config.MULTINEX_MARKETPLACE_PLAN) attributes["multinex.marketplace.plan"] = config.MULTINEX_MARKETPLACE_PLAN;

  return attributes;
}

function sanitizeAttributes(attributes?: Record<string, unknown>): Attributes {
  if (!attributes) return {};

  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const scalarArray = value
        .filter((item): item is string | number | boolean =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        )
        .map((item) => String(item));
      if (scalarArray.length > 0) out[key] = scalarArray;
      continue;
    }

    out[key] = JSON.stringify(value);
  }
  return out;
}

export class GatewayTelemetry {
  private readonly enabled: boolean;
  private readonly tracerProvider: BasicTracerProvider | null;
  private readonly meterProvider: MeterProvider | null;
  private readonly tracer = trace.getTracer("mnemosyne-gateway", MNEMOSYNE_GATEWAY_RUNTIME_VERSION);
  private readonly meter = metrics.getMeter("mnemosyne-gateway", MNEMOSYNE_GATEWAY_RUNTIME_VERSION);
  private readonly requestCounter;
  private readonly requestDuration;
  private readonly toolCounter;
  private readonly toolDuration;
  private readonly authCounter;

  constructor(config: AppConfig, logger: Logger) {
    const traceEndpoint = resolveOtlpEndpoint(config, "traces");
    const metricEndpoint = resolveOtlpEndpoint(config, "metrics");
    this.enabled = Boolean(traceEndpoint || metricEndpoint);

    let tracerProvider: BasicTracerProvider | null = null;
    let meterProvider: MeterProvider | null = null;
    const resource = new Resource(buildResourceAttributes(config));

    if (traceEndpoint) {
      tracerProvider = new BasicTracerProvider({ resource });
      tracerProvider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: traceEndpoint })));
      trace.setGlobalTracerProvider(tracerProvider);
    }

    if (metricEndpoint) {
      meterProvider = new MeterProvider({
        resource,
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: metricEndpoint }),
          }),
        ],
      });
      metrics.setGlobalMeterProvider(meterProvider);
    }

    this.tracerProvider = tracerProvider;
    this.meterProvider = meterProvider;
    this.requestCounter = this.meter.createCounter("mnemosyne.http.server.requests");
    this.requestDuration = this.meter.createHistogram("mnemosyne.http.server.duration", { unit: "ms" });
    this.toolCounter = this.meter.createCounter("mnemosyne.mcp.tool.calls");
    this.toolDuration = this.meter.createHistogram("mnemosyne.mcp.tool.duration", { unit: "ms" });
    this.authCounter = this.meter.createCounter("mnemosyne.auth.validations");

    logger.info("gateway_otel_boot", {
      enabled: this.enabled,
      trace_endpoint: traceEndpoint,
      metric_endpoint: metricEndpoint,
    });
  }

  async runSpan<T>(
    name: string,
    attributes: Record<string, unknown> | undefined,
    fn: (span: Span | null) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled || !this.tracerProvider) {
      return await fn(null);
    }

    const span = this.tracer.startSpan(name, { attributes: sanitizeAttributes(attributes) });
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  }

  recordHttpRequest(
    route: string,
    method: string,
    statusCode: number,
    durationMs: number,
    attributes?: Record<string, unknown>,
  ): void {
    const attrs = sanitizeAttributes({
      "http.request.method": method,
      "url.path": route,
      "http.response.status_code": statusCode,
      ...attributes,
    });
    this.requestCounter.add(1, attrs);
    this.requestDuration.record(durationMs, attrs);
  }

  recordToolCall(tool: string, statusCode: number, latencyMs: number, attributes?: Record<string, unknown>): void {
    const attrs = sanitizeAttributes({
      "mnemosyne.tool.name": tool,
      "http.response.status_code": statusCode,
      ...attributes,
    });
    this.toolCounter.add(1, attrs);
    this.toolDuration.record(latencyMs, attrs);
  }

  recordAuthValidation(
    source: string,
    success: boolean,
    durationMs: number,
    attributes?: Record<string, unknown>,
  ): void {
    const attrs = sanitizeAttributes({
      "mnemosyne.auth.source": source,
      "mnemosyne.auth.success": success,
      ...attributes,
    });
    this.authCounter.add(1, attrs);
    this.requestDuration.record(durationMs, {
      ...attrs,
      "mnemosyne.metric.kind": "auth_validation",
    });
  }

  async shutdown(): Promise<void> {
    if (this.meterProvider) await this.meterProvider.shutdown();
    if (this.tracerProvider) await this.tracerProvider.shutdown();
  }
}
