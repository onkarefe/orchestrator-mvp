import env from '../config/env.js';
import { buildShopifyAdminUrl } from '../config/shopifyAdmin.js';

const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const MINIMUM_EXPIRY_MARGIN_MS = 5_000;
const MAXIMUM_EXPIRY_MARGIN_MS = 60_000;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export class ShopifyAdminAuthError extends Error {
  constructor(message, { code, httpStatus = null, retryable = false } = {}) {
    super(message);
    this.name = 'ShopifyAdminAuthError';
    this.code = code ?? 'SHOPIFY_ADMIN_AUTH_ERROR';
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

function tokenLifetimeSeconds(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TOKEN_LIFETIME_SECONDS;
}

export class ShopifyAdminAuthClient {
  constructor({ config = env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new ShopifyAdminAuthError('Fetch implementation is unavailable', {
        code: 'SHOPIFY_ADMIN_FETCH_UNAVAILABLE',
      });
    }

    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cachedToken = null;
    this.expiresAt = 0;
    this.refreshPromise = null;
  }

  invalidateToken() {
    this.cachedToken = null;
    this.expiresAt = 0;
  }

  hasUsableCachedToken() {
    return Boolean(this.cachedToken && this.now() < this.expiresAt);
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.hasUsableCachedToken()) {
      return this.cachedToken;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.requestAccessToken();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async requestAccessToken() {
    const clientId = String(this.config.SHOPIFY_CLIENT_ID ?? '').trim();
    const clientSecret = String(this.config.SHOPIFY_CLIENT_SECRET ?? '');

    if (!clientId || !clientSecret.trim()) {
      throw new ShopifyAdminAuthError(
        'Shopify Admin API credentials are not configured',
        { code: 'SHOPIFY_ADMIN_CREDENTIALS_MISSING' }
      );
    }

    const url = buildShopifyAdminUrl({
      shopDomain: this.config.SHOPIFY_SHOP_DOMAIN,
      path: '/admin/oauth/access_token',
    });
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    let response;

    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyAdminAuthError(
        'Shopify Admin access token request failed',
        {
          code: 'SHOPIFY_ADMIN_TOKEN_REQUEST_FAILED',
          retryable: true,
        }
      );
    }

    if (!response.ok) {
      throw new ShopifyAdminAuthError(
        'Shopify Admin access token request returned an HTTP error',
        {
          code: 'SHOPIFY_ADMIN_TOKEN_HTTP_ERROR',
          httpStatus: response.status,
          retryable: response.status === 429 || response.status >= 500,
        }
      );
    }

    let responseJson;

    try {
      responseJson = await response.json();
    } catch {
      throw new ShopifyAdminAuthError(
        'Shopify Admin access token response was not valid JSON',
        { code: 'SHOPIFY_ADMIN_TOKEN_RESPONSE_INVALID' }
      );
    }

    const accessToken =
      typeof responseJson?.access_token === 'string'
        ? responseJson.access_token
        : '';

    if (!accessToken) {
      throw new ShopifyAdminAuthError(
        'Shopify Admin access token response did not contain a token',
        { code: 'SHOPIFY_ADMIN_TOKEN_MISSING' }
      );
    }

    const lifetimeMs = tokenLifetimeSeconds(responseJson.expires_in) * 1000;
    const expiryMarginMs = Math.min(
      MAXIMUM_EXPIRY_MARGIN_MS,
      Math.max(MINIMUM_EXPIRY_MARGIN_MS, Math.floor(lifetimeMs * 0.1))
    );

    this.cachedToken = accessToken;
    this.expiresAt = this.now() + Math.max(0, lifetimeMs - expiryMarginMs);

    return this.cachedToken;
  }
}

export default ShopifyAdminAuthClient;
