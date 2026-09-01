/**
 * Uploads a reference image for a scene from the command line.
 *
 * A scene without its reference image cannot generate anything, so the booth
 * greys it out. Use this until the scene-management UI exists.
 *
 *   npm run scene:list
 *   npm run scene:import -- <sceneId|name> <path-to-image>
 *
 * Example:
 *   npm run scene:import -- khatushyam ./refs/khatushyam.jpg
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose, { Types } from 'mongoose';
import { connectDB } from '../src/lib/db';
import { Scene, Tenant, type IScene, type ITenant } from '../src/models';
import { put, exists } from '../src/lib/storage';

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp'];

async function list() {
  const scenes = await Scene.find().sort({ tenantId: 1, order: 1 }).lean<IScene[]>();
  const tenants = await Tenant.find({}, { name: 1 }).lean<ITenant[]>();
  const names = new Map(tenants.map((t) => [String(t._id), t.name]));

  if (scenes.length === 0) {
    console.log('No scenes. Run: npm run seed');
    return;
  }

  console.log('\nScenes:\n');
  for (const s of scenes) {
    const ready = (await exists(s.referenceKey)) ? 'ready ' : 'NO REF';
    const owner = s.tenantId ? (names.get(String(s.tenantId)) ?? 'unknown tenant') : 'global library';
    console.log(`  [${ready}]  ${String(s._id)}  ${s.name}`);
    console.log(`             ${owner} · key: ${s.referenceKey}`);
  }
  console.log('\nImport with:  npm run scene:import -- <sceneId> <image>\n');
}

async function main() {
  await connectDB();

  const [, , target, imagePath] = process.argv;

  if (!target) {
    await list();
    await mongoose.disconnect();
    return;
  }

  if (!imagePath) {
    console.error('Usage: npm run scene:import -- <sceneId|name> <path-to-image>');
    process.exit(1);
  }

  // Accept an id or a case-insensitive name, since ids are awkward to type.
  const scene = Types.ObjectId.isValid(target)
    ? await Scene.findById(target).lean<IScene>()
    : await Scene.findOne({ name: new RegExp(`^${target}$`, 'i') }).lean<IScene>();

  if (!scene) {
    console.error(`No scene matches "${target}". Run npm run scene:list to see them.`);
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`File not found: ${imagePath}`);
    process.exit(1);
  }

  const ext = path.extname(imagePath).toLowerCase();
  if (!ALLOWED.includes(ext)) {
    console.error(`Unsupported format "${ext}". Use one of: ${ALLOWED.join(', ')}`);
    process.exit(1);
  }

  const bytes = fs.readFileSync(imagePath);
  const kb = bytes.length / 1024;
  if (kb < 20) {
    console.error(`That image is only ${kb.toFixed(0)} KB. Reference images should be high resolution.`);
    process.exit(1);
  }

  // The stored key carries the extension so the API sends the right mime type.
  const key = scene.referenceKey.replace(/\.[^.]+$/, ext);
  await put(key, bytes);
  if (key !== scene.referenceKey) {
    await Scene.updateOne({ _id: scene._id }, { referenceKey: key });
  }

  console.log(`\nImported reference for "${scene.name}"`);
  console.log(`  ${imagePath}  ->  ${key}  (${kb.toFixed(0)} KB)`);
  console.log('\nThe booth will show this scene as ready on its next reload.\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
