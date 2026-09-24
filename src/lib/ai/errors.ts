/**
 * Turns a provider's exception into something safe to store and useful to read.
 *
 * Two jobs, both of which were being done badly in five separate catch blocks.
 *
 * REDACTION. Keys were being masked by matching their shape - `AIza…` for
 * Google, `sk-…` for OpenAI. Google now issues keys that begin `AQ.`, so that
 * pattern matched nothing and a provider error carrying the key would have been
 * written to the log, saved on the generation row, and printed on the booth
 * screen in front of whoever was standing there. Shape is the wrong thing to
 * match on: the key itself is in scope at every call site, so the literal
 * string is removed and the patterns stay only as a net for keys that arrive
 * nested inside someone else's error.
 *
 * EXPLANATION. The SDK's message for a refused request is
 * `402 API error occurred: {"httpMeta":{"response":{},"request":{}}}`, which
 * tells an operator at an event precisely nothing. The status code is the one
 * piece of real information in it, so it is turned into a sentence naming what
 * to actually go and do.
 */

/** Shapes to strip even when the key was never passed to us. */
const KEY_PATTERNS: RegExp[] = [
  /AIza[\w-]{20,}/g, // Google, classic
  /AQ\.[\w-]{20,}/g, // Google, current
  /sk-[\w-]{20,}/g, // OpenAI
];

/** Removes the key from anything about to be logged, stored or displayed. */
export function redact(text: string, apiKey?: string): string {
  let safe = text;

  // The literal key first - it works whatever shape the provider invents next.
  if (apiKey && apiKey.length >= 8) {
    safe = safe.split(apiKey).join('…redacted…');
  }
  for (const pattern of KEY_PATTERNS) safe = safe.replace(pattern, '…redacted…');

  return safe;
}

/** What an operator should do about each status, in plain words. */
const BY_STATUS: Record<number, string> = {
  400: 'The provider rejected the request as malformed. This is usually a scene whose wording it will not accept.',
  401: 'The API key was rejected. Re-enter it in Settings.',
  402: 'The provider is refusing to bill this request. Check that billing is active on the account behind this key and that it has credit.',
  403: 'This key is not allowed to use that model. Check the key, or pick a different model in Settings.',
  404: 'That model is not available on this account. Pick a different one in Settings.',
  413: 'The capture was too large for the provider to accept.',
  429: 'The provider is rate limiting this key. Wait a moment, or move to a key with more headroom.',
  500: 'The provider is having trouble at its end. Try again in a moment.',
  502: 'The provider is having trouble at its end. Try again in a moment.',
  503: 'The provider is temporarily unavailable. Try again in a moment.',
  504: 'The provider took too long to answer. Try again in a moment.',
};

/**
 * Pulls the HTTP status out of an SDK error. Both SDKs expose it as `.status`,
 * and both also lead their message with it, so the message is the fallback.
 */
function statusOf(err: unknown): number | null {
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown };

  for (const value of [candidate?.status, candidate?.code]) {
    const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    if (typeof n === 'number' && n >= 400 && n <= 599) return n;
  }

  const leading = /^(\d{3})\b/.exec(String(candidate?.message ?? ''));
  if (leading) {
    const n = Number.parseInt(leading[1], 10);
    if (n >= 400 && n <= 599) return n;
  }

  return null;
}

/**
 * One line, safe to show a visitor and worth storing on the generation row.
 *
 * @param err     whatever the SDK threw
 * @param apiKey  the key used for the call, so it can be removed by value
 * @param label   the provider's name, for when there is nothing else to say
 */
export function explain(err: unknown, apiKey?: string, label = 'The provider'): string {
  const raw = redact(err instanceof Error ? err.message : String(err), apiKey);
  const status = statusOf(err);

  if (status && BY_STATUS[status]) return `${status} — ${BY_STATUS[status]}`;
  if (status) return `${label} refused the request (HTTP ${status}).`;

  // No status: the SDK's own text is all there is, but it is at least redacted.
  return raw.slice(0, 300) || `${label} failed without giving a reason.`;
}
