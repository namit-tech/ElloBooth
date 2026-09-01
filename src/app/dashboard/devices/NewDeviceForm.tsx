'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createDevice, type ActionState } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Creating…' : 'Add booth'}
    </button>
  );
}

export default function NewDeviceForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(createDevice, {});

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>Add a booth</h2>
        <p>Open the booth page on the venue laptop and enter the code it gives you.</p>
      </div>

      <form action={formAction}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, flex: '1 1 260px' }}>
            <label htmlFor="name">Booth name</label>
            <input id="name" name="name" required placeholder="Main hall — left entrance" />
          </div>
          <Submit />
        </div>
      </form>

      {state.error ? <div className="notice err" style={{ marginTop: 14 }}>{state.error}</div> : null}

      {state.code ? (
        <div className="notice ok" style={{ marginTop: 14 }}>
          {state.ok}
          <div
            className="mono"
            style={{ fontSize: 34, letterSpacing: 7, marginTop: 10, color: 'var(--gold)', fontWeight: 700 }}
          >
            {state.code}
          </div>
        </div>
      ) : null}
    </div>
  );
}
