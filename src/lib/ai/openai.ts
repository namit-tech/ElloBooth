import OpenAI, { toFile } from 'openai';
import type { GenerateResult, ImagePart } from '@/lib/gemini';
import type { ImageSize } from './catalogue';

/**
 * OpenAI image backend.
 *
 * Composition uses `images.edit` with both pictures attached, which is the
 * counterpart to Gemini's multi-image input. `input_fidelity: 'high'` matters
 * here: it tells the model to hold on to what is actually in the supplied
 * photographs rather than reinterpreting them, which is the whole point of the
 * booth keeping the visitor's own clothes and setting.
 */

/** OpenAI takes explicit pixel dimensions rather than a ratio plus a tier. */
function pixelSize(aspectRatio: string, size: ImageSize): '1024x1024' | '1536x1024' | '1024x1536' {
  const portrait = aspectRatio === '3:4' || aspectRatio === '9:16' || aspectRatio === '2:3';
  const landscape = aspectRatio === '4:3' || aspectRatio === '16:9' || aspectRatio === '3:2';
  // 2K/4K are requested through quality rather than dimensions on this API, so
  // the tier is deliberately not folded into the pixel size here.
  void size;
  if (portrait) return '1024x1536';
  if (landscape) return '1536x1024';
  return '1024x1024';
}

function quality(size: ImageSize): 'low' | 'medium' | 'high' {
  return size === '4K' ? 'high' : size === '2K' ? 'medium' : 'low';
}

const nameFor = (part: ImagePart, i: number) =>
  `image-${i}.${part.mime_type === 'image/png' ? 'png' : part.mime_type === 'image/webp' ? 'webp' : 'jpg'}`;

async function runEdit(opts: {
  apiKey: string;
  model: string;
  imageSize: ImageSize;
  aspectRatio: string;
  images: ImagePart[];
  prompt: string;
}): Promise<GenerateResult> {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const startedAt = Date.now();

  try {
    const files = await Promise.all(
      opts.images.map((part, i) =>
        toFile(Buffer.from(part.data, 'base64'), nameFor(part, i), { type: part.mime_type }),
      ),
    );

    const response = await client.images.edit({
      model: opts.model,
      image: files,
      prompt: opts.prompt,
      size: pixelSize(opts.aspectRatio, opts.imageSize),
      quality: quality(opts.imageSize),
      input_fidelity: 'high',
      n: 1,
    });

    const ms = Date.now() - startedAt;
    const image = response.data?.[0]?.b64_json;
    if (!image) {
      return { ok: false, reason: 'OpenAI returned no image data.', ms };
    }
    return { ok: true, image, ms };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Never let a provider error echo the key back into logs or responses.
    return { ok: false, reason: raw.replace(/sk-[\w-]+/g, 'sk-…').slice(0, 400), ms: Date.now() - startedAt };
  }
}

export function generateImage(opts: {
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  capture: ImagePart;
  reference: ImagePart;
  prompt: string;
}): Promise<GenerateResult> {
  return runEdit({
    apiKey: opts.apiKey,
    model: opts.model,
    imageSize: opts.imageSize as ImageSize,
    aspectRatio: opts.aspectRatio,
    images: [opts.capture, opts.reference],
    prompt: opts.prompt,
  });
}

export function refineFace(opts: {
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  composed: ImagePart;
  capture: ImagePart;
  prompt: string;
}): Promise<GenerateResult> {
  return runEdit({
    apiKey: opts.apiKey,
    model: opts.model,
    imageSize: opts.imageSize as ImageSize,
    aspectRatio: opts.aspectRatio,
    images: [opts.composed, opts.capture],
    prompt: opts.prompt,
  });
}

/** Cheap text+vision model used only to draft a scene's wording. */
export const DESCRIBE_MODEL = 'gpt-5.1-mini';

export async function describe(opts: {
  apiKey: string;
  image: ImagePart;
  prompt: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const client = new OpenAI({ apiKey: opts.apiKey });
  try {
    const response = await client.responses.create({
      model: DESCRIBE_MODEL,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: opts.prompt },
            { type: 'input_image', image_url: `data:${opts.image.mime_type};base64,${opts.image.data}`, detail: 'auto' },
          ],
        },
      ],
    });
    const text = response.output_text ?? '';
    return text.trim() ? { ok: true, text } : { ok: false, reason: 'OpenAI returned nothing to read.' };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: raw.replace(/sk-[\w-]+/g, 'sk-…').slice(0, 300) };
  }
}

/** Cheapest honest check that a key works: list the models it can see. */
export async function probeKey(apiKey: string, model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await new OpenAI({ apiKey }).models.retrieve(model);
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.replace(/sk-[\w-]+/g, 'sk-…');
    if (/401|invalid_api_key|incorrect api key|unauthorized/i.test(message)) {
      return { ok: false, reason: 'That key was rejected by OpenAI. Check you copied all of it.' };
    }
    if (/404|does not exist|not found/i.test(message)) {
      return { ok: false, reason: `The key works, but "${model}" is not available on that account.` };
    }
    return { ok: false, reason: message.slice(0, 300) };
  }
}
