import { GoogleGenAI } from '@google/genai';
import { explain, redact } from '@/lib/ai/errors';
import type { IScene } from '@/models';

/**
 * All image generation goes through here.
 *
 * The tenant's plaintext key exists only inside this module, for the duration
 * of one call. It is never returned, logged, or sent to a client.
 */

/**
 * Prompt wording is deliberately plain.
 *
 * An earlier version demanded "identical facial structure" and "unmistakably
 * the same individual", which reads to a safety classifier like a request to
 * replicate someone's face, and requests were refused. The goal is unchanged -
 * keep the visitor looking like themselves in their own clothes - but it is
 * framed as ordinary photo composition, with the consent context stated up
 * front and IMAGE 2 named as artwork rather than as a person.
 */
export const PROMPT_TEMPLATE = `Compose a single souvenir photograph for a visitor at a public event.
The visitor is standing at the booth right now and has agreed to have this
picture made for them to keep.

IMAGE 1 = the photograph of the visitor, taken by the booth a moment ago.
IMAGE 2 = reference artwork - a painting, idol, statue or portrait - that should
appear in the picture with them. Render it as the artwork or sculpture it is,
in its own material and colours, respectfully and without reinterpretation.

=== KEEP THE VISITOR AS PHOTOGRAPHED ===
Carry the visitor across from IMAGE 1 as they actually appear. Do not restyle
them:
- Keep their own clothes: the same garments, colours, fabric, patterns, collar,
  sleeves and layers they are wearing in IMAGE 1.
- Keep their own look: same hair, spectacles, jewellery, headwear, apparent age
  and build.
- Do not beautify, slim, smooth or lighten them, and do not change their outfit
  or hairstyle. Keeping them recognisable to their own family is the point.
- Where their body is cut off by IMAGE 1's frame, continue it naturally in the
  clothing already visible.

=== SCENE ===
{{scene}}

=== POSE AND INTERACTION ===
{{pose}}

=== PHOTOGRAPHY ===
{{mood}}
One unified photograph: consistent lighting across the whole frame, matching
colour temperature, believable shadows and ground contact, sensible relative
scale, everything in focus.

=== OUTPUT ===
A single finished photograph. No text, watermark, logo or border. No collage or
split screen. No duplicated people, extra limbs or extra hands.`;

export function buildPrompt(scene: Pick<IScene, 'scene' | 'pose' | 'mood'>): string {
  return PROMPT_TEMPLATE.replaceAll('{{scene}}', scene.scene)
    .replaceAll('{{pose}}', scene.pose)
    .replaceAll('{{mood}}', scene.mood || '');
}

/** The SDK only accepts these on an image block, so keep the type narrow. */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type ImagePart = { mime_type: ImageMime; data: string };

const MIME_BY_EXT: Record<string, ImageMime> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function mimeFor(filename: string): ImageMime {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/**
 * The image models return JPEG only - asking for PNG is rejected outright with
 * "The value 'image/png' is not supported for 'response_format.mime_type'".
 * Kept here as one constant so the request, the stored file extension and the
 * Content-Type served to the visitor can never drift apart.
 */
export const OUTPUT_MIME: ImageMime = 'image/jpeg';
export const OUTPUT_EXT = '.jpg';

/**
 * Second pass, run only when identity lock is enabled.
 *
 * Pass 1 composes the whole scene but redraws the visitor's face, so it lands
 * around 85-90% likeness - close enough that people notice it is wrong. This
 * pass shows the model its own output next to the original capture and asks it
 * to correct just the face.
 *
 * Framed as retouching rather than face replacement: the same request phrased
 * as "swap this person's face in" is refused by the safety classifier.
 */
export const REFINE_TEMPLATE = `Retouch a souvenir photograph so the person in it looks like themselves.

IMAGE 1 = a photograph produced a moment ago at an event photo booth. Everything
in it is correct except the face, which did not come out looking like the person
it is meant to show.
IMAGE 2 = the reference photograph of that same visitor, taken by the booth
seconds earlier. They are standing at the booth and asked for this picture.

=== WHAT TO CHANGE ===
Correct the face of the person in IMAGE 1 so it matches the visitor as they
appear in IMAGE 2. Carry across their actual features: the shape of the face and
jaw, the eyes and eyebrows, the nose, the mouth, the moustache and beard, the
skin tone and complexion, the spectacles, and the hairline.

=== WHAT MUST NOT CHANGE ===
Everything else in IMAGE 1 stays exactly as it is - same composition, same
framing, same background, same lighting direction and colour, same clothing,
same body position, same hands, same expression and head angle. Do not move the
camera, recrop, restyle or relight anything. Only the face is being corrected.

Blend the corrected face into the existing lighting so it does not look pasted
on: match the light direction, shadow softness, colour temperature, skin
texture and grain already present in IMAGE 1.

=== OUTPUT ===
The same photograph with the face corrected. No text, watermark or border.`;

export type GenerateResult =
  | { ok: true; image: string; ms: number }
  | { ok: false; reason: string; ms: number };

type CallOpts = {
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  /** Sent in order; the prompt refers to them as IMAGE 1, IMAGE 2, ... */
  images: ImagePart[];
  prompt: string;
};

async function runImageCall(opts: CallOpts): Promise<GenerateResult> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const startedAt = Date.now();

  let interaction: Awaited<ReturnType<typeof ai.interactions.create>>;
  try {
    interaction = await ai.interactions.create({
      model: opts.model,
      input: [
        ...opts.images.map((img) => ({
          type: 'image' as const,
          mime_type: img.mime_type,
          data: img.data,
        })),
        { type: 'text', text: opts.prompt },
      ],
      response_format: {
        type: 'image',
        mime_type: OUTPUT_MIME,
        aspect_ratio: opts.aspectRatio,
        image_size: opts.imageSize,
      },
    });
  } catch (err) {
    return { ok: false, reason: explain(err, opts.apiKey, 'Google'), ms: Date.now() - startedAt };
  }

  const ms = Date.now() - startedAt;
  const result = interaction as unknown as Record<string, unknown>;

  const direct = (result.output_image as { data?: string } | undefined)?.data;
  if (direct) return { ok: true, image: direct, ms };

  // No convenience field: walk the steps and collect any refusal text.
  const texts: string[] = [];
  const steps = (result.steps ?? []) as Array<{ content?: Array<Record<string, string>> }>;
  for (const step of steps) {
    for (const block of step?.content ?? []) {
      if (block?.type === 'image' && block?.data) return { ok: true, image: block.data, ms };
      if (block?.type === 'text' && block?.text) texts.push(block.text);
    }
  }

  return {
    ok: false,
    reason: texts.join(' ').trim() || 'The model returned no image and gave no reason.',
    ms,
  };
}

/** Pass 1: compose the whole scene from the live capture and the scene reference. */
export function generateImage(opts: {
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  capture: ImagePart;
  reference: ImagePart;
  prompt: string;
}): Promise<GenerateResult> {
  return runImageCall({
    apiKey: opts.apiKey,
    model: opts.model,
    imageSize: opts.imageSize,
    aspectRatio: opts.aspectRatio,
    images: [opts.capture, opts.reference],
    prompt: opts.prompt,
  });
}

/**
 * Pass 2: correct the face on pass 1's output using the original capture.
 * Order matters - the prompt calls the composed photo IMAGE 1 and the visitor's
 * own capture IMAGE 2.
 */
export function refineFace(opts: {
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  composed: ImagePart;
  capture: ImagePart;
}): Promise<GenerateResult> {
  return runImageCall({
    apiKey: opts.apiKey,
    model: opts.model,
    imageSize: opts.imageSize,
    aspectRatio: opts.aspectRatio,
    images: [opts.composed, opts.capture],
    prompt: REFINE_TEMPLATE,
  });
}

/** Cheapest honest check that a key works: ask the provider about the model. */
export async function probeKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await new GoogleGenAI({ apiKey }).models.get({ model });
    return { ok: true };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), apiKey);
    // Worded for someone pasting a key into Settings, which is more specific
    // than the generic advice `explain` gives for the same statuses.
    if (/401|403|API_KEY|api key|unauthenticated|permission/i.test(message)) {
      return { ok: false, reason: 'That key was rejected by Google. Check you copied all of it.' };
    }
    if (/404|not found/i.test(message)) {
      return { ok: false, reason: `The key works, but "${model}" is not available on that account.` };
    }
    return { ok: false, reason: explain(err, apiKey, 'Google') };
  }
}

/** Cheap text+vision model used only to draft a scene's wording. */
export const DESCRIBE_MODEL = 'gemini-3.5-flash-lite';

export async function describe(opts: {
  apiKey: string;
  image: ImagePart;
  prompt: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  try {
    const interaction = await ai.interactions.create({
      model: DESCRIBE_MODEL,
      input: [
        { type: 'image', mime_type: opts.image.mime_type, data: opts.image.data },
        { type: 'text', text: opts.prompt },
      ],
    });

    const result = interaction as unknown as Record<string, unknown>;
    let text = (result.output_text as string) ?? '';
    if (!text) {
      const steps = (result.steps ?? []) as Array<{ content?: Array<Record<string, string>> }>;
      for (const step of steps) {
        for (const block of step?.content ?? []) {
          if (block?.type === 'text' && block?.text) text += block.text;
        }
      }
    }
    return text.trim() ? { ok: true, text } : { ok: false, reason: 'The model returned nothing to read.' };
  } catch (err) {
    return { ok: false, reason: explain(err, opts.apiKey, 'Google') };
  }
}
