'use client';

import { useEffect, useState } from 'react';

/**
 * Server Action ids are baked in at build time, so any tab still running an
 * older bundle gets `UnrecognizedActionError` after a deploy. That is not a
 * real fault - the page just needs the new bundle.
 *
 * This matters most for the booth, which stays open unattended for hours: a
 * mid-event deploy would otherwise leave it showing an error screen until
 * someone noticed. Reload once, automatically, and only for that case.
 */
const isStaleBundle = (error: Error) =>
  /Server Action|UnrecognizedActionError|Failed to find Server Action|ChunkLoadError|Loading chunk/i.test(
    `${error.name} ${error.message}`,
  );

const RELOAD_FLAG = 'ello_reloaded_for_stale_bundle';

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!isStaleBundle(error)) return;

    // Reload at most once, so a genuinely broken build cannot loop forever.
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    setReloading(true);
    location.reload();
  }, [error]);

  useEffect(() => {
    if (!isStaleBundle(error)) sessionStorage.removeItem(RELOAD_FLAG);
  }, [error]);

  return (
    <div className="login-wrap">
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <h1>{reloading ? 'Updating…' : 'Something went wrong'}</h1>
        <p style={{ color: 'var(--muted)', margin: '10px 0 22px', lineHeight: 1.6 }}>
          {reloading
            ? 'A newer version is available. Reloading now.'
            : 'The page could not be loaded. Try again, and if it keeps happening contact Elloindia support.'}
        </p>

        {!reloading ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={reset}>
              Try again
            </button>
            <button className="btn ghost" onClick={() => location.reload()}>
              Reload page
            </button>
          </div>
        ) : null}

        {error.digest ? (
          <p className="mono" style={{ color: 'var(--faint)', fontSize: 12, marginTop: 20 }}>
            ref {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
