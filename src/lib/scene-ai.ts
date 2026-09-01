import { describe as describeWithProvider, type Provider } from '@/lib/ai';
import type { ImageMime } from '@/lib/gemini';

/**
 * Writes a scene's prompt by looking at the reference image the tenant uploaded.
 *
 * Getting these three paragraphs right took several rounds of failures during
 * development - refused requests, faces in profile, deities redrawn as people.
 * Rather than leave every tenant to rediscover that, the rules learned from
 * those failures are baked into the instruction below, so a good starting
 * prompt comes back on the first try and they only have to edit wording.
 */

export type SceneDraft = {
  name: string;
  subtitle: string;
  kind: 'deity' | 'celebrity' | 'character' | 'other';
  aspectRatio: '3:4' | '4:3' | '1:1';
  scene: string;
  pose: string;
  mood: string;
};

const INSTRUCTION = `You are setting up a scene for an event photo booth.

A visitor stands at the booth, the booth photographs them, and an image model
then composes one photograph of that visitor together with the subject in the
attached reference image. Your job is to write the wording that guides it.

First work out what the reference image actually shows:
- "deity"     - a religious figure, idol, murti, or devotional artwork
- "celebrity" - a real, identifiable public person
- "character" - a mascot, cartoon or fictional character
- "other"     - anything else

Then write three paragraphs. Follow these rules; each one exists because
ignoring it produced a bad photograph:

1. SCENE - the setting the two of them appear in. Describe it as a real place
   with real light. If the reference is an idol, statue or painting, say so
   explicitly and say it should be rendered as that object in its own material
   and colours. Calling a murti "a figure" makes the model redraw it as a
   living person, which is wrong and disrespectful.

2. POSE - where the visitor stands and what they do. This one is strict:
   the visitor's head must stay upright with their face turned toward the
   camera at close to a full frontal angle, clearly lit and unobstructed. Never
   ask for a bowed head, a profile or a three-quarter turn - the booth replaces
   the face with the visitor's real one afterwards, and that only works on a
   near-frontal face. Devotion is carried by folded hands, not a lowered head.
   For a deity: standing respectfully with palms joined in namaskar.
   For a celebrity or character: standing beside them, both facing the camera.

3. MOOD - lighting and photographic style in one or two sentences.

Also write a short display name and a one-line subtitle for the booth screen.
Use the language that suits the subject - Hindi in Devanagari is right for
Indian deities.

Pick "3:4" for a single standing subject, "4:3" for two people side by side.

Never describe the visitor's clothing, face or body - those come from their own
photograph and must not be invented here.

Reply with JSON only, no markdown fence:
{"name":"","subtitle":"","kind":"","aspectRatio":"","scene":"","pose":"","mood":""}`;

function parseDraft(text: string): SceneDraft | null {
  // Models sometimes wrap JSON in a fence despite being told not to.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as Partial<SceneDraft>;
    if (!raw.scene || !raw.pose) return null;

    const kinds = ['deity', 'celebrity', 'character', 'other'] as const;
    const ratios = ['3:4', '4:3', '1:1'] as const;

    return {
      name: (raw.name || 'Untitled scene').slice(0, 80),
      subtitle: (raw.subtitle || '').slice(0, 140),
      kind: kinds.includes(raw.kind as never) ? (raw.kind as SceneDraft['kind']) : 'other',
      aspectRatio: ratios.includes(raw.aspectRatio as never)
        ? (raw.aspectRatio as SceneDraft['aspectRatio'])
        : '3:4',
      scene: raw.scene.slice(0, 1500),
      pose: raw.pose.slice(0, 1500),
      mood: (raw.mood || '').slice(0, 800),
    };
  } catch {
    return null;
  }
}

export type DescribeResult = { ok: true; draft: SceneDraft } | { ok: false; reason: string };

export async function describeScene(opts: {
  provider: Provider;
  apiKey: string;
  image: { mime_type: ImageMime; data: string };
  /** Optional steer from the tenant, e.g. "this is Khatu Shyam ji". */
  hint?: string;
}): Promise<DescribeResult> {
  const prompt = opts.hint?.trim()
    ? `${INSTRUCTION}\n\nThe person setting this up says: "${opts.hint.trim().slice(0, 300)}"`
    : INSTRUCTION;

  const said = await describeWithProvider(opts.provider, opts.apiKey, opts.image, prompt);
  if (!said.ok) return { ok: false, reason: said.reason };

  const draft = parseDraft(said.text);
  return draft
    ? { ok: true, draft }
    : { ok: false, reason: 'Could not read a scene out of the reply. Try again, or write it by hand.' };
}
