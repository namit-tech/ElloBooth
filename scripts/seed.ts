/**
 * First-run seed: creates the Elloindia superadmin, the global scene library,
 * and a demo tenant to log in as. Safe to re-run - it only fills gaps.
 *
 *   npm run seed
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/lib/db';
import { Tenant, User, Scene } from '../src/models/index';
import { hashPassword } from '../src/lib/auth';

const GLOBAL_SCENES = [
  {
    name: 'खाटू श्याम जी',
    subtitle: 'श्री श्याम दरबार में दर्शन',
    referenceKey: 'global/refs/khatushyam.jpg',
    aspectRatio: '3:4',
    order: 1,
    scene:
      'A grand temple sanctum. The divine figure from IMAGE 2 is enthroned on a decorated altar on the left, surrounded by marigold and rose garlands, brass oil lamps, and soft golden light rays falling from above. Warm devotional atmosphere, incense haze in the air.',
    pose:
      'Place the visitor from IMAGE 1 standing on the right side of the frame, in front of and slightly below the altar, turned three-quarters toward the divine figure. Their palms are pressed together at chest height in a namaskar gesture, head bowed slightly, eyes lowered in reverence. Their expression is calm and devotional. Both figures are fully visible in one frame.',
    mood:
      'Warm golden-hour devotional lighting, rich saturated temple colours, shallow depth of field, shot like a respectful professional temple photograph.',
  },
  {
    name: 'भगवान महावीर',
    subtitle: 'महावीर स्वामी के चरणों में',
    referenceKey: 'global/refs/mahavir.jpg',
    aspectRatio: '3:4',
    order: 2,
    scene:
      'A serene white marble Jain temple interior. The figure from IMAGE 2 is seated in meditation on a raised marble pedestal on the left, framed by intricately carved arches, with soft diffused daylight and a calm minimal palette of white, cream and pale gold.',
    pose:
      'Place the visitor from IMAGE 1 on the right, standing a respectful distance from the pedestal, body turned toward the seated figure, palms joined together at the chest in a namaskar gesture, head gently bowed, peaceful expression. Both figures fully visible in one frame.',
    mood:
      'Soft, clean, diffused natural light. Serene and minimal. Low contrast, gentle shadows, tranquil and dignified.',
  },
  {
    name: 'Celebrity Meet',
    subtitle: 'Star ke saath ek yaadgaar photo',
    referenceKey: 'global/refs/celebrity.jpg',
    aspectRatio: '4:3',
    order: 3,
    scene:
      'A polished event backdrop - a red carpet step-and-repeat media wall with soft branded panels, bright event spotlights and a subtle blurred crowd with camera flashes in the background.',
    pose:
      'Place the visitor from IMAGE 1 standing shoulder-to-shoulder beside the person from IMAGE 2, both facing the camera and smiling naturally, as in a genuine fan meet-and-greet photograph. The person from IMAGE 2 has one arm relaxed around the visitor’s shoulder in a friendly pose. Natural, candid, equal footing, both faces clearly visible.',
    mood:
      'Bright, crisp event photography with an on-camera flash look, vibrant colours, slight background bokeh, shot at eye level on a 35mm lens.',
  },
];

/**
 * Mongoose never alters an index that already exists, so an old TTL index on
 * generations.expiresAt would survive the schema change and keep deleting rows
 * while leaving the stored image files orphaned. Drop it explicitly.
 */
async function dropLegacyTtlIndex() {
  const collection = mongoose.connection.collection('generations');
  const indexes = await collection.indexes().catch(() => []);
  for (const index of indexes) {
    if (index.key?.expiresAt !== undefined && index.expireAfterSeconds !== undefined) {
      await collection.dropIndex(index.name!);
      console.log(`Dropped legacy TTL index "${index.name}" (retention is handled by npm run cleanup)`);
    }
  }
}

/**
 * Schema defaults only apply to newly created documents, so tenants that
 * existed before identity lock was added would silently have it off.
 */
async function backfillFaceSettings() {
  const lock = await Tenant.updateMany(
    { 'settings.identityLock': { $exists: false } },
    { $set: { 'settings.identityLock': false } },
  );
  if (lock.modifiedCount) console.log(`Set identityLock on ${lock.modifiedCount} tenant(s)`);

  // The booth-side real-face blend supersedes the second AI pass: it is more
  // accurate, free, and adds seconds rather than minutes. Turn it on for
  // everyone, and turn the expensive pass off where it was only enabled as a
  // stand-in for this.
  const real = await Tenant.updateMany(
    { 'settings.realFace': { $exists: false } },
    { $set: { 'settings.realFace': true, 'settings.identityLock': false } },
  );
  if (real.modifiedCount) console.log(`Enabled real-face blending on ${real.modifiedCount} tenant(s)`);
}

/**
 * Keys used to live in a single `apiKey` field, back when Gemini was the only
 * provider. Move any of those under `apiKeys.gemini` and name the provider
 * explicitly, so nothing silently loses its key when the schema changes.
 */
async function migrateProviderKeys() {
  const collection = mongoose.connection.collection('tenants');

  const legacy = await collection.find({ apiKey: { $exists: true } }).toArray();
  for (const t of legacy) {
    await collection.updateOne(
      { _id: t._id },
      { $set: { 'apiKeys.gemini': t.apiKey, 'settings.provider': 'gemini' }, $unset: { apiKey: 1 } },
    );
  }
  if (legacy.length) console.log(`Moved ${legacy.length} key(s) to apiKeys.gemini`);

  const named = await collection.updateMany(
    { 'settings.provider': { $exists: false } },
    { $set: { 'settings.provider': 'gemini' } },
  );
  if (named.modifiedCount) console.log(`Set provider on ${named.modifiedCount} tenant(s)`);
}

async function main() {
  await connectDB();
  console.log('Connected to MongoDB\n');

  await dropLegacyTtlIndex();
  await backfillFaceSettings();
  await migrateProviderKeys();

  // ---- Superadmin -------------------------------------------------
  const email = (process.env.SUPERADMIN_EMAIL || 'admin@elloindia.com').toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || 'change-me-now';

  let superadmin = await User.findOne({ email, tenantId: null });
  if (superadmin) {
    console.log(`Superadmin already exists: ${email}`);
  } else {
    superadmin = await User.create({
      tenantId: null,
      email,
      name: 'Elloindia Admin',
      passwordHash: await hashPassword(password),
      role: 'superadmin',
    });
    console.log(`Superadmin created: ${email} / ${password}`);
    if (password === 'change-me-now') {
      console.log('   ^ change this immediately after first login');
    }
  }

  // ---- Global scene library --------------------------------------
  let added = 0;
  for (const scene of GLOBAL_SCENES) {
    const exists = await Scene.findOne({ tenantId: null, name: scene.name });
    if (!exists) {
      await Scene.create({ ...scene, tenantId: null });
      added++;
    }
  }
  console.log(`Global scenes: ${added} added, ${GLOBAL_SCENES.length - added} already present`);

  // ---- Demo tenant ------------------------------------------------
  let demo = await Tenant.findOne({ slug: 'demo' });
  if (demo) {
    console.log('Demo tenant already exists');
  } else {
    demo = await Tenant.create({
      name: 'Demo Events Pvt Ltd',
      slug: 'demo',
      status: 'active',
      keyMode: 'platform',
      credits: 100,
    });
    await User.create({
      tenantId: demo._id,
      email: 'admin@demo.com',
      name: 'Demo Admin',
      passwordHash: await hashPassword('demo1234'),
      role: 'tenant_admin',
    });
    await User.create({
      tenantId: demo._id,
      email: 'operator@demo.com',
      name: 'Demo Operator',
      passwordHash: await hashPassword('demo1234'),
      role: 'operator',
    });
    console.log('Demo tenant created with 100 credits');
    console.log('   admin@demo.com    / demo1234  (tenant_admin)');
    console.log('   operator@demo.com / demo1234  (operator)');
  }

  console.log('\nSeed complete.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
