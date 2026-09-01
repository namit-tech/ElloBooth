'use client';

import { useState } from 'react';

/**
 * One gallery tile. Where both passes were kept it can flip between them, which
 * is the only honest way to judge whether identity lock is worth its credit -
 * side by side at the same size, same crop, same moment.
 */
export default function Compare({
  token,
  hasRaw,
  sceneName,
  takenAt,
  seconds,
  failed,
}: {
  token: string;
  hasRaw: boolean;
  sceneName: string;
  takenAt: string;
  seconds: string;
  failed: boolean;
}) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <figure className="tile">
      <a href={`/photo/${token}`} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={showRaw ? `/api/photo/${token}?raw=1` : `/api/photo/${token}`} alt={sceneName} loading="lazy" />
      </a>

      <figcaption>
        <div className="tile-head">
          <strong>{sceneName}</strong>
          {hasRaw ? (
            <button className="flip" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? 'Corrected' : 'Before'}
            </button>
          ) : failed ? (
            <span className="badge neutral">1 pass</span>
          ) : null}
        </div>
        <small>
          {takenAt} · {seconds}s
          {showRaw ? ' · showing pass 1, before face correction' : ''}
        </small>
      </figcaption>
    </figure>
  );
}
