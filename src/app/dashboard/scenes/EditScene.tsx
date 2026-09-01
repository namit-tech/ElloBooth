'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveScene, type ActionState } from './actions';

type SceneFields = {
  id: string;
  name: string;
  subtitle: string;
  aspectRatio: string;
  scene: string;
  pose: string;
  mood: string;
  referenceKey: string;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn sm" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

export default function EditScene({ scene }: { scene: SceneFields }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(saveScene, {});

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

        {state.error ? <div className="notice err">{state.error}</div> : null}
        {state.ok ? <div className="notice ok">{state.ok}</div> : null}

        <div className="row" style={{ marginTop: 12 }}>
          <Submit />
          <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
