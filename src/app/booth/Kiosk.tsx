'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { enqueue, flush, count as queueCount } from './queue';
import { blendRealFace, preloadFaceModel } from './faceblend';

type Scene = { id: string; name: string; subtitle: string; aspectRatio: string; own: boolean; ready: boolean };
type Config = {
  tenant: { name: string };
  branding: { accent: string; idleTitle: string; idleSubtitle: string };
  settings: {
    autoCaptureSeconds: number;
    countdownSeconds: number;
    resultDisplaySeconds: number;
    consentText: string;
    realFace: boolean;
  };
  credits: number | null;
  scenes: Scene[];
};
type Result = { imageUrl: string; shareUrl: string; qr: string; ms: number; shareToken: string };
type Stage = 'boot' | 'idle' | 'detect' | 'count' | 'gen' | 'result' | 'error' | 'queued' | 'cooldown';

const GEN_MESSAGES = [
  ['आपकी तस्वीर तैयार हो रही है…', 'Creating your photo'],
  ['चेहरा और वस्त्र मिलाए जा रहे हैं…', 'Matching your face and clothes'],
  ['दृश्य सजाया जा रहा है…', 'Composing the scene'],
  ['बस कुछ ही पल…', 'Almost there'],
];

/* Presence detection tuning - see the loop below. */
const DW = 80;
const DH = 60;
const PRESENT = 0.14; // share of pixels differing from the learned background
const EMPTY = 0.06;
const STILL = 0.035; // share differing from the previous frame

export default function Kiosk({ token, onUnpair }: { token: string; onUnpair: () => void }) {
  /**
   * Sends the blended photo back so the QR link serves it too. Deliberately
   * not awaited by the visitor-facing flow - the screen already shows the
   * finished picture from a local blob.
   */
  const uploadFinal = useCallback(
    async (shareToken: string, blob: Blob, ms: number) => {
      try {
        const buffer = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

        await fetch('/api/booth/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ shareToken, imageBase64: btoa(binary), ms }),
        });
      } catch (err) {
        // The visitor still has their photo on screen; the QR just serves the
        // model's version until the next successful upload.
        console.warn('[real-face] could not upload blended photo:', err);
      }
    },
    [token],
  );

  const videoRef = useRef<HTMLVideoElement>(null);

  const [config, setConfig] = useState<Config | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [stage, setStage] = useState<Stage>('boot');
  const [countdown, setCountdown] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<{ title: string; detail?: string }>({ title: '' });
  const [elapsed, setElapsed] = useState(0);
  const [msgIndex, setMsgIndex] = useState(0);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [flash, setFlash] = useState(false);

  // The animation loop and timers read these instead of closing over state,
  // which would otherwise go stale between renders.
  const stageRef = useRef<Stage>('boot');
  const sceneRef = useRef<Scene | null>(null);
  const configRef = useRef<Config | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const setStageBoth = useCallback((next: Stage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  /* ---------------- background model ---------------- */
  const bg = useRef<Float32Array | null>(null);
  const prev = useRef<Float32Array | null>(null);
  const holdMs = useRef(0);
  const resetBackground = useCallback(() => {
    bg.current = null;
    prev.current = null;
    holdMs.current = 0;
    setProgress(0);
  }, []);

  const goIdle = useCallback(() => {
    clearTimers();
    holdMs.current = 0;
    setProgress(0);
    setStageBoth('idle');
  }, [clearTimers, setStageBoth]);

  /* ---------------- capture ---------------- */
  const grabFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video?.videoWidth) return null;
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    // drawImage takes the raw frame; the CSS mirror is presentation only.
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] ?? null;
  }, []);

  const cooldown = useCallback(() => {
    clearTimers();
    setStageBoth('cooldown');
    // Safety net if detection never sees the room clear (bright screen, crowd).
    later(() => {
      if (stageRef.current === 'cooldown') {
        resetBackground();
        goIdle();
      }
    }, 12_000);
  }, [clearTimers, goIdle, later, resetBackground, setStageBoth]);

  const capture = useCallback(async () => {
    clearTimers();
    const current = sceneRef.current;
    const image = grabFrame();
    if (!current || !image) {
      setError({ title: 'Camera frame not ready' });
      setStageBoth('error');
      later(cooldown, 6000);
      return;
    }

    setFlash(true);
    later(() => setFlash(false), 500);
    setStageBoth('gen');
    setElapsed(0);
    setMsgIndex(0);

    const startedAt = performance.now();
    const tick = setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 100);
    const cycle = setInterval(() => setMsgIndex((i) => (i + 1) % GEN_MESSAGES.length), 3200);

    const stash = async () => {
      await enqueue({
        sceneId: current.id,
        sceneName: current.name,
        imageBase64: image,
        mimeType: 'image/jpeg',
        at: Date.now(),
      });
      setQueued(await queueCount());
      setStageBoth('queued');
      later(cooldown, 9000);
    };

    try {
      if (!navigator.onLine) {
        await stash();
        return;
      }

      const res = await fetch('/api/booth/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sceneId: current.id, imageBase64: image, mimeType: 'image/jpeg' }),
      });
      const data = await res.json();

      if (res.status === 401) {
        onUnpair();
        return;
      }
      if (!res.ok) {
        setError({ title: data.error || 'The photo could not be created', detail: data.detail });
        setStageBoth('error');
        later(cooldown, 10_000);
        return;
      }

      const payload = data as Result;

      /* -------- Put the visitor's real face in --------
         The model draws a face rather than copying one, so this replaces that
         region with the actual pixels from the capture. It runs here in the
         booth, works offline, and never blocks the result: any failure just
         shows the model's own photo. */
      if (configRef.current?.settings.realFace) {
        try {
          const generated = await (await fetch(payload.imageUrl)).blob();
          const captureBlob = await (await fetch(`data:image/jpeg;base64,${image}`)).blob();
          const blended = await blendRealFace(generated, captureBlob);

          if (blended.ok) {
            payload.imageUrl = URL.createObjectURL(blended.blob);
            void uploadFinal(payload.shareToken, blended.blob, blended.ms);
          } else {
            console.warn('[real-face]', blended.reason);
          }
        } catch (err) {
          console.warn('[real-face] skipped:', err);
        }
      }

      setResult(payload);
      setStageBoth('result');
      later(cooldown, (configRef.current?.settings.resultDisplaySeconds ?? 25) * 1000);
    } catch {
      // Reaching here means the request never completed - keep the capture.
      await stash();
    } finally {
      clearInterval(tick);
      clearInterval(cycle);
    }
  }, [clearTimers, cooldown, grabFrame, later, onUnpair, setStageBoth, token, uploadFinal]);

  const startCountdown = useCallback(() => {
    if (stageRef.current === 'count') return;
    clearTimers();
    setStageBoth('count');
    let n = configRef.current?.settings.countdownSeconds ?? 3;
    const tick = () => {
      setCountdown(n);
      if (n-- <= 1) later(capture, 1000);
      else later(tick, 1000);
    };
    tick();
  }, [capture, clearTimers, later, setStageBoth]);

  /* ---------------- load config + camera ---------------- */
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        const res = await fetch('/api/booth/config', { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) return onUnpair();
        const data: Config = await res.json();
        if (cancelled) return;

        configRef.current = data;
        setConfig(data);
        const first = data.scenes.find((s) => s.ready) ?? data.scenes[0] ?? null;
        sceneRef.current = first;
        setScene(first);
      } catch {
        if (!cancelled) {
          setError({ title: 'Could not reach the server', detail: 'Check the venue connection and reload.' });
          setStageBoth('error');
        }
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        goIdle();
        // Load the face model now, during the idle screen, so the first
        // visitor does not wait for a 4 MB download.
        preloadFaceModel();
      } catch (err) {
        if (!cancelled) {
          setError({
            title: 'Camera could not be opened',
            detail: err instanceof Error ? err.message : 'Allow camera access and reload the page.',
          });
          setStageBoth('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [goIdle, onUnpair, setStageBoth, token]);

  /* ---------------- presence detection ----------------
     A downscaled greyscale frame is compared against a slowly learned
     background. Someone who is clearly in frame AND has stopped moving is a
     visitor who has walked up and is now standing there - which is exactly
     the moment to start the countdown. No model download, works offline. */
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = DW;
    canvas.height = DH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let raf = 0;
    let lastTick = 0;

    const differing = (a: Float32Array | null, b: Float32Array | null, threshold: number) => {
      if (!a || !b) return 0;
      let n = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > threshold) n++;
      return n / a.length;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video?.videoWidth || now - lastTick < 120) return;
      const dt = lastTick ? now - lastTick : 120;
      lastTick = now;

      ctx.drawImage(video, 0, 0, DW, DH);
      const px = ctx.getImageData(0, 0, DW, DH).data;
      const gray = new Float32Array(DW * DH);
      for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        gray[p] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      }

      const vsBg = differing(gray, bg.current, 26);
      const vsPrev = differing(gray, prev.current, 22);
      prev.current = gray;

      if (!bg.current) {
        bg.current = Float32Array.from(gray);
        return;
      }

      const current = stageRef.current;

      if (current === 'cooldown') {
        // Wait for the previous visitor to walk away before arming again.
        if (vsBg < EMPTY) {
          resetBackground();
          goIdle();
        }
        return;
      }
      if (current !== 'idle' && current !== 'detect') return;

      const present = vsBg > PRESENT;
      if (!present) {
        for (let i = 0; i < bg.current.length; i++) bg.current[i] += (gray[i] - bg.current[i]) * 0.05;
        holdMs.current = 0;
        setProgress(0);
        if (current === 'detect') goIdle();
        return;
      }

      if (current === 'idle') setStageBoth('detect');

      const settled = vsPrev < STILL;
      holdMs.current = settled ? holdMs.current + dt : Math.max(0, holdMs.current - dt * 0.6);

      const need = (configRef.current?.settings.autoCaptureSeconds ?? 2) * 1000;
      setProgress(Math.min(100, (holdMs.current / need) * 100));
      if (holdMs.current >= need) startCountdown();
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [goIdle, resetBackground, setStageBoth, startCountdown]);

  /* ---------------- network + queue ---------------- */
  useEffect(() => {
    const sync = async () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        const { left } = await flush(token);
        setQueued(left);
      } else {
        setQueued(await queueCount());
      }
    };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const poll = setInterval(sync, 30_000);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      clearInterval(poll);
    };
  }, [token]);

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (stageRef.current === 'idle' || stageRef.current === 'detect') startCountdown();
      }
      if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      }
      if (e.key === 'Escape') {
        resetBackground();
        goIdle();
      }
      const n = Number.parseInt(e.key, 10);
      const list = configRef.current?.scenes;
      if (n >= 1 && n <= 9 && list?.[n - 1]) {
        sceneRef.current = list[n - 1];
        setScene(list[n - 1]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goIdle, resetBackground, startCountdown]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const pick = (s: Scene) => {
    sceneRef.current = s;
    setScene(s);
  };

  const live = stage === 'idle' || stage === 'detect' || stage === 'count';
  const busy = stage === 'gen' || stage === 'result' || stage === 'error' || stage === 'queued';

  return (
    <div
      className={`booth${live ? ' live' : ''}${busy ? ' busy' : ''}`}
      style={{ '--accent': config?.branding.accent ?? '#e0a63c' } as React.CSSProperties}
    >
      <video ref={videoRef} autoPlay playsInline muted />
      <div className="vignette" />

      <header className="bar">
        <div className="chips">
          {config?.scenes.map((s, i) => (
            <button
              key={s.id}
              className={`chip${s.id === scene?.id ? ' on' : ''}${s.ready ? '' : ' missing'}`}
              onClick={() => pick(s)}
              title={s.ready ? s.subtitle : 'No reference image uploaded for this scene'}
            >
              {i + 1}. {s.name}
            </button>
          ))}
        </div>
        <div className="meta">
          <span>
            <i className={`dot ${online ? 'on' : 'off'}`} />
            {online ? 'online' : 'offline'}
          </span>
          {queued > 0 ? <span>{queued} waiting to send</span> : null}
          {config?.credits != null ? <span>{config.credits} credits</span> : null}
          <span>SPACE capture · F fullscreen</span>
        </div>
      </header>

      {stage === 'boot' ? (
        <section className="stage">
          <div className="spinner" />
          <p className="sub">Starting booth…</p>
        </section>
      ) : null}

      {stage === 'idle' || stage === 'cooldown' ? (
        <section className="stage">
          <div className="ring" />
          <h1>{scene?.subtitle || config?.branding.idleTitle}</h1>
          <p className="sub">{config?.branding.idleSubtitle}</p>
        </section>
      ) : null}

      {stage === 'detect' ? (
        <section className="stage">
          <h1>बस, ऐसे ही रुकिए…</h1>
          <div className="meter">
            <i style={{ width: `${progress}%` }} />
          </div>
          <p className="sub">Hold still</p>
        </section>
      ) : null}

      {stage === 'count' ? (
        <section className="stage">
          <div className="count" key={countdown}>
            {countdown}
          </div>
        </section>
      ) : null}

      {stage === 'gen' ? (
        <section className="stage">
          <div className="spinner" />
          <h1>{GEN_MESSAGES[msgIndex][0]}</h1>
          <p className="sub">{GEN_MESSAGES[msgIndex][1]}</p>
          <div className="timer">{elapsed.toFixed(1)}s</div>
        </section>
      ) : null}

      {stage === 'result' && result ? (
        <section className="stage result">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="shot" src={result.imageUrl} alt="Your photo" />
          <aside className="side">
            <h2>{scene?.name}</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="qr" src={result.qr} alt="Scan to download" />
            <p>
              फ़ोन से स्कैन कीजिए
              <br />
              <small>Scan to download</small>
            </p>
            <button
              className="action"
              onClick={() => {
                resetBackground();
                goIdle();
              }}
            >
              फिर से / Again
            </button>
          </aside>
        </section>
      ) : null}

      {stage === 'queued' ? (
        <section className="stage">
          <h1>तस्वीर सुरक्षित कर ली गई है</h1>
          <p className="err">
            Internet abhi nahi hai, isliye photo booth mein safely save kar li gayi hai. Connection wapas aate hi
            ye apne aap ban jayegi aur dashboard gallery mein aa jayegi.
          </p>
          <p className="sub">{queued} photo(s) waiting to send</p>
        </section>
      ) : null}

      {stage === 'error' ? (
        <section className="stage">
          <h1>अरे! कुछ गड़बड़ हो गई</h1>
          <p className="err">
            {error.title}
            {error.detail ? (
              <>
                <br />
                <span style={{ opacity: 0.65, fontSize: 14 }}>{error.detail}</span>
              </>
            ) : null}
          </p>
          <button
            className="action"
            onClick={() => {
              resetBackground();
              goIdle();
            }}
          >
            फिर से कोशिश करें
          </button>
        </section>
      ) : null}

      {config?.settings.consentText && (stage === 'idle' || stage === 'detect' || stage === 'cooldown') ? (
        <p className="consent">{config.settings.consentText}</p>
      ) : null}

      <div className={`flash${flash ? ' fire' : ''}`} />
    </div>
  );
}
