'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveSettings, type ActionState } from './actions';
import {
  PROVIDERS,
  PROVIDER_INFO,
  modelsFor,
  findModel,
  SPEED_LABEL,
  inRupees,
  type Provider,
} from '@/lib/ai/catalogue';

type Settings = {
  provider: Provider;
  model: string;
  imageSize: string;
  autoCaptureSeconds: number;
  countdownSeconds: number;
  resultDisplaySeconds: number;
  retentionDays: number;
  identityLock: boolean;
  realFace: boolean;
  consentText: string;
  idleTitle: string;
  idleSubtitle: string;
  accent: string;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : 'Save settings'}
    </button>
  );
}

export default function SettingsForm({
  settings,
  keyMode,
}: {
  settings: Settings;
  keyMode: 'byok' | 'platform';
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveSettings, {});
  const [provider, setProvider] = useState<Provider>(settings.provider);
  const [model, setModel] = useState(settings.model);

  const available = modelsFor(provider);
  const chosen = findModel(model);
  // Switching provider invalidates the old model, so fall back to the cheapest.
  const activeModel = chosen?.provider === provider ? chosen : available[0];
  const [identityLock, setIdentityLock] = useState(settings.identityLock);
  const [realFace, setRealFace] = useState(settings.realFace);

  const sizes = activeModel.sizes;

  return (
    <form action={formAction}>
      <div className="card">
        <div className="card-head">
          <h2>AI provider</h2>
          <p>Which service generates the photographs. You need a key for whichever you pick, or platform credits.</p>
        </div>

        <input type="hidden" name="provider" value={provider} />
        <div className="provider-grid">
          {PROVIDERS.map((p) => {
            const info = PROVIDER_INFO[p];
            return (
              <button
                type="button"
                key={p}
                className={`pick${p === provider ? ' on' : ''}`}
                onClick={() => {
                  setProvider(p);
                  setModel(modelsFor(p)[0].id);
                }}
              >
                <strong>{info.label}</strong>
                <small>{info.summary}</small>
                <a href={info.pricingUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  Official pricing
                </a>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Model</h2>
          <p>
            Prices are per photo and indicative — {PROVIDER_INFO[provider].label} sets the real figure. Times are
            rough, measured on a single booth.
          </p>
        </div>

        <input type="hidden" name="model" value={activeModel.id} />
        <div className="model-grid">
          {available.map((m) => (
            <button
              type="button"
              key={m.id}
              className={`pick${m.id === activeModel.id ? ' on' : ''}`}
              onClick={() => setModel(m.id)}
            >
              <div className="pick-head">
                <strong>{m.label}</strong>
                <span className="badge gold">
                  ~₹{inRupees(m.approxUsd)} · {SPEED_LABEL[m.speed]}
                </span>
              </div>
              <small>{m.useCase}</small>
              <span className="pick-sizes">Sizes: {m.sizes.join(', ')}</span>
            </button>
          ))}
        </div>

        <div className="field" style={{ maxWidth: 220, marginTop: 16 }}>
          <label htmlFor="imageSize">Output size</label>
          <select id="imageSize" name="imageSize" defaultValue={settings.imageSize} key={activeModel.id}>
            {sizes.map((sz) => (
              <option key={sz} value={sz}>
                {sz}
              </option>
            ))}
          </select>
          <div className="help">
            {sizes.length === 1
              ? `${activeModel.label} only renders at ${sizes[0]}.`
              : 'Larger costs more and takes longer. A booth screen shows no more than 1K.'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Face accuracy</h2>
          <p>
            The AI draws the visitor&apos;s face rather than copying it, so on its own it gets close but never
            exact. These two settings address that in different ways — the first is usually all you need.
          </p>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            name="realFace"
            checked={realFace}
            onChange={(e) => setRealFace(e.target.checked)}
          />
          <span>
            <strong>Use the visitor&apos;s real face (recommended)</strong>
            <small>
              {realFace
                ? 'On — the visitor’s actual face from the capture is transplanted into the finished photo. Adds about 2 seconds and costs nothing. Needs the face service to be running.'
                : 'Off — the photo keeps whatever face the AI drew, which never looks quite like the visitor.'}
            </small>
          </span>
        </label>

        <label className="toggle" style={{ marginTop: 16 }}>
          <input
            type="checkbox"
            name="identityLock"
            checked={identityLock}
            onChange={(e) => setIdentityLock(e.target.checked)}
          />
          <span>
            <strong>Also run a second AI pass on the face</strong>
            <small>
              {identityLock
                ? keyMode === 'platform'
                  ? 'On — 2 credits per photo, and noticeably slower (on the Pro model this can add over a minute).'
                  : 'On — two API calls per photo, and noticeably slower (on the Pro model this can add over a minute).'
                : 'Off — recommended. With the real face blended in, this pass mostly adds cost and waiting.'}
            </small>
          </span>
        </label>

        <div className="notice info" style={{ marginTop: 16 }}>
          Neither setting can break a photo. If the face cannot be found, or the second pass is refused, the
          visitor still gets the picture and any unused credit is returned. Both versions are kept, so the
          Gallery&apos;s before/after toggle shows exactly what each one bought you.
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Booth behaviour</h2>
        </div>

        <div className="grid grid-4">
          <div className="field">
            <label htmlFor="autoCaptureSeconds">
              Hold still (sec) <small style={{ opacity: 0.6 }}>(0 = Clicker/Tap only)</small>
            </label>
            <input
              id="autoCaptureSeconds"
              name="autoCaptureSeconds"
              type="number"
              step="0.5"
              min={0}
              max={10}
              defaultValue={settings.autoCaptureSeconds}
            />
          </div>
          <div className="field">
            <label htmlFor="countdownSeconds">Countdown (sec)</label>
            <input
              id="countdownSeconds"
              name="countdownSeconds"
              type="number"
              min={1}
              max={10}
              defaultValue={settings.countdownSeconds}
            />
          </div>
          <div className="field">
            <label htmlFor="resultDisplaySeconds">
              Show result (sec) <small style={{ opacity: 0.6 }}>(0 = Pause until Next is clicked)</small>
            </label>
            <input
              id="resultDisplaySeconds"
              name="resultDisplaySeconds"
              type="number"
              min={0}
              max={180}
              defaultValue={settings.resultDisplaySeconds}
            />
          </div>
          <div className="field">
            <label htmlFor="accent">Accent colour</label>
            <input id="accent" name="accent" defaultValue={settings.accent} placeholder="#e0a63c" />
          </div>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="idleTitle">Idle screen title</label>
            <input
              id="idleTitle"
              name="idleTitle"
              defaultValue={settings.idleTitle}
              placeholder="आइए, कैमरे के सामने खड़े हों"
            />
          </div>
          <div className="field">
            <label htmlFor="idleSubtitle">Idle screen subtitle</label>
            <input
              id="idleSubtitle"
              name="idleSubtitle"
              defaultValue={settings.idleSubtitle}
              placeholder="Step in front of the camera"
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Privacy</h2>
          <p>
            Visitor photos are personal data under India&apos;s DPDP Act. Tell people what happens to their photo,
            and keep it only as long as you need it.
          </p>
        </div>

        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="retentionDays">Delete photos after (days)</label>
          <input
            id="retentionDays"
            name="retentionDays"
            type="number"
            min={0}
            max={365}
            defaultValue={settings.retentionDays}
          />
          <div className="help">0 disables auto-delete — only choose this if you have a reason to keep them.</div>
        </div>

        <div className="field">
          <label htmlFor="consentText">Consent notice shown on the booth</label>
          <textarea id="consentText" name="consentText" defaultValue={settings.consentText} maxLength={400} />
        </div>
      </div>

      {state.error ? <div className="notice err">{state.error}</div> : null}
      {state.ok ? <div className="notice ok">{state.ok}</div> : null}

      <div style={{ marginTop: 16 }}>
        <Submit />
      </div>
    </form>
  );
}
