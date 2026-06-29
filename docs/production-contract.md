# Wandini Orchestrator Production Contract

This document locks the Phase 1 production decisions for the Wandini Orchestrator MVP. It defines the safety boundaries the codebase must follow before production workflows are expanded.

## 1. System Role

This system is the Wandini Production Orchestrator.

It is the middleware between Shopify, the configurator, production master images, the factory FTP/NEXO workflow, and Shopify Admin API status updates.

It must not be treated as a simple demo script.

## 2. Main Flow

The main production flow is:

1. Shopify paid order webhook -> Orchestrator.
2. Orchestrator stores raw payload.
3. Orchestrator creates internal order/job.
4. Worker processes high-resolution master image.
5. Worker applies relative `crop_ratio` to the real production master.
6. Worker creates panel PDFs, XML, ZIP, and later manifest/checksum.
7. Phase 1 stops at safe local artifact generation and admin download.

There is no automatic factory FTP upload in Phase 1.

## 3. Reverse Flow

The reverse production flow is:

1. Factory/NEXO -> Orchestrator.
2. Orchestrator -> Shopify.

Phase 1 may include a simulation endpoint/task skeleton only. The real NEXO format is unknown until Phase 2.

NEXO should not connect directly to Shopify. The Orchestrator owns Shopify Admin API updates.

## 4. Phase 1 External Write Policy

Phase 1 does not perform real external production writes:

- No real FTP upload in Phase 1.
- No real NEXO integration in Phase 1.
- No real Shopify write by default in Phase 1.
- Shopify Admin API update layer must default to dry-run unless explicitly enabled.
- Generated ZIP/XML/PDF are manually downloaded and inspected in Phase 1.

## 5. Webhook Safety

The Shopify webhook endpoint must support direct Shopify -> Orchestrator usage.

Hookdeck may be used for debugging but must not be required.

HMAC verification must use the raw request body. JSON parsing must not destroy the raw body needed for HMAC verification.

Invalid HMAC must not create orders/jobs. Duplicate webhook deliveries must not create duplicate production jobs.

## 6. Idempotency Rules

Idempotency is required across incoming and outgoing production events:

- The same Shopify webhook delivery must not create duplicate work.
- The same Shopify order must not create a duplicate local order.
- The same Shopify order + line item must not create a duplicate job.
- The same future factory shipped callback must not create a duplicate Shopify fulfillment/update.

## 7. Processing Rules

Heavy image/PDF processing must never happen inside the webhook request.

Workers process jobs asynchronously.

Each job must work in an isolated folder. Shared temp filenames are forbidden.

`crop_ratio` is relative and must be applied to the high-resolution master image. The storefront preview image is not the production source.

## 8. Panel Math Contract

Panel split must use max-700mm equal split.

Fixed 625mm chunking is not allowed unless the factory explicitly confirms it later.

Examples:

- `5000mm -> 8 panels x 625mm`
- `4725mm -> 7 panels x 675mm`

XML grouping by actual panel dimensions is correct.

XML width/height must represent panel dimensions, not full mural dimensions.

`variants` must equal the number of files in that panel-dimension group.

## 9. XML/PDF Contract

XML file references must exactly match generated PDF filenames.

PDF page dimensions must match the corresponding panel dimensions.

`copies_per_variant` is always `1` unless explicitly changed later.

Shopify `line_item.quantity` must not be used as production copy count.

Missing SKU must not silently produce production XML in the final safety model.

## 10. Manual Review Contract

If the system is unsure, it must stop and enter `manual_review`.

The following conditions must not continue automatically:

- Missing `configurator_payload`
- Missing `master_asset_id`
- Missing master file
- Invalid `crop_ratio`
- Missing SKU
- Missing shipping address
- XML/PDF mismatch
- Unsafe duplicate

Manual review means no factory upload and no Shopify status write.

## 11. Database / Migration Safety

Phase 1 schema changes must be additive.

Forbidden migration actions:

- Table drops
- Column drops
- Destructive renames

New columns should be nullable or have safe defaults.

Unique constraints require duplicate prechecks first.

Codex may write migrations but must not run migrations unless explicitly instructed.

## 12. Worker Safety

The same job must not be processed by two workers simultaneously.

Worker locking must be implemented carefully based on actual MySQL capabilities.

Do not assume `SKIP LOCKED` is available without checking.

Validation errors must not retry forever.

`manual_review` jobs must not auto-retry.

## 13. Storage Rules

Storage boundaries are:

- `storage/masters` is private and never committed.
- `storage/artifacts` is private and downloaded only through controlled admin routes.
- `storage/tmp` is temporary and job-isolated.

Phase 1 may include a basic disk guard only.

Advanced backup/retention belongs to Phase 3.

## 14. Security / Logging

Secrets must not be logged.

Authorization headers, Shopify tokens, webhook secrets, factory API keys, FTP passwords, and DB passwords must be masked in logs/admin views.

Raw payloads are stored for audit, but sensitive headers must be handled carefully.

## 15. Admin Visibility

Phase 1 admin visibility should prioritize operations, not UI polish.

Admin should eventually show:

- Order/job status
- Manual review reason
- Raw webhook
- Logs
- Artifact info
- Manifest/checksum
- Factory callback simulation records
- Shopify update dry-run tasks

## 16. Phase Boundaries

Phase boundaries are:

- Phase 1: production-safe core, local artifact generation, dry-run/simulation only.
- Phase 2: factory/NEXO communication, real callback format, FTP upload testing, full order lifecycle test.
- Phase 3: new production server, final Shopify account, production deployment, backup/monitoring hardening.
