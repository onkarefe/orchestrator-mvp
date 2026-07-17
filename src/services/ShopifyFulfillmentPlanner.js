import { normalizeShopifyNumericId } from '../config/shopifyAdmin.js';

function manualReview(error, details = {}) {
  return {
    ok: false,
    disposition: 'manual_review',
    error,
    matchedFulfillmentOrderCount:
      details.matchedFulfillmentOrderCount ?? 0,
    matchedLineItemCount: details.matchedLineItemCount ?? 0,
    trackingNumberCount: details.trackingNumberCount ?? 0,
    fulfillmentInput: null,
  };
}

function getTrackingArray(payload) {
  if (Array.isArray(payload?.trackingNumbers)) {
    return payload.trackingNumbers;
  }

  if (Array.isArray(payload?.tracking_numbers)) {
    return payload.tracking_numbers;
  }

  return null;
}

function normalizeTracking(payload) {
  const source = getTrackingArray(payload);

  if (!source || source.length === 0) {
    return {
      ok: false,
      error: 'shopify_fulfillment_tracking_numbers_required',
      trackingNumbers: [],
    };
  }

  if (source.length > 50) {
    return {
      ok: false,
      error: 'shopify_fulfillment_tracking_numbers_too_many',
      trackingNumbers: [],
    };
  }

  const byNumber = new Map();

  for (const tracking of source) {
    if (!tracking || typeof tracking !== 'object') {
      return {
        ok: false,
        error: 'shopify_fulfillment_tracking_entry_invalid',
        trackingNumbers: [],
      };
    }

    if (
      !['string', 'number'].includes(typeof tracking.number) ||
      (typeof tracking.number === 'number' &&
        !Number.isFinite(tracking.number))
    ) {
      return {
        ok: false,
        error: 'shopify_fulfillment_tracking_number_invalid',
        trackingNumbers: [],
      };
    }

    const number = String(tracking.number ?? '').trim();

    if (!number || number.length > 191) {
      return {
        ok: false,
        error: !number
          ? 'shopify_fulfillment_tracking_number_required'
          : 'shopify_fulfillment_tracking_number_too_long',
        trackingNumbers: [],
      };
    }

    if (
      tracking.url !== undefined &&
      tracking.url !== null &&
      typeof tracking.url !== 'string'
    ) {
      return {
        ok: false,
        error: 'shopify_fulfillment_tracking_url_invalid',
        trackingNumbers: [],
      };
    }

    const url = typeof tracking.url === 'string' ? tracking.url.trim() : null;

    if (url && url.length > 2048) {
      return {
        ok: false,
        error: 'shopify_fulfillment_tracking_url_too_long',
        trackingNumbers: [],
      };
    }
    const existing = byNumber.get(number);

    if (existing && existing.url && url && existing.url !== url) {
      return {
        ok: false,
        error: 'shopify_fulfillment_tracking_url_conflict',
        trackingNumbers: [],
      };
    }

    if (!existing) {
      byNumber.set(number, { number, url: url || null });
    } else if (!existing.url && url) {
      existing.url = url;
    }
  }

  const trackingNumbers = [...byNumber.values()];
  const trackingUrlCount = trackingNumbers.filter(({ url }) => Boolean(url)).length;

  if (trackingUrlCount > 0 && trackingUrlCount !== trackingNumbers.length) {
    return {
      ok: false,
      error: 'shopify_fulfillment_tracking_urls_partially_missing',
      trackingNumbers: [],
    };
  }

  return {
    ok: true,
    error: null,
    trackingNumbers,
  };
}

function matchesShopifyLineItem(lineItem, targetLineItemId) {
  const gid = String(lineItem?.id ?? '');
  const legacyResourceId = String(lineItem?.legacyResourceId ?? '');

  return (
    gid.endsWith(`/${targetLineItemId}`) ||
    legacyResourceId === targetLineItemId
  );
}

export function buildShopifyOrderGid(shopifyOrderId) {
  const normalized = normalizeShopifyNumericId(shopifyOrderId);

  return normalized ? `gid://shopify/Order/${normalized}` : null;
}

export function buildShopifyFulfillmentPlan({
  order,
  shopifyOrderId,
  shopifyLineItemId,
  taskPayload = {},
  notifyCustomer = false,
} = {}) {
  const expectedOrderGid = buildShopifyOrderGid(shopifyOrderId);
  const targetLineItemId = normalizeShopifyNumericId(shopifyLineItemId);
  const tracking = normalizeTracking(taskPayload);
  const rawCompany = taskPayload.parcel_service ?? taskPayload.parcelService;

  if (
    rawCompany !== undefined &&
    rawCompany !== null &&
    typeof rawCompany !== 'string'
  ) {
    return manualReview('shopify_fulfillment_tracking_company_invalid');
  }

  if (typeof rawCompany === 'string' && rawCompany.length > 191) {
    return manualReview('shopify_fulfillment_tracking_company_too_long');
  }

  if (!expectedOrderGid || !targetLineItemId) {
    return manualReview('shopify_fulfillment_identity_invalid');
  }

  if (!tracking.ok) {
    return manualReview(tracking.error);
  }

  if (!order || order.id !== expectedOrderGid) {
    return manualReview('shopify_fulfillment_order_not_found_or_mismatched', {
      trackingNumberCount: tracking.trackingNumbers.length,
    });
  }

  const fulfillmentOrders = order.fulfillmentOrders;

  if (
    !fulfillmentOrders ||
    !Array.isArray(fulfillmentOrders.nodes) ||
    fulfillmentOrders.pageInfo?.hasNextPage === true
  ) {
    return manualReview('shopify_fulfillment_orders_incomplete', {
      trackingNumberCount: tracking.trackingNumbers.length,
    });
  }

  const matchedItems = [];
  const seenFulfillmentOrderLineItemIds = new Set();

  for (const fulfillmentOrder of fulfillmentOrders.nodes) {
    if (
      !fulfillmentOrder?.id ||
      !fulfillmentOrder.lineItems ||
      !Array.isArray(fulfillmentOrder.lineItems.nodes) ||
      fulfillmentOrder.lineItems.pageInfo?.hasNextPage === true
    ) {
      return manualReview('shopify_fulfillment_order_line_items_incomplete', {
        trackingNumberCount: tracking.trackingNumbers.length,
      });
    }

    for (const fulfillmentOrderLineItem of fulfillmentOrder.lineItems.nodes) {
      if (
        !matchesShopifyLineItem(
          fulfillmentOrderLineItem?.lineItem,
          targetLineItemId
        )
      ) {
        continue;
      }

      const fulfillmentOrderLineItemId = fulfillmentOrderLineItem?.id;
      const remainingQuantity = fulfillmentOrderLineItem?.remainingQuantity;

      if (
        typeof fulfillmentOrderLineItemId !== 'string' ||
        !fulfillmentOrderLineItemId.startsWith(
          'gid://shopify/FulfillmentOrderLineItem/'
        ) ||
        !Number.isSafeInteger(remainingQuantity) ||
        remainingQuantity < 0 ||
        seenFulfillmentOrderLineItemIds.has(fulfillmentOrderLineItemId)
      ) {
        return manualReview('shopify_fulfillment_line_item_ambiguous', {
          matchedFulfillmentOrderCount: new Set(
            matchedItems.map((item) => item.fulfillmentOrderId)
          ).size,
          matchedLineItemCount: matchedItems.length,
          trackingNumberCount: tracking.trackingNumbers.length,
        });
      }

      seenFulfillmentOrderLineItemIds.add(fulfillmentOrderLineItemId);
      matchedItems.push({
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItemId,
        remainingQuantity,
      });
    }
  }

  if (matchedItems.length === 0) {
    return manualReview('shopify_fulfillment_line_item_not_found', {
      trackingNumberCount: tracking.trackingNumbers.length,
    });
  }

  const matchedFulfillmentOrderCount = new Set(
    matchedItems.map((item) => item.fulfillmentOrderId)
  ).size;
  const pendingItems = matchedItems.filter(
    (item) => item.remainingQuantity > 0
  );

  if (pendingItems.length === 0) {
    return {
      ok: true,
      disposition: 'skipped',
      reason: 'already_fulfilled',
      matchedFulfillmentOrderCount,
      matchedLineItemCount: matchedItems.length,
      trackingNumberCount: tracking.trackingNumbers.length,
      fulfillmentInput: null,
    };
  }

  const groups = new Map();

  for (const item of pendingItems) {
    const group = groups.get(item.fulfillmentOrderId) ?? {
      fulfillmentOrderId: item.fulfillmentOrderId,
      fulfillmentOrderLineItems: [],
    };

    group.fulfillmentOrderLineItems.push({
      id: item.fulfillmentOrderLineItemId,
      quantity: item.remainingQuantity,
    });
    groups.set(item.fulfillmentOrderId, group);
  }

  const trackingInfo = {
    numbers: tracking.trackingNumbers.map(({ number }) => number),
  };
  const trackingUrls = tracking.trackingNumbers
    .map(({ url }) => url)
    .filter(Boolean);
  const company = String(rawCompany ?? '').trim();

  if (trackingUrls.length > 0) {
    trackingInfo.urls = trackingUrls;
  }

  if (company) {
    trackingInfo.company = company;
  }

  return {
    ok: true,
    disposition: 'ready',
    reason: null,
    matchedFulfillmentOrderCount,
    matchedLineItemCount: matchedItems.length,
    trackingNumberCount: tracking.trackingNumbers.length,
    fulfillmentInput: {
      lineItemsByFulfillmentOrder: [...groups.values()],
      notifyCustomer: Boolean(notifyCustomer),
      trackingInfo,
    },
  };
}

export default {
  buildShopifyFulfillmentPlan,
  buildShopifyOrderGid,
};
