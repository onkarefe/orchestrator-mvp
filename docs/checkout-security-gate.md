# Checkout security gate (v1)

Implementation scope: orchestrator only. Default is off. No Shopify/Admin calls, live order, production deployment/restart, secret provisioning, or migration execution were performed.

## Audited pipeline and gate location

ShopifyWebhookController validates the webhook HMAC, topic, shop and paid-event eligibility; persists the raw webhook; obtains a bounded durable processing claim. WebhookService calls OrderService, then marks the delivery processed (or duplicate). Infrastructure failures retain the existing bounded retry behavior.

OrderService uses the unique Shopify order ID to deduplicate, inserts the order inside a transaction, classifies lines through LineItemRoutingService / ConfiguratorPropertyResolver, persists normalized order_line_items and creates wallpaper jobs through JobService. Unknown or invalid lines trigger the existing manual-review behavior. Accessories have no render job.

JobProcessingService claims jobs. Processor resolves the master, renders PDFs and creates validated job artifacts. OrderFactoryPackageService locks the order, checks all lines/artifacts, assembles one order-level XML/package and persists its upload task. FactoryUploadService checks dispatch eligibility, uploads PDFs before XML, and preserves final-file no-overwrite rules. XML delivery is the factory/NEXO creation boundary in this repository; there is no separate NEXO create-order API call here. NexoCallbackService processes progress/shipped callbacks and creates the order-level Shopify update task. ShopifyUpdateExecutorService performs fulfillment only for a consistent shipped order/package.

The checkout gate runs in OrderService immediately after the new order insert, before normalized line persistence and before the first createConfiguratorJob call. A failed enforced order commits its decision and SECURITY_HOLD and returns normally with zero jobs. Webhook processing can acknowledge it successfully.

One paid Shopify order -> one NEXO order -> one XML, WANDINI-S{shopifyOrderId}, real source SKU, Nahtlos 20-331.1-3 one-piece behavior, PDFs before XML, no overwrite, and ordinary shipped callback behavior remain unchanged.

## Modes and configuration

| Setting | Behavior |
| --- | --- |
| CHECKOUT_SECURITY_GATE_MODE=off | Default. No checkout proof evaluation or decision persistence; existing intake behavior. |
| CHECKOUT_SECURITY_GATE_MODE=report | Evaluate and durably record PASS / FAIL / NOT_APPLICABLE. Do not change production eligibility because of this result. Existing preflight checks still apply. |
| CHECKOUT_SECURITY_GATE_MODE=enforce | FAIL commits SECURITY_HOLD. PASS and NOT_APPLICABLE continue through existing preflight. |
| WANDINI_CHECKOUT_HMAC_SECRET | Server-only UTF-8 signing key shared with the future Hydrogen server signer. No default key. Never included in decisions, logs, errors or admin output. |

Invalid explicit modes fail startup instead of silently disabling protection. Enforce without a configured secret fails startup; direct validation without a key returns CHECKOUT_SECRET_UNAVAILABLE. Report can run without a key to inventory missing proofs. Actual environment files were not modified.

Existing SECURITY_HOLD orders remain held after changing mode to report/off. No release or override endpoint is added.

## Classification

The gate calls the existing classifyShopifyLineItem with the configured WALLPAPER_SKUS and file-existence checking disabled (signature validation must not depend on local master availability). It also uses the existing hasMarker result to include configured UNKNOWN lines, which existing routing already blocks. It introduces no SKU inference or parallel product taxonomy. The normal pipeline retains master-file and configurator preflight validation.

Private _configurator_payload / _configurator_instance_id take precedence over legacy configurator_payload / configurator_instance_id exactly as in ConfiguratorPropertyResolver. Duplicate occurrences of a relevant property name fail. Ordinary/accessory-only orders return NOT_APPLICABLE without needing proof. Mixed orders sign every configured line.

## Transport: confirmed schema and remaining integration evidence

The current repository accepts unmodified Shopify REST-shaped orders/paid JSON. It already reads line_items[].properties as name/value pairs. It has no Draft Order creation code, no existing checkout proof producer, and no captured completed Draft Order proof fixture.

The reviewed official schemas expose:
- [DraftOrderInput.customAttributes](https://shopify.dev/docs/api/admin-graphql/2026-04/input-objects/DraftOrderInput): key/value inputs.
- [Order.customAttributes](https://shopify.dev/docs/api/admin-graphql/2026-01/objects/Order#field-Order.fields.customAttributes): order custom attributes.
- [REST DraftOrder](https://shopify.dev/docs/api/admin-rest/2026-01/resources/draftorder) and [REST Order](https://shopify.dev/docs/api/admin-rest/2026-01/resources/order): note_attributes as name/value pairs; Order line properties and decimal money sets.

V1 therefore reads three **order-level note_attributes**:
- wandini_checkout_proof_version: string "1"
- wandini_checkout_proof: the canonical JSON proof string
- wandini_checkout_signature: lowercase, 64-character HMAC-SHA256 hexadecimal string

Hydrogen must write these through DraftOrderInput.customAttributes (key/value) and retain the configurator properties on the corresponding Draft lines. They are new Wandini application keys, not claimed to be pre-existing Shopify fields. No fallback to arbitrary top-level fields, tags, source_name, metafields or line-level proof fields is accepted.

**Actual Draft -> completed Order -> orders/paid preservation has not been observed in this task.** Schema existence is not a shop-specific end-to-end delivery guarantee. The real report-mode test order must confirm all three note_attributes, exact line properties, variant IDs and price_set values survive completion and webhook field filtering. Do not enable enforce before this evidence exists. Only public documentation was consulted; no shop was connected.

## Exact signed payload

Example shape (payload_sha256 below is a placeholder, not a test vector):

~~~json
{
  "version": "1",
  "lines": [{
    "configurator_instance_id": "unique-server-checkout-line-instance",
    "variant_id": "123456789",
    "sku": "20-331.1-3",
    "quantity": 1,
    "master_asset_id": "server-resolved-master",
    "output": { "width": 3000, "height": 2400, "unit": "mm" },
    "payload_sha256": "<64 lowercase hex characters>",
    "price": "123.4",
    "currency": "EUR"
  }]
}
~~~

The signature covers the entire canonical proof, including version and all configured lines. Extra/missing signed fields cannot match the expected proof.

Canonicalization is defined by canonicalJson / canonicalCheckoutProof in src/services/CheckoutSecurityService.js:
1. Sort object keys recursively by JavaScript UTF-16 code-unit order, not locale.
2. JSON.stringify strings, finite numbers, booleans and null, with no whitespace. No Unicode normalization. Reject non-JSON values and nesting deeper than 32.
3. Preserve all nested array order. Sort only the top-level lines array by configurator_instance_id with the same code-unit comparison.
4. SHA-256 the UTF-8 canonical parsed configurator payload, including crop_ratio and every other field. JSON whitespace/property order does not matter; semantic payload changes do.
5. HMAC-SHA256(secret UTF-8 bytes, canonical proof UTF-8 bytes), encode lowercase hex. Verification checks encoding/length, then crypto.timingSafeEqual on the 32-byte digests.

The implementation accepts at most 100 configured proof lines and 65,536 UTF-8 bytes in the raw proof. Shopify's actual accepted attribute capacity must also be checked during integration.

Instance IDs are 1-191 ASCII characters: first alphanumeric, followed by alphanumerics or underscore/dot/colon/hyphen. Duplicate instances fail. Completed Order line IDs must be present, numeric and unique; unsafe JavaScript numeric IDs fail (decimal strings are accepted). The proof uses numeric variant IDs as strings, not GIDs. The Hydrogen signer must convert its trusted ProductVariant GID to that decimal identity.

Completed Order line IDs are unavailable when the Draft is signed, so **do not sign Draft line IDs as though they were completed Order IDs**. Binding is through the unique configurator instance plus variant, SKU, quantity and full configuration hash. Swapping actual line order is permitted; swapping variant/configuration ownership between instances fails.

### Money and server trust

The price is the server-calculated configured unit price in checkout/presentment currency, compared with webhook line.price_set.presentment_money.amount. Currency is order.presentment_currency (falling back to order.currency when absent), and must match the corresponding money-set currency. The existing wallpaper quantity contract is exactly 1, so this is also the configured line price.

Money remains a decimal string: "123.40" -> "123.4", "0.00" -> "0"; trailing fractional zeros are removed. No parseFloat, Number conversion, exponent, negative value or leading-zero integer is accepted. The verifier checks line.price agrees with price_set.shop_money and, for equal shop/presentment currencies, both money amounts agree.

V1 does not authorize configured-line discounts: nonzero total_discount or discount_allocations causes CHECKOUT_PRICE_MISMATCH. Accessories are outside the signed configured-line price contract. If Hydrogen currently supports configured discounts, settle a signed discounted-price contract before enforcement; do not quietly relax this check.

The orchestrator has no authoritative Dynamic Pricing calculator. The server HMAC attests the expected master and price; it is then compared to the actual order. The next Hydrogen patch must resolve master/variant/SKU, validate dimensions/crop, calculate and quantize price server-side, and sign the exact final configuration used to construct the Draft. Do not sign client-supplied price/master values without server verification. buildCheckoutProof is a verifier/test helper for completed webhook-shaped data, not a client-data signing endpoint.

## Decisions, persistence and migration

011_checkout_security_gate.sql adds, idempotently:
- orders.checkout_security_json JSON NULL: result, mode, reason, detection timestamp, Shopify ID, external number, safe instance IDs and sanitized existing source_name.
- orders.checkout_proof_digest CHAR(64) ASCII binary NULL.
- A unique index on checkout_proof_digest. Only enforce PASS reserves the canonical proof hash; reuse for a different order becomes CHECKOUT_PROOF_REPLAYED and SECURITY_HOLD. Report never reserves or blocks on this hash.

Existing rows retain NULL values; no backfill, order rewrite or status-column type migration. The existing status VARCHAR(50) accommodates SECURITY_HOLD. Migration and fresh-install schema are consistent. Migration was prepared, not executed against MySQL. Apply it before using report/enforce. Off-mode intake does not access the new columns.

A valid proof is a single-use authorization in enforce mode, not evidence that a particular Draft database ID was used. The signer must create a fresh instance ID for each newly authorized checkout; preserving instance IDs is appropriate for a retry of the same checkout. Report mode does not provide cross-order replay protection.

Reason codes include CHECKOUT_PROOF_MISSING, CHECKOUT_SIGNATURE_MISSING, CHECKOUT_PROOF_VERSION_UNSUPPORTED, CHECKOUT_PROOF_MALFORMED, CHECKOUT_SIGNATURE_INVALID, CHECKOUT_LINE_MISMATCH, CHECKOUT_PRICE_MISMATCH, CHECKOUT_CURRENCY_MISMATCH, CHECKOUT_DUPLICATE_INSTANCE, CHECKOUT_SECRET_UNAVAILABLE and CHECKOUT_PROOF_REPLAYED. Source name is diagnostic only and never grants PASS.

The admin order detail displays the durable result/reason/time/mode. A held order has a critical monitoring anomaly and visible SECURITY_HOLD status. Existing logs receive one checkout.security_hold event on first creation. No external notification service is introduced. Logging failure cannot roll back a committed hold, release it, or turn the decision into an endless retry. A crash before advisory logging can omit that log; the durable admin-visible order decision remains authoritative.

## Retry, recovery and side-effect boundaries

- Unique Shopify order IDs and the original transaction protect repeated/concurrent deliveries. Existing orders return duplicate before creating any jobs or another checkout event.
- Security rejection is a successful business disposition. WebhookService marks it processed; later deliveries can be duplicate. DB infrastructure errors still roll back and use bounded durable retries.
- SECURITY_HOLD is terminal in the transition model. All ordinary OrderModel status/factory/manual-review updates have a SQL hold exclusion, so aggregate job refresh cannot release it.
- Pending job claims and stale-job recovery exclude held orders. The claimed-job processor also checks before disk/render work.
- Both package-recovery candidate queries exclude holds. OrderFactoryPackageService rechecks the locked order before even reusing an existing package, generating XML or ensuring a factory task.
- FactoryDispatchGateService rejects holds. Both task creation and FactoryUploadService use this gate before FTP file handling.
- NEXO callbacks reject a held order before package mutation/task creation, including repeated same-status shipped callbacks.
- The generic factory callback's existing ready-status allowlist excludes holds. Shopify fulfillment's existing shipped-order/package validation excludes holds before a Shopify request.
- Mode changes do not release existing holds. There is no automatic approval or retry-to-production transition.

**Rollout boundary:** intake decisions apply to newly created orchestrator orders. Existing off/report orders are not retroactively revalidated by duplicate delivery or reclassified as held. Before switching to enforce, reconcile/drain existing pending off/report work explicitly; this patch does not silently block that historical production backlog. Recovery protection applies permanently to SECURITY_HOLD records. This distinction preserves the requested default-off rollout.

## Tests and limits

npm test now runs the repository's complete set of 14 smoke suites instead of its previous intentionally failing placeholder. npm run test:checkout-security runs the new suite alone. The new suite covers 45 scenarios: ordinary/mixed, valid/missing/invalid proof/signature, mutation of price/dimensions/master/variant/payload/crop/currency/quantity/instance/SKU, deterministic line ordering, discounts, duplicate attributes/instances, replay, all modes, atomic intake/rollback, alert failure, durable HTTP acknowledgement, terminal updates, job-claim/stale recovery exclusions, startup/periodic package recovery and admin visibility.

Existing callback tests additionally cover held accepted/shipped replay without creating Shopify tasks; existing fulfillment tests assert a held order never calls Shopify. Existing XML, Nahtlos/package, no-overwrite, webhook retry and normal shipped behavior suites remain green.

Validation result: 14 suites passed, 0 failed. No typecheck, lint or build scripts exist in package.json. Integration tests use isolated DB/FTP/Shopify test doubles. Real MySQL DDL/locking and the real Shopify Draft completion/webhook round trip still require staging verification during rollout; they were not exercised here.

## Rollout plan (no production commands)

1. Keep off; review code and additive migration. Do not enable enforcement while Hydrogen has no signer.
2. Implement the Hydrogen server signer exactly as above, with a separately provisioned server-only shared key. Preserve approved variant/master/configuration and decimal pricing.
3. Apply/verify the additive migration in the rollout environment, then use report consistently across intake/recovery processes.
4. Complete a real configured test order, and a mixed/multi-configured order if supported. Inspect actual completed-order/webhook attributes and money sets; require PASS and normal single-package factory behavior. Check tampering produces FAIL in report while existing pipeline eligibility remains unchanged.
5. Resolve any transport, pricing, discount or multi-currency discrepancies; reconcile/drain historical off/report work.
6. Switch to enforce only after that evidence. Monitor admin decisions and ordinary NOT_APPLICABLE orders. A later rollback to report/off affects future intake only; existing security holds stay blocked.


## Changed files

| Area | Files |
| --- | --- |
| Proof and durable decision | src/services/CheckoutSecurityService.js; src/models/CheckoutSecurityModel.js |
| Intake and terminal status | src/services/OrderService.js; src/constants/statuses.js; src/services/statusTransition.js; src/models/OrderModel.js |
| Render/recovery/dispatch | src/models/JobModel.js; src/models/PipelineRecoveryModel.js; src/services/JobProcessingService.js; src/services/OrderFactoryPackageService.js; src/services/FactoryDispatchGateService.js; src/services/NexoCallbackService.js |
| Configuration/startup | .env.example; src/config/env.js; src/config/startupValidation.js; src/worker.js |
| Schema | src/db/schema.sql; src/db/migrations/011_checkout_security_gate.sql |
| Operator visibility | src/services/OrderMonitoringService.js; src/views/pages/order-detail.ejs |
| Tests | package.json; scripts/run-smoke-tests.mjs; scripts/checkout-security-smoke-test.mjs; scripts/nexo-order-callback-smoke-test.mjs; scripts/shopify-order-execution-smoke-test.mjs |
| Audit/contract/rollout | docs/checkout-security-gate.md |

Additional local checks passed: syntax checking of all 20 changed/new JavaScript modules; order-detail EJS compilation; git diff whitespace/error check.

