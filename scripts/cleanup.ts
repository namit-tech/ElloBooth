/**
 * Retention sweep. Deletes photos whose tenant-configured retention window has
 * passed - the stored file first, then the database row.
 *
 * Schedule this daily. Nothing else deletes visitor photos, so if it never
 * runs, the retention promise shown on the booth is not being kept.
 *
 *   npm run cleanup           delete what is due
 *   npm run cleanup -- --dry  report only
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/lib/db';
import { Generation, Tenant, type IGeneration, type ITenant } from '../src/models';
import { remove } from '../src/lib/storage';

const dryRun = process.argv.includes('--dry');

async function main() {
  await connectDB();

  const due = await Generation.find({
    expiresAt: { $exists: true, $ne: null, $lt: new Date() },
  }).lean<IGeneration[]>();

  if (due.length === 0) {
    console.log('Nothing due for deletion.');
    await mongoose.disconnect();
    return;
  }

  const tenants = await Tenant.find({}, { name: 1 }).lean<ITenant[]>();
  const names = new Map(tenants.map((t) => [String(t._id), t.name]));

  const byTenant = new Map<string, number>();
  for (const g of due) {
    const key = String(g.tenantId);
    byTenant.set(key, (byTenant.get(key) ?? 0) + 1);
  }

  console.log(`${due.length} photo(s) past their retention window:`);
  for (const [id, n] of byTenant) console.log(`  ${names.get(id) ?? id}: ${n}`);

  if (dryRun) {
    console.log('\nDry run - nothing deleted.');
    await mongoose.disconnect();
    return;
  }

  let files = 0;
  const failures: string[] = [];
  const cleared: typeof due[number]['_id'][] = [];

  for (const g of due) {
    // Identity lock stores pass 1's output too; both must go.
    const keys = [g.imageKey, g.imageKeyRaw].filter((k): k is string => !!k);
    if (keys.length === 0) {
      cleared.push(g._id); // nothing on disk to remove
      continue;
    }

    let allGone = true;
    for (const key of keys) {
      try {
        await remove(key);
        files++;
      } catch (err) {
        // Keep the row so the next run retries this file rather than orphaning it.
        allGone = false;
        failures.push(key);
        console.error(`  could not delete ${key}:`, err instanceof Error ? err.message : err);
      }
    }
    if (allGone) cleared.push(g._id);
  }

  const { deletedCount } = await Generation.deleteMany({ _id: { $in: cleared } });

  console.log(`\nDeleted ${files} file(s) and ${deletedCount} record(s).`);
  if (failures.length) console.log(`${failures.length} file(s) could not be removed; they stay queued for the next run.`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Cleanup failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
