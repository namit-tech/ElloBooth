'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { draftScene, saveScene, type ActionState, type DraftState } from './actions';

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export default function NewScene({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(false);
  const [drafted, draftAction] = useActionState<DraftState, FormData>(draftScene, {});
  const [saved, saveAction] = useActionState<ActionState, FormData>(saveScene, {});

  if (!open) {
    return (
      <div style={{ margin: '16px 0' }}>
        <button className="btn" onClick={() => setOpen(true)}>
          + Add a scene
        </button>
      </div>
    );
  }

  const draft = drafted.draft;
  const upload = drafted.upload;

  return (
    <div className="card" style={{ marginTop: 16 }} key={tenantId}>
      <div className="card-head">
        <h2>Add a scene</h2>
        <p>
          Upload a picture of whoever your visitors should appear with — a deity, a celebrity, a mascot. The AI
          reads the image and writes the wording; you review it before it goes live.
        </p>
      </div>

      {/* ---- step 1: image in, draft out ---- */}
      <form action={draftAction}>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="image">Reference image</label>
            <input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" required />
            <div className="help">
              Sharp, front-facing, clean background, no watermark. The model copies what it sees, so this is the
              single biggest factor in how good the photos come out.
            </div>
          </div>
          <div className="field">
            <label htmlFor="hint">Anything we should know? (optional)</label>
            <input id="hint" name="hint" placeholder="e.g. Khatu Shyam ji — temple darbar setting" />
            <div className="help">Helps when the subject is hard to recognise from the picture alone.</div>
          </div>
        </div>
        <Submit label={draft ? 'Draft again' : 'Read image and draft'} busy="Reading the image…" />
      </form>

      {drafted.error ? <div className="notice err" style={{ marginTop: 14 }}>{drafted.error}</div> : null}
      {drafted.ok ? <div className="notice ok" style={{ marginTop: 14 }}>{drafted.ok}</div> : null}

      {/* ---- step 2: review and save ---- */}
      {upload ? (
        <form action={saveAction} style={{ marginTop: 22 }} key={upload.key}>
          <input type="hidden" name="referenceKey" value={upload.key} />

          <div className="draft-split">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={upload.preview} alt="Reference" />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="name">Name shown on the booth</label>
                  <input id="name" name="name" defaultValue={draft?.name ?? ''} required />
                </div>
                <div className="field">
                  <label htmlFor="aspectRatio">Shape</label>
                  <select id="aspectRatio" name="aspectRatio" defaultValue={draft?.aspectRatio ?? '3:4'}>
                    <option value="3:4">Portrait (3:4)</option>
                    <option value="4:3">Landscape (4:3)</option>
                    <option value="1:1">Square (1:1)</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="subtitle">Subtitle</label>
                <input id="subtitle" name="subtitle" defaultValue={draft?.subtitle ?? ''} />
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="scene">Scene — the setting they appear in</label>
            <textarea id="scene" name="scene" defaultValue={draft?.scene ?? ''} required rows={4} />
          </div>

          <div className="field">
            <label htmlFor="pose">Pose — where the visitor stands and what they do</label>
            <textarea id="pose" name="pose" defaultValue={draft?.pose ?? ''} required rows={4} />
            <div className="help">
              Keep the instruction that the visitor faces the camera. The booth swaps in their real face
              afterwards, and that only works on a near-frontal head.
            </div>
          </div>

          <div className="field">
            <label htmlFor="mood">Mood — lighting and style</label>
            <textarea id="mood" name="mood" defaultValue={draft?.mood ?? ''} rows={2} />
          </div>

          {saved.error ? <div className="notice err">{saved.error}</div> : null}
          {saved.ok ? <div className="notice ok">{saved.ok}</div> : null}

          <div className="row" style={{ marginTop: 14 }}>
            <Submit label="Save scene" busy="Saving…" />
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
