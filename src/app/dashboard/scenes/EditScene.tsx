'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveScene, saveBackplate, type ActionState } from './actions';

type SceneFields = {
  id: string;
  name: string;
  subtitle: string;
  aspectRatio: string;
  scene: string;
  pose: string;
  mood: string;
  referenceKey: string;
  mode: 'generate' | 'composite';
  hasBackplate: boolean;
  anchorX: number;
  anchorBottom: number;
  personHeight: number;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn sm" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

function UploadPlate() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn ghost sm" disabled={pending}>
      {pending ? 'Uploading…' : 'Upload backplate'}
    </button>
  );
}

/**
 * The backplate is uploaded on its own, not with the rest of the form.
 * A multi-megabyte image has no business being re-posted every time someone
 * fixes a typo in the mood text.
 */
function Backplate({ sceneId, has }: { sceneId: string; has: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveBackplate, {});

  return (
    <form action={formAction} className="field">
      <label>Backplate</label>
      <p className="hint">
        The finished background: the shrine, lit and dressed, with empty floor where the visitor will stand.
        Everyone gets this exact image, which is what keeps the deity identical in every photograph.
      </p>
      {has ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={`/api/scenes/${sceneId}/reference?plate=1`}
          alt="Current backplate"
          style={{ maxWidth: 220, borderRadius: 8, display: 'block', marginBottom: 8 }}
        />
      ) : (
        <p className="hint" style={{ opacity: 0.7 }}>None uploaded yet.</p>
      )}
      <input type="hidden" name="sceneId" value={sceneId} />
      <input type="file" name="backplate" accept="image/jpeg,image/png,image/webp" />
      {state.error ? <div className="notice err">{state.error}</div> : null}
      {state.ok ? <div className="notice ok">{state.ok}</div> : null}
      <div style={{ marginTop: 8 }}>
        <UploadPlate />
      </div>
    </form>
  );
}

export default function EditScene({ scene }: { scene: SceneFields }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(scene.mode);
  const [state, formAction] = useActionState<ActionState, FormData>(saveScene, {});

  /**
   * Follow the saved value when the server reports a new one.
   *
   * `useState` seeds itself once, on mount. Saving the form revalidates the
   * page and a fresh `scene.mode` arrives in props, but the dropdown kept
   * showing whatever it had - so a mode that had genuinely been written to the
   * database looked like it had snapped back to Generate, and the natural
   * response is to save again and again.
   */
  const [lastSaved, setLastSaved] = useState(scene.mode);
  if (scene.mode !== lastSaved) {
    setLastSaved(scene.mode);
    setMode(scene.mode);
  }

  if (!open) {
    return (
      <button className="btn ghost sm" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }

  return (
    <div className="scene-edit">
      <form action={formAction}>
        <input type="hidden" name="sceneId" value={scene.id} />
        <input type="hidden" name="referenceKey" value={scene.referenceKey} />

        <div className="grid grid-2">
          <div className="field">
            <label>Name</label>
            <input name="name" defaultValue={scene.name} required />
          </div>
          <div className="field">
            <label>Shape</label>
            <select name="aspectRatio" defaultValue={scene.aspectRatio}>
              <option value="3:4">Portrait (3:4)</option>
              <option value="4:3">Landscape (4:3)</option>
              <option value="1:1">Square (1:1)</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Subtitle</label>
          <input name="subtitle" defaultValue={scene.subtitle} />
        </div>
        <div className="field">
          <label>Scene</label>
          <textarea name="scene" defaultValue={scene.scene} required rows={4} />
        </div>
        <div className="field">
          <label>Pose</label>
          <textarea name="pose" defaultValue={scene.pose} required rows={4} />
        </div>
        <div className="field">
          <label>Mood</label>
          <textarea name="mood" defaultValue={scene.mood} rows={2} />
        </div>

        <div className="field">
          <label>How the photo is made</label>
          <select name="mode" value={mode} onChange={(e) => setMode(e.target.value as SceneFields['mode'])}>
            <option value="generate">Generate — an AI model draws the whole picture</option>
            <option value="composite">Composite — stand the visitor in a fixed backplate</option>
          </select>
          <p className="hint">
            {mode === 'composite'
              ? 'The visitor is cut out of the capture and placed on the backplate below. Nothing is drawn, so the deity is identical every time and the face is the visitor’s own photograph. Takes a few seconds and costs no credits.'
              : 'The model draws the scene from the reference image, then the visitor’s real face is transplanted in. Slower, costs a credit, and the deity is drawn afresh each time.'}
          </p>
        </div>

        {mode === 'composite' ? (
          <div className="grid grid-3">
            <div className="field">
              <label>Across</label>
              <input
                name="anchorX"
                type="number"
                step="0.01"
                min="0"
                max="1"
                defaultValue={scene.anchorX}
              />
              <p className="hint">0 is the left edge, 1 the right.</p>
            </div>
            <div className="field">
              <label>Feet at</label>
              <input
                name="anchorBottom"
                type="number"
                step="0.01"
                min="0"
                max="1.5"
                defaultValue={scene.anchorBottom}
              />
              <p className="hint">1 puts them on the bottom edge.</p>
            </div>
            <div className="field">
              <label>Height</label>
              <input
                name="personHeight"
                type="number"
                step="0.01"
                min="0.1"
                max="1.5"
                defaultValue={scene.personHeight}
              />
              <p className="hint">Share of the frame they fill.</p>
            </div>
          </div>
        ) : (
          <>
            <input type="hidden" name="anchorX" value={scene.anchorX} />
            <input type="hidden" name="anchorBottom" value={scene.anchorBottom} />
            <input type="hidden" name="personHeight" value={scene.personHeight} />
          </>
        )}

        {state.error ? <div className="notice err">{state.error}</div> : null}
        {state.ok ? <div className="notice ok">{state.ok}</div> : null}

        <div className="row" style={{ marginTop: 12 }}>
          <Submit />
          <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>

      {mode === 'composite' ? <Backplate sceneId={scene.id} has={scene.hasBackplate} /> : null}
    </div>
  );
}
