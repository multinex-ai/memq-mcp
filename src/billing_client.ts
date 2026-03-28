import type { AppConfig } from './config.ts'
import type { Logger } from './utils.ts'
import type { GatewayAuthContext } from './types.ts'

type CachedEntry = {
  value: GatewayAuthContext | null
  expiresAt: number
}

export class BillingManagerClient {
  private readonly cache = new Map<string, CachedEntry>()

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {}

  private get serviceHeaders(): HeadersInit {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.BILLING_MANAGER_SERVICE_TOKEN}`,
    }
  }

  async validateToken(token: string): Promise<GatewayAuthContext | null> {
    if (!this.config.BILLING_MANAGER_URL || !this.config.BILLING_MANAGER_SERVICE_TOKEN) {
      return null
    }

    const cached = this.cache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    try {
      const response = await fetch(`${this.config.BILLING_MANAGER_URL}/api/mnemosyne/validate-key`, {
        method: 'POST',
        headers: this.serviceHeaders,
        body: JSON.stringify({ apiKey: token }),
      })

      if (!response.ok) {
        this.logger.warn('billing_validate_failed', { status: response.status })
        this.cache.set(token, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
        return null
      }

      const payload = await response.json() as Record<string, unknown>
      if (!payload.valid) {
        this.cache.set(token, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
        return null
      }

      const context: GatewayAuthContext = {
        apiKeyId: typeof payload.apiKeyId === 'string' ? payload.apiKeyId : null,
        organizationId: typeof payload.organizationId === 'string' ? payload.organizationId : null,
        product: typeof payload.product === 'string' ? payload.product : 'mnemosyne',
        accessLevel: typeof payload.accessLevel === 'string' ? payload.accessLevel : 'pro',
        planCode: typeof payload.planCode === 'string' ? payload.planCode : null,
        deploymentMode: typeof payload.deploymentMode === 'string' ? payload.deploymentMode : null,
        billingSource: typeof payload.billingSource === 'string' ? payload.billingSource : null,
        features: Array.isArray(payload.features)
          ? payload.features.filter((item): item is string => typeof item === 'string')
          : [],
        rateLimit: typeof payload.rateLimit === 'number' ? payload.rateLimit : 1000,
        isInternal: payload.isInternal === true,
        source: 'billing_manager',
      }

      this.cache.set(token, { value: context, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
      return context
    } catch (error) {
      this.logger.error('billing_validate_exception', { error: String(error) })
      this.cache.set(token, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
      return null
    }
  }

  async validateOauthToken(token: string): Promise<GatewayAuthContext | null> {
    if (!this.config.BILLING_MANAGER_URL || !this.config.BILLING_MANAGER_SERVICE_TOKEN) {
      return null
    }

    const cacheKey = `oauth:${token}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    try {
      const response = await fetch(`${this.config.BILLING_MANAGER_URL}/api/mnemosyne/validate-access-token`, {
        method: 'POST',
        headers: this.serviceHeaders,
        body: JSON.stringify({ accessToken: token }),
      })

      if (!response.ok) {
        this.logger.warn('billing_validate_oauth_failed', { status: response.status })
        this.cache.set(cacheKey, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
        return null
      }

      const payload = await response.json() as Record<string, unknown>
      if (!payload.valid) {
        this.cache.set(cacheKey, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
        return null
      }

      const context: GatewayAuthContext = {
        apiKeyId: null,
        organizationId: typeof payload.organizationId === 'string' ? payload.organizationId : null,
        product: typeof payload.product === 'string' ? payload.product : 'mnemosyne',
        accessLevel: typeof payload.accessLevel === 'string' ? payload.accessLevel : 'internal_free',
        planCode: typeof payload.planCode === 'string' ? payload.planCode : null,
        deploymentMode: typeof payload.deploymentMode === 'string' ? payload.deploymentMode : null,
        billingSource: typeof payload.billingSource === 'string' ? payload.billingSource : null,
        features: Array.isArray(payload.features)
          ? payload.features.filter((item): item is string => typeof item === 'string')
          : [],
        rateLimit: typeof payload.rateLimit === 'number' ? payload.rateLimit : 1000,
        isInternal: payload.isInternal === true,
        source: 'oauth_billing_manager',
      }

      this.cache.set(cacheKey, { value: context, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
      return context
    } catch (error) {
      this.logger.error('billing_validate_oauth_exception', { error: String(error) })
      this.cache.set(cacheKey, { value: null, expiresAt: Date.now() + this.config.AUTH_CACHE_TTL_MS })
      return null
    }
  }

  async reportUsage(
    auth: GatewayAuthContext,
    tool: string,
    statusCode: number,
    latencyMs: number,
    requestMetadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.USAGE_REPORTING_ENABLED) return
    if (!this.config.BILLING_MANAGER_URL || !this.config.BILLING_MANAGER_SERVICE_TOKEN) return
    if (!auth.organizationId) return

    try {
      await fetch(`${this.config.BILLING_MANAGER_URL}/api/mnemosyne/usage`, {
        method: 'POST',
        headers: this.serviceHeaders,
        body: JSON.stringify({
          organizationId: auth.organizationId,
          apiKeyId: auth.apiKeyId,
          tool,
          statusCode,
          latencyMs,
          requestMetadata,
        }),
      })
    } catch (error) {
      this.logger.warn('billing_usage_emit_failed', { tool, error: String(error) })
    }
  }
}
