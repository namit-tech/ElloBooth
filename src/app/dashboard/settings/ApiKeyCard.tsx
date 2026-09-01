'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveApiKey, testApiKey, removeApiKey, type ActionState } from './actions';
import { PROVIDERS, PROVIDER_INFO, type Provider } from '@/lib/ai/catalogue';

type KeyInfo = { hint: string; verifiedAt: string | null } | null;

function Submit({ label, busy, className = 'btn' }: { label: string; busy: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

function Result({ state }: { state: ActionState }) {
  if (state.error) return <div className="notice err" style={{ marginTop: 12 }}>{state.error}</div>;
  if (state.ok) return <div className="notice ok" style={{ marginTop: 12 }}>{state.ok}</div>;
  return null;
}

export default function ApiKeyCard({
  keyMode,
  provider,
  keys,
  credits,
}: {
  keyMode: 'byok' | 'platform';
  provider: Provider;
  keys: Record<Provider, KeyInfo>;
  credits: number;
}) {
  const [tab, setTab] = useState<Provider>(provider);
  const [saveState, saveAction] = useActionState<ActionState, FormData>(saveApiKey, {});
  const [testState, testAction] = useActionState<ActionState, FormData>(testApiKey, {});
  const [removeState, removeAction] = useActionState<ActionState, FormData>(removeApiKey, {});

  const info = PROVIDER_INFO[tab];
  const stored = keys[tab];

  return (
    <div className="card">
      <div className="card-head">
        <h2>API keys</h2>
        <p>
          Add a key for whichever provider you generate with and you are billed by them directly. With no key,
          photos run on Elloindia credits — {credits.toLocaleString('en-IN')} left.
        </p>
      </div>

      <div className="tabs">
        {PROVIDERS.map((p) => (
          <button key={p} className={`tab${p === tab ? ' on' : ''}`} onClick={() => setTab(p)}>
            {PROVIDER_INFO[p].label}
            {keys[p] ? <span className="dot-ok" /> : null}
          </button>
        ))}
      </div>

      {stored ? (
        <>
          <div className="notice ok">
            Key <span className="mono">{stored.hint}</span> stored
            {stored.verifiedAt ? ` · last verified ${stored.verifiedAt}` : null}
            {keyMode === 'byok' && tab === provider ? ' · in use for your photos' : null}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <form action={testAction}>
              <input type="hidden" name="provider" value={tab} />
              <Submit label="Test key" busy="Testing…" className="btn ghost sm" />
            </form>
            <form action={removeAction}>
              <input type="hidden" name="provider" value={tab} />
              <Submit label="Remove key" busy="Removing…" className="btn danger sm" />
            </form>
          </div>

          <Result state={testState} />
          <Result state={removeState} />
        </>
      ) : (
        <form action={saveAction}>
          <input type="hidden" name="provider" value={tab} />
          <div className="field">
            <label htmlFor={`key-${tab}`}>{info.keyLabel}</label>
            <input id={`key-${tab}`} name="apiKey" type="password" autoComplete="off" required minLength={20} />
            <div className="help">
              Get one at{' '}
              <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>
                {new URL(info.keyUrl).host}
              </a>
              . We check it against your chosen model before saving, encrypt it at rest, and never show it again —
              only a masked hint.
            </div>
          </div>
          <Submit label="Verify and save" busy="Verifying…" />
        </form>
      )}

      <Result state={saveState} />
    </div>
  );
}
