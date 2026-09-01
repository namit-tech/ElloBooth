/**
 * One-shot check that the API key, model id and response shape all work,
 * without needing the camera or a browser.
 *
 *   node test-api.js                     -> text-only image, verifies the basics
 *   node test-api.js khatushyam me.jpg   -> full pipeline on a real photo
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const [, , sceneId, photoPath] = process.argv;

if (!process.env.GEMINI_API_KEY) {
  console.error('\n  GEMINI_API_KEY missing.');
  console.error('  1. Copy .env.example to .env');
  console.error('  2. Paste your key from https://aistudio.google.com/apikey\n');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync('config/scenes.json', 'utf8'));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const asPart = (file) => ({
  type: 'image',
  mime_type: MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
  data: fs.readFileSync(file).toString('base64'),
});

function buildInput() {
  if (!sceneId) {
    console.log('Mode: basic (text only) - checking key, model and response shape\n');
    return {
      aspect: '1:1',
      input: [{ type: 'text', text: 'A simple photorealistic still life: a brass oil lamp glowing on a dark wooden table.' }],
    };
  }

  const scene = cfg.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    console.error(`Unknown scene "${sceneId}". Available: ${cfg.scenes.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }
  const ref = path.join('scenes', scene.reference);
  if (!fs.existsSync(ref)) {
    console.error(`Reference image missing: ${ref}`);
    process.exit(1);
  }
  if (!photoPath || !fs.existsSync(photoPath)) {
    console.error('Pass a photo of a person as the second argument, e.g. node test-api.js khatushyam me.jpg');
    process.exit(1);
  }

  const template = fs.readFileSync('config/prompt-template.txt', 'utf8');
  const prompt = template
    .replaceAll('{{scene}}', scene.scene)
    .replaceAll('{{pose}}', scene.pose)
    .replaceAll('{{mood}}', scene.mood || '');

  console.log(`Mode: full pipeline\n  scene     : ${scene.name} (${scene.id})\n  person    : ${photoPath}\n  reference : ${ref}\n`);
  return {
    aspect: scene.aspectRatio || '3:4',
    input: [asPart(photoPath), asPart(ref), { type: 'text', text: prompt }],
  };
}

const { input, aspect } = buildInput();
console.log(`Model: ${cfg.model}  |  ${aspect}  |  ${cfg.imageSize || '1K'}`);
console.log('Calling the API...\n');

const t0 = Date.now();
let interaction;
try {
  interaction = await ai.interactions.create({
    model: cfg.model,
    input,
    response_format: {
      type: 'image',
      mime_type: 'image/png',
      aspect_ratio: aspect,
      image_size: cfg.imageSize || '1K',
    },
  });
} catch (err) {
  console.error('REQUEST FAILED:', err?.message || err);
  console.error('\nCommon causes:');
  console.error('  - wrong or expired API key');
  console.error(`  - model "${cfg.model}" not enabled on your account (try gemini-3.1-flash-image)`);
  console.error('  - no internet / proxy blocking generativelanguage.googleapis.com');
  process.exit(1);
}

// Same extraction the server uses, so this test actually proves the server path.
let image = interaction?.output_image?.data || null;
const texts = [];
if (!image) {
  for (const step of interaction?.steps ?? []) {
    for (const block of step?.content ?? []) {
      if (block?.type === 'image' && block?.data) image = image || block.data;
      if (block?.type === 'text' && block?.text) texts.push(block.text);
    }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (!image) {
  console.error(`No image returned after ${secs}s.`);
  if (texts.length) console.error('\nModel said:\n  ' + texts.join(' ').trim());
  else console.error('\nNo explanation given. Raw response keys: ' + Object.keys(interaction || {}).join(', '));
  process.exit(1);
}

fs.mkdirSync('output', { recursive: true });
const out = path.join('output', `test-${sceneId || 'basic'}-${Date.now()}.png`);
fs.writeFileSync(out, Buffer.from(image, 'base64'));

console.log(`SUCCESS in ${secs}s`);
console.log(`Saved: ${out}`);
console.log(`Size : ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
console.log('\nIf that time is acceptable, the booth is good to go. If it is slow,');
console.log('switch "model" in config/scenes.json to a faster/cheaper option.');
