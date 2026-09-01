import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const DIR = {
  config: path.join(__dirname, 'config'),
  scenes: path.join(__dirname, 'scenes'),
  output: path.join(__dirname, 'output'),
  public: path.join(__dirname, 'public'),
};
fs.mkdirSync(DIR.output, { recursive: true });

if (!process.env.GEMINI_API_KEY) {
  console.error('\n  GEMINI_API_KEY missing. Copy .env.example to .env and paste your key.');
  console.error('  Get one free at https://aistudio.google.com/apikey\n');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Config is re-read on every request so the operator can edit scenes.json
// mid-event and just refresh the browser - no server restart needed.
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR.config, 'scenes.json'), 'utf8'));
  cfg.promptTemplate = fs.readFileSync(path.join(DIR.config, 'prompt-template.txt'), 'utf8');
  return cfg;
}

function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return 'localhost';
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function readReference(filename) {
  const file = path.join(DIR.scenes, filename);
  if (!fs.existsSync(file)) return null;
  return {
    mime_type: MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
    data: fs.readFileSync(file).toString('base64'),
  };
}

function buildPrompt(scene, template) {
  return template
    .replaceAll('{{scene}}', scene.scene)
    .replaceAll('{{pose}}', scene.pose)
    .replaceAll('{{mood}}', scene.mood || '');
}

// The SDK exposes the generated image in a couple of shapes depending on
// version, so check the convenience field first and then walk the steps.
function extractResult(interaction) {
  if (interaction?.output_image?.data) {
    return { image: interaction.output_image.data };
  }
  const texts = [];
  for (const step of interaction?.steps ?? []) {
    for (const block of step?.content ?? []) {
      if (block?.type === 'image' && block?.data) return { image: block.data };
      if (block?.type === 'text' && block?.text) texts.push(block.text);
    }
  }
  // No image came back - the model almost always explains why in text.
  return { image: null, message: texts.join(' ').trim() };
}

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(DIR.public));
app.use('/output', express.static(DIR.output));
app.use('/scenes', express.static(DIR.scenes));

app.get('/api/config', (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({
      model: cfg.model,
      autoCaptureSeconds: cfg.autoCaptureSeconds ?? 2,
      countdownSeconds: cfg.countdownSeconds ?? 3,
      resultDisplaySeconds: cfg.resultDisplaySeconds ?? 25,
      scenes: cfg.scenes.map((s) => ({
        id: s.id,
        name: s.name,
        subtitle: s.subtitle,
        aspectRatio: s.aspectRatio || '3:4',
        // Lets the UI grey out scenes whose reference photo hasn't been added yet.
        ready: fs.existsSync(path.join(DIR.scenes, s.reference)),
        reference: s.reference,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  const started = Date.now();
  try {
    const { sceneId, imageBase64, mimeType } = req.body;
    const cfg = loadConfig();
    const scene = cfg.scenes.find((s) => s.id === sceneId);
    if (!scene) return res.status(400).json({ error: `Unknown scene "${sceneId}"` });
    if (!imageBase64) return res.status(400).json({ error: 'No capture received' });

    const reference = readReference(scene.reference);
    if (!reference) {
      return res.status(400).json({
        error: `Reference image missing: scenes/${scene.reference}`,
        hint: 'Add the file to the scenes/ folder, then try again.',
      });
    }

    const interaction = await ai.interactions.create({
      model: cfg.model,
      input: [
        { type: 'image', mime_type: mimeType || 'image/jpeg', data: imageBase64 },
        { type: 'image', mime_type: reference.mime_type, data: reference.data },
        { type: 'text', text: buildPrompt(scene, cfg.promptTemplate) },
      ],
      response_format: {
        type: 'image',
        mime_type: 'image/png',
        aspect_ratio: scene.aspectRatio || '3:4',
        image_size: cfg.imageSize || '1K',
      },
    });

    const { image, message } = extractResult(interaction);
    if (!image) {
      console.warn(`[refused] ${scene.id}: ${message || 'no image and no explanation'}`);
      return res.status(422).json({
        error: 'Model did not return an image',
        detail: message || 'The request was declined without an explanation.',
      });
    }

    const filename = `${scene.id}-${Date.now()}.png`;
    fs.writeFileSync(path.join(DIR.output, filename), Buffer.from(image, 'base64'));

    const shareUrl = `http://${lanAddress()}:${PORT}/photo/${filename}`;
    const ms = Date.now() - started;
    console.log(`[ok] ${scene.id} -> ${filename} (${(ms / 1000).toFixed(1)}s)`);

    res.json({
      imageUrl: `/output/${filename}`,
      shareUrl,
      qr: await QRCode.toDataURL(shareUrl, { margin: 1, width: 320 }),
      ms,
    });
  } catch (err) {
    console.error('[error]', err?.message || err);
    res.status(500).json({ error: err?.message || 'Generation failed' });
  }
});

// Landing page the visitor's phone opens after scanning the QR code.
app.get('/photo/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!fs.existsSync(path.join(DIR.output, file))) return res.status(404).send('Photo not found');
  res.type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Photo</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:20px;background:#12100e;color:#f5efe6;
       font-family:system-ui,sans-serif;padding:20px;box-sizing:border-box}
  img{max-width:100%;max-height:72vh;border-radius:12px;box-shadow:0 8px 40px #0009}
  a{background:#e0a63c;color:#12100e;padding:14px 34px;border-radius:999px;
    font-weight:700;text-decoration:none;font-size:17px}
  p{opacity:.55;font-size:13px;margin:0}
</style>
<img src="/output/${file}" alt="Your photo">
<a href="/output/${file}" download="${file}">Download</a>
<p>Image par der tak dabakar bhi save kar sakte hain</p>`);
});

app.listen(PORT, () => {
  console.log(`\n  AI Photo Booth running`);
  console.log(`  Kiosk screen : http://localhost:${PORT}`);
  console.log(`  Phone / LAN  : http://${lanAddress()}:${PORT}\n`);
});
