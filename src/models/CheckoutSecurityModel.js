import { isDuplicateKeyError } from '../db/errors.js';
import { findOrderById } from './OrderModel.js';

// Called for a newly inserted order inside its transaction. A unique digest
// prevents a valid enforced proof from being reused for a second order.
export async function recordCheckoutSecurity(orderId, decision, db) {
  let saved = { ...decision };
  const digest = saved.mode === 'enforce' && saved.result === 'PASS' ? saved.proofDigest : null;
  delete saved.proofDigest;
  try {
    await db.execute('UPDATE orders SET checkout_proof_digest = ? WHERE id = ?', [digest, orderId]);
  } catch (error) {
    if (!digest || !isDuplicateKeyError(error)) throw error;
    saved = { ...saved, result: 'FAIL', reason: 'CHECKOUT_PROOF_REPLAYED' };
  }
  const held = saved.mode === 'enforce' && saved.result === 'FAIL';
  await db.execute(
    `UPDATE orders SET checkout_security_json = ?,
      status = CASE WHEN ? THEN 'SECURITY_HOLD' ELSE status END,
      manual_review_reason = CASE WHEN ? THEN ? ELSE manual_review_reason END
    WHERE id = ?`,
    [JSON.stringify(saved), held, held, saved.reason, orderId]
  );
  return { order: await findOrderById(orderId, db), decision: saved, held };
}
