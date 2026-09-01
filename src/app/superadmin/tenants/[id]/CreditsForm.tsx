'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { addCredits, type ActionState } from '../../actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn sm" disabled={pending}>
      {pending ? 'Applying…' : 'Apply'}
    </button>
  );
}

export default function CreditsForm({ tenantId, balance }: { tenantId: string; balance: number }) {
  const [state, formAction] = useActionState<ActionState, FormData>(addCredits, {});

  return (
    <form action={formAction}>
      <input type="hidden" name="tenantId" value={tenantId} />

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0, flex: '1 1 160px' }}>
          <label htmlFor="amount">Adjust balance ({balance.toLocaleString('en-IN')} now)</label>
          <input id="amount" name="amount" type="number" placeholder="500 or -50" required />
        </div>
        <Submit />
      </div>

      <div className="help" style={{ marginTop: 8 }}>
        Use a negative number to deduct. Deductions cannot take the balance below zero.
      </div>

      {state.error ? (
        <div className="notice err" style={{ marginTop: 12 }}>
          {state.error}
        </div>
      ) : null}
      {state.ok ? (
        <div className="notice ok" style={{ marginTop: 12 }}>
          {state.ok}
        </div>
      ) : null}
    </form>
  );
}
