import env from '../config/env.js';
import {
  buildShopifyAdminUrl,
  normalizeShopifyAdminApiVersion,
} from '../config/shopifyAdmin.js';
import ShopifyAdminAuthClient from './ShopifyAdminAuthClient.js';

const GRAPHQL_REQUEST_TIMEOUT_MS = 20_000;

function safeMessage(value, fallback) {
  const message = typeof value === 'string' ? value.trim() : '';

  return (message || fallback).slice(0, 500);
}

function safeGraphqlErrors(errors) {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => ({
    message: safeMessage(error?.message, 'Shopify GraphQL error'),
    path: Array.isArray(error?.path) ? error.path.map(String) : null,
    code:
      typeof error?.extensions?.code === 'string'
        ? error.extensions.code
        : null,
  }));
}

function collectUserErrors(value, result, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUserErrors(item, result, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'userErrors' && Array.isArray(child)) {
      for (const error of child) {
        result.push({
          message: safeMessage(error?.message, 'Shopify mutation user error'),
          field: Array.isArray(error?.field) ? error.field.map(String) : null,
          code: typeof error?.code === 'string' ? error.code : null,
        });
      }
      continue;
    }

    collectUserErrors(child, result, seen);
  }
}

function safeCostSummary(extensions) {
  const cost = extensions?.cost;

  if (!cost || typeof cost !== 'object') {
    return null;
  }

  const throttleStatus = cost.throttleStatus ?? {};
  const numericOrNull = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    return Number.isFinite(Number(value)) ? Number(value) : null;
  };

  return {
    requestedQueryCost: numericOrNull(cost.requestedQueryCost),
    actualQueryCost: numericOrNull(cost.actualQueryCost),
    throttleStatus: {
      maximumAvailable: numericOrNull(throttleStatus.maximumAvailable),
      currentlyAvailable: numericOrNull(throttleStatus.currentlyAvailable),
      restoreRate: numericOrNull(throttleStatus.restoreRate),
    },
  };
}

export class ShopifyGraphQLClient {
  constructor({
    config = env,
    authClient = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch implementation is unavailable');
    }

    this.config = config;
    this.fetchImpl = fetchImpl;
    this.authClient =
      authClient ?? new ShopifyAdminAuthClient({ config, fetchImpl });
  }

  async request({ query, variables = {}, operationName = null } = {}) {
    const apiVersion = normalizeShopifyAdminApiVersion(
      this.config.SHOPIFY_ADMIN_API_VERSION
    );

    if (!apiVersion || typeof query !== 'string' || !query.trim()) {
      return {
        ok: false,
        errorType: 'configuration',
        httpStatus: null,
        data: null,
        errors: [{ message: 'Invalid Shopify GraphQL request configuration' }],
        userErrors: [],
        cost: null,
      };
    }

    let url;

    try {
      url = buildShopifyAdminUrl({
        shopDomain: this.config.SHOPIFY_SHOP_DOMAIN,
        path: `/admin/api/${apiVersion}/graphql.json`,
      });
    } catch {
      return {
        ok: false,
        errorType: 'configuration',
        httpStatus: null,
        data: null,
        errors: [{ message: 'Invalid Shopify GraphQL endpoint configuration' }],
        userErrors: [],
        cost: null,
      };
    }

    const execute = async ({ forceTokenRefresh = false } = {}) => {
      let accessToken;

      try {
        accessToken = await this.authClient.getAccessToken({
          forceRefresh: forceTokenRefresh,
        });
      } catch (error) {
        return {
          ok: false,
          errorType: 'authentication',
          httpStatus: error?.httpStatus ?? null,
          data: null,
          errors: [
            {
              message: safeMessage(
                error?.message,
                'Shopify Admin authentication failed'
              ),
              code: error?.code ?? null,
            },
          ],
          userErrors: [],
          cost: null,
        };
      }

      let response;

      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-access-token': accessToken,
          },
          body: JSON.stringify({ query, variables, operationName }),
          signal: AbortSignal.timeout(GRAPHQL_REQUEST_TIMEOUT_MS),
        });
      } catch {
        return {
          ok: false,
          errorType: 'network',
          httpStatus: null,
          data: null,
          errors: [{ message: 'Shopify GraphQL network request failed' }],
          userErrors: [],
          cost: null,
        };
      }

      if (response.status === 401 && !forceTokenRefresh) {
        this.authClient.invalidateToken();
        return execute({ forceTokenRefresh: true });
      }

      let responseJson = null;

      try {
        responseJson = await response.json();
      } catch {
        return {
          ok: false,
          errorType: response.ok ? 'response' : 'http',
          httpStatus: response.status,
          data: null,
          errors: [{ message: 'Shopify GraphQL response was not valid JSON' }],
          userErrors: [],
          cost: null,
        };
      }

      const errors = safeGraphqlErrors(responseJson?.errors);
      const userErrors = [];
      collectUserErrors(responseJson?.data, userErrors);
      const cost = safeCostSummary(responseJson?.extensions);
      const ok = response.ok && errors.length === 0 && userErrors.length === 0;

      return {
        ok,
        errorType: !response.ok
          ? 'http'
          : errors.length
            ? 'graphql'
            : userErrors.length
              ? 'user_errors'
              : null,
        httpStatus: response.status,
        data: responseJson?.data ?? null,
        errors,
        userErrors,
        cost,
      };
    };

    return execute();
  }
}

export default ShopifyGraphQLClient;
