'use client';

import { useState } from 'react';

export default function Pairing({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/booth/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Pairing failed');
      onPaired(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed');
      setBusy(false);
    }
  }

  return (
    <div className="pairing">
      <div className="box">
        <h1>Pair this booth</h1>
        <p className="lede">
          In your Elloindia dashboard open <strong>Booths</strong>, add a booth, and type the 6-character code
          it shows you.
        </p>

        <form onSubmit={submit}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            maxLength={6}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label="Pairing code"
          />
          <button type="submit" disabled={busy || code.trim().length !== 6}>
            {busy ? 'Pairing…' : 'Pair booth'}
          </button>
        </form>

        {error ? <div className="msg">{error}</div> : null}
      </div>
    </div>
  );
}
