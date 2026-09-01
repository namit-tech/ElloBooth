/**
 * The models a tenant can choose between, with what each is good for.
 *
 * Prices are per generated image and are indicative only - both providers
 * change them, and the real bill depends on size and prompt length. They are
 * here so a tenant can weigh cost against speed when picking, not as a quote.
 * `pricingUrl` is shown alongside so the authoritative number is one click away.
 */

export const PROVIDERS = ['gemini', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ImageSize = '1K' | '2K' | '4K';

export type ModelInfo = {
  id: string;
  provider: Provider;
  label: string;
  /** Roughly what one 1K image costs, in USD. */
  approxUsd: number;
  /** Rough wall-clock time for one image, for planning a queue. */
  speed: 'fastest' | 'fast' | 'moderate' | 'slow';
  sizes: ImageSize[];
  /** What this model is for, in the provider's own framing. */
  useCase: string;
};

export type ProviderInfo = {
  id: Provider;
  label: string;
  keyLabel: string;
  keyUrl: string;
  pricingUrl: string;
  /** Shown under the provider name when choosing. */
  summary: string;
};

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    keyUrl: 'https://aistudio.google.com/apikey',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    summary:
      'Strong at composing a person into a scene and at holding on to clothing and setting. Cheapest option at the fast end. This is what the booth was built and tested against.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    keyLabel: 'OpenAI API key',
    keyUrl: 'https://platform.openai.com/api-keys',
    pricingUrl: 'https://openai.com/api/pricing/',
    summary:
      'Strong at following detailed written instructions and at rendering text and logos cleanly. Its editing mode can be told to preserve the input photo closely, which suits branded backdrops.',
  },
};

export const MODELS: ModelInfo[] = [
  /* ---------------- Google Gemini ---------------- */
  {
    id: 'gemini-3.1-flash-lite-image',
    provider: 'gemini',
    label: 'Nano Banana 2 Lite',
    approxUsd: 0.034,
    speed: 'fastest',
    sizes: ['1K'],
    useCase:
      'Built for volume. Use it when a queue has to keep moving and the photos are viewed on a screen or phone rather than printed large.',
  },
  {
    id: 'gemini-3.1-flash-image',
    provider: 'gemini',
    label: 'Nano Banana 2',
    approxUsd: 0.067,
    speed: 'fast',
    sizes: ['1K', '2K'],
    useCase:
      'The balanced choice. Noticeably better detail and lighting than Lite while still fast enough for a live booth. A good default once an event is past the testing stage.',
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'gemini',
    label: 'Nano Banana Pro',
    approxUsd: 0.134,
    speed: 'slow',
    sizes: ['1K', '2K', '4K'],
    useCase:
      'Highest quality, and slow enough that a queue will back up behind it. Worth it for printed keepsakes or a small VIP booth, not for a busy hall.',
  },

  /* ---------------- OpenAI ---------------- */
  {
    id: 'gpt-image-1-mini',
    provider: 'openai',
    label: 'GPT Image 1 Mini',
    approxUsd: 0.011,
    speed: 'fastest',
    sizes: ['1K'],
    useCase:
      'OpenAI’s cheapest image model. Good for high-volume, screen-sized output where cost per photo matters more than fine detail.',
  },
  {
    id: 'gpt-image-1.5',
    provider: 'openai',
    label: 'GPT Image 1.5',
    approxUsd: 0.04,
    speed: 'fast',
    sizes: ['1K', '2K'],
    useCase:
      'Mid-tier. Follows long, specific instructions well and handles written text in a scene — useful when the backdrop carries a brand name or slogan.',
  },
  {
    id: 'gpt-image-2',
    provider: 'openai',
    label: 'GPT Image 2',
    approxUsd: 0.03,
    speed: 'moderate',
    sizes: ['1K', '2K', '4K'],
    useCase:
      'OpenAI’s current flagship, with the strongest layout control and text rendering. Supports high input fidelity, which keeps more of the visitor’s own photo intact.',
  },
];

export const modelsFor = (provider: Provider) => MODELS.filter((m) => m.provider === provider);

export const findModel = (id: string): ModelInfo | undefined => MODELS.find((m) => m.id === id);

/** Falls back to the cheapest model of that provider if the id is unknown. */
export function resolveModel(provider: Provider, id: string): ModelInfo {
  return findModel(id)?.provider === provider
    ? findModel(id)!
    : modelsFor(provider).reduce((a, b) => (a.approxUsd <= b.approxUsd ? a : b));
}

export const SPEED_LABEL: Record<ModelInfo['speed'], string> = {
  fastest: '~10 s',
  fast: '~20 s',
  moderate: '~40 s',
  slow: '~90 s',
};

/** Rough rupee figure for the dashboard; the dollar price is the real one. */
export const inRupees = (usd: number) => Math.round(usd * 88);
