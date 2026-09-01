import type { Types } from 'mongoose';
import { Tenant, type ITenant } from '@/models';
import { HttpError } from '@/lib/rbac';
import { findModel } from '@/lib/ai/catalogue';

/**
 * Credit accounting for tenants on the platform key.
 *
 * The reserve happens as a single conditional update so that concurrent booths
 * cannot both pass a "do they have credit?" check and push the balance
 * negative - which would be Elloindia's bill, not the tenant's.
 */

/**
 * One credit is one AI pass. A photo with identity lock runs two passes and so
 * costs two, which is reserved up front - reserving one and topping up later
 * would let a booth start a photo it cannot finish.
 */
export function creditsNeeded(tenant: ITenant): number {
  return tenant.settings.identityLock ? 2 : 1;
}

export async function reserveCredit(tenant: ITenant, amount = 1): Promise<void> {
  // A tenant on their own key spends their own Google quota; nothing to meter.
  if (tenant.keyMode === 'byok') return;

  const updated = await Tenant.findOneAndUpdate(
    { _id: tenant._id, credits: { $gte: amount } },
    { $inc: { credits: -amount, creditsUsed: amount } },
    { new: true, projection: { credits: 1 } },
  );

  if (!updated) {
    throw new HttpError(
      402,
      amount > 1 ? `Not enough credits (this photo needs ${amount})` : 'No photo credits left',
      'Buy more credits, or switch this account to its own API key in Settings.',
    );
  }
}

/** Give credits back for passes the tenant did not get any output from. */
export async function refundCredit(
  tenantId: Types.ObjectId,
  keyMode: ITenant['keyMode'],
  amount = 1,
): Promise<void> {
  if (keyMode === 'byok' || amount <= 0) return;
  await Tenant.updateOne(
    { _id: tenantId },
    { $inc: { credits: amount, creditsUsed: -amount } },
  ).catch(() => {});
}

/** Rough per-image cost for usage reporting; the catalogue is the one source. */
export function costOf(model: string): number {
  return findModel(model)?.approxUsd ?? 0.05;
}
