import { HttpError } from '@/lib/rbac';
import { open } from '@/lib/crypto';
import * as gemini from '@/lib/gemini';
import * as openai from './openai';
import { PROVIDER_INFO, resolveModel, type Provider } from './catalogue';
import type { ITenant } from '@/models';
import type { GenerateResult, ImagePart } from '@/lib/gemini';

/**
 * One entry point for both providers.
 *
 * Everything above this layer - the booth route, the scene drafter, the
 * settings page - works in terms of "the tenant's provider" and never names
 * Google or OpenAI. Adding a third provider means a file next to `openai.ts`
 * and two lines here.
 */

export * from './catalogue';
export type { GenerateResult, ImagePart };

export function providerOf(tenant: ITenant): Provider {
  return (tenant.settings.provider ?? 'gemini') as Provider;
}

/**
 * Opens the sealed key for whichever provider this tenant is set to use.
 * Keys are held per provider, since one will not authenticate the other.
 */
export function resolveApiKey(tenant: ITenant): string {
  const provider = providerOf(tenant);
  const info = PROVIDER_INFO[provider];

  if (tenant.keyMode === 'byok') {
    const sealed = tenant.apiKeys?.[provider];
    if (!sealed?.ciphertext) {
      throw new HttpError(
        400,
        `No ${info.label} key configured`,
        `Add your ${info.keyLabel} in Settings, or switch this account to platform credits.`,
      );
    }
    try {
      return open(sealed);
    } catch {
      throw new HttpError(500, 'Stored API key could not be read', 'Please re-enter it in Settings.');
    }
  }

  const platformKey =
    provider === 'openai' ? process.env.PLATFORM_OPENAI_KEY : process.env.PLATFORM_GEMINI_KEY;
  if (!platformKey) {
    throw new HttpError(
      500,
      `Platform ${info.label} key is not configured`,
      'Contact Elloindia support, or add your own key in Settings.',
    );
  }
  return platformKey;
}

export function generateImage(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  capture: ImagePart;
  reference: ImagePart;
  prompt: string;
}): Promise<GenerateResult> {
  const { provider, ...rest } = opts;
  return provider === 'openai' ? openai.generateImage(rest) : gemini.generateImage(rest);
}

export function refineFace(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  imageSize: string;
  aspectRatio: string;
  composed: ImagePart;
  capture: ImagePart;
}): Promise<GenerateResult> {
  const { provider, ...rest } = opts;
  return provider === 'openai'
    ? openai.refineFace({ ...rest, prompt: gemini.REFINE_TEMPLATE })
    : gemini.refineFace(rest);
}

export async function probeKey(
  provider: Provider,
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return provider === 'openai' ? openai.probeKey(apiKey, model) : gemini.probeKey(apiKey, model);
}

/** Vision call used only when drafting a scene's wording. */
export async function describe(
  provider: Provider,
  apiKey: string,
  image: ImagePart,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  return provider === 'openai'
    ? openai.describe({ apiKey, image, prompt })
    : gemini.describe({ apiKey, image, prompt });
}

/** The model a tenant's photos should be generated with, validated. */
export function modelFor(tenant: ITenant) {
  return resolveModel(providerOf(tenant), tenant.settings.model);
}
