'use client';

import { useCallback, useEffect, useState } from 'react';
import Pairing from './Pairing';
import Kiosk from './Kiosk';
import './booth.css';

const TOKEN_KEY = 'ello_booth_token';

/**
 * A booth pairs once and then runs unattended - event staff never sign in.
 * The device token lives in localStorage on the venue laptop; revoking the
 * booth from the dashboard invalidates it server-side on the next request.
 */
export default function Booth() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
    setReady(true);
  }, []);

  const onPaired = useCallback((next: string) => {
    localStorage.setItem(TOKEN_KEY, next);
    setToken(next);
  }, []);

  const onUnpair = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  // Avoid flashing the pairing screen before localStorage has been read.
  if (!ready) return <div className="pairing" />;
  if (!token) return <Pairing onPaired={onPaired} />;

  return <Kiosk key={token} token={token} onUnpair={onUnpair} />;
}
