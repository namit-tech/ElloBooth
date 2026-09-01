'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { createTenant, type ActionState } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Creating…' : 'Create tenant'}
    </button>
  );
}

export default function NewTenantForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(createTenant, {});
  const [keyMode, setKeyMode] = useState<'platform' | 'byok'>('platform');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <button className="btn" onClick={() => setOpen(true)}>
          + New tenant
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>New tenant</h2>
        <p>Creates the account and its first admin user.</p>
      </div>

      <form action={formAction}>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="name">Company name</label>
            <input id="name" name="name" required placeholder="Sharma Events Pvt Ltd" />
          </div>
          <div className="field">
            <label htmlFor="slug">Slug</label>
            <input id="slug" name="slug" required placeholder="sharma-events" />
            <div className="help">Used in URLs. Lowercase letters, numbers and hyphens.</div>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="adminName">Admin name</label>
            <input id="adminName" name="adminName" required placeholder="Rajesh Sharma" />
          </div>
          <div className="field">
            <label htmlFor="adminEmail">Admin email</label>
            <input id="adminEmail" name="adminEmail" type="email" required placeholder="rajesh@sharmaevents.com" />
          </div>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="adminPassword">Temporary password</label>
            <input id="adminPassword" name="adminPassword" required minLength={8} placeholder="At least 8 characters" />
            <div className="help">Share it with them and ask them to change it after first sign-in.</div>
          </div>
          <div className="field">
            <label htmlFor="keyMode">Key mode</label>
            <select
              id="keyMode"
              name="keyMode"
              value={keyMode}
              onChange={(e) => setKeyMode(e.target.value as 'platform' | 'byok')}
            >
              <option value="platform">Platform key — they buy credits from us</option>
              <option value="byok">Own key — they pay Google directly</option>
            </select>
          </div>
        </div>

        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="credits">Starting credits</label>
          <input
            id="credits"
            name="credits"
            type="number"
            min={0}
            defaultValue={100}
            disabled={keyMode === 'byok'}
          />
          <div className="help">
            {keyMode === 'byok'
              ? 'Not used — this tenant spends their own Google quota.'
              : 'One credit is one generated photo.'}
          </div>
        </div>

        {state.error ? <div className="notice err">{state.error}</div> : null}
        {state.ok ? <div className="notice ok">{state.ok}</div> : null}

        <div className="row" style={{ marginTop: 16 }}>
          <Submit />
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
