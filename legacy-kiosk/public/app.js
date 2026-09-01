const $ = (id) => document.getElementById(id);

const STAGES = ['idle', 'detect', 'count', 'gen', 'result', 'error'];
const show = (name) => {
  STAGES.forEach((s) => $(`stage-${s}`).classList.toggle('hidden', s !== name));
  document.body.classList.toggle('live', name === 'idle' || name === 'detect' || name === 'count');
  document.body.classList.toggle('busy', name === 'gen' || name === 'result' || name === 'error');
};

const GEN_MESSAGES = [
  ['आपकी तस्वीर तैयार हो रही है…', 'Creating your photo'],
  ['चेहरा और वस्त्र मिलाए जा रहे हैं…', 'Matching your face and clothes'],
  ['दृश्य सजाया जा रहा है…', 'Composing the scene'],
  ['बस कुछ ही पल…', 'Almost there'],
];

const video = $('video');

let cfg = null;
let scene = null;
let state = 'boot';
let timers = [];

const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

/* ------------------------------------------------------------------ */
/* Presence detection                                                   */
/* Deliberately dependency-free: a downscaled greyscale frame compared   */
/* against a slowly-learned background model. Fires when someone is      */
/* clearly in frame AND has stopped moving - which is exactly "a person  */
/* walked up and is now standing there".                                 */
/* ------------------------------------------------------------------ */
const DW = 80, DH = 60;
const det = document.createElement('canvas');
det.width = DW; det.height = DH;
const detCtx = det.getContext('2d', { willReadFrequently: true });

let bg = null;         // background model
let prev = null;       // previous frame
let holdMs = 0;        // how long the subject has been settled
let lastTick = 0;

const PRESENT = 0.14;  // fraction of pixels differing from the background
const EMPTY = 0.06;
const STILL = 0.035;   // fraction differing from the previous frame

function sampleFrame() {
  detCtx.drawImage(video, 0, 0, DW, DH);
  const px = detCtx.getImageData(0, 0, DW, DH).data;
  const gray = new Float32Array(DW * DH);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    gray[p] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  }
  return gray;
}

function fractionDiffering(a, b, threshold) {
  if (!a || !b) return 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > threshold) n++;
  return n / a.length;
}

function learnBackground(gray, rate) {
  if (!bg) { bg = Float32Array.from(gray); return; }
  for (let i = 0; i < bg.length; i++) bg[i] += (gray[i] - bg[i]) * rate;
}

function resetBackground() { bg = null; prev = null; holdMs = 0; }

function detectLoop(now) {
  requestAnimationFrame(detectLoop);
  if (!video.videoWidth) return;
  if (now - lastTick < 120) return;
  const dt = lastTick ? now - lastTick : 120;
  lastTick = now;

  const gray = sampleFrame();
  const vsBg = fractionDiffering(gray, bg, 26);
  const vsPrev = fractionDiffering(gray, prev, 22);
  prev = gray;
  if (!bg) { learnBackground(gray, 1); return; }

  if (state === 'cooldown') {
    // Wait for the previous visitor to walk away before arming again.
    if (vsBg < EMPTY) { resetBackground(); goIdle(); }
    return;
  }
  if (state !== 'idle' && state !== 'detect') return;

  const present = vsBg > PRESENT;
  const settled = present && vsPrev < STILL;

  if (!present) {
    learnBackground(gray, 0.05);           // empty room - keep the model fresh
    holdMs = 0;
    if (state === 'detect') goIdle();
    return;
  }
  if (state === 'idle') { state = 'detect'; show('detect'); }

  holdMs = settled ? holdMs + dt : Math.max(0, holdMs - dt * 0.6);
  const need = cfg.autoCaptureSeconds * 1000;
  $('meter-fill').style.width = `${Math.min(100, (holdMs / need) * 100)}%`;
  if (holdMs >= need) startCountdown();
}

/* ------------------------------------------------------------------ */
/* Flow                                                                 */
/* ------------------------------------------------------------------ */
function goIdle() {
  clearTimers();
  state = 'idle';
  holdMs = 0;
  $('meter-fill').style.width = '0%';
  show('idle');
}

function startCountdown() {
  if (state === 'count') return;
  clearTimers();
  state = 'count';
  show('count');
  let n = cfg.countdownSeconds;
  const tick = () => {
    const el = $('count');
    el.textContent = n;
    el.style.animation = 'none';
    void el.offsetWidth;                   // restart the pop animation
    el.style.animation = '';
    if (n-- <= 1) later(capture, 1000);
    else later(tick, 1000);
  };
  tick();
}

function grabFrame() {
  // The <video> is mirrored in CSS only, so drawImage gives the true,
  // un-mirrored frame - important so text on clothing isn't reversed.
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}

async function capture() {
  clearTimers();
  state = 'gen';
  $('flash').classList.add('fire');
  later(() => $('flash').classList.remove('fire'), 500);

  const imageBase64 = grabFrame();
  show('gen');

  const t0 = performance.now();
  const timer = setInterval(() => {
    $('gen-timer').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  let m = 0;
  const cycle = setInterval(() => {
    m = (m + 1) % GEN_MESSAGES.length;
    $('gen-title').textContent = GEN_MESSAGES[m][0];
    $('gen-sub').textContent = GEN_MESSAGES[m][1];
  }, 3200);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId: scene.id, imageBase64, mimeType: 'image/jpeg' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.hint || data.error || 'Generation failed');
    showResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    clearInterval(timer);
    clearInterval(cycle);
  }
}

function showResult(data) {
  state = 'result';
  $('result-img').src = data.imageUrl;
  $('qr').src = data.qr;
  $('result-title').textContent = scene.name;
  show('result');
  later(cooldown, cfg.resultDisplaySeconds * 1000);
}

function showError(msg) {
  state = 'error';
  $('err-msg').textContent = msg;
  show('error');
  later(cooldown, 9000);
}

function cooldown() {
  clearTimers();
  state = 'cooldown';
  show('idle');
  // Safety net in case presence detection never sees the room clear.
  later(() => { if (state === 'cooldown') { resetBackground(); goIdle(); } }, 12000);
}

/* ------------------------------------------------------------------ */
/* Scene picker                                                         */
/* ------------------------------------------------------------------ */
function renderScenes() {
  $('scenes').innerHTML = '';
  cfg.scenes.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (s.id === scene.id ? ' on' : '') + (s.ready ? '' : ' missing');
    b.textContent = `${i + 1}. ${s.name}`;
    b.title = s.ready ? s.subtitle : `Missing file: scenes/${s.reference}`;
    b.onclick = () => selectScene(s);
    $('scenes').appendChild(b);
  });
}

function selectScene(s) {
  scene = s;
  renderScenes();
  $('idle-title').textContent = s.subtitle || 'आइए, कैमरे के सामने खड़े हों';
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */
async function boot() {
  cfg = await (await fetch('/api/config')).json();
  if (!cfg.scenes || !cfg.scenes.length) return showError('config/scenes.json mein koi scene nahi mila.');
  selectScene(cfg.scenes.find((s) => s.ready) || cfg.scenes[0]);

  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
      audio: false,
    });
    await video.play();
  } catch (err) {
    return showError(`Camera nahi khul paya: ${err.message}`);
  }

  goIdle();
  requestAnimationFrame(detectLoop);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (state === 'idle' || state === 'detect') startCountdown();
  }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
  if (e.key === 'Escape' && state !== 'idle') { resetBackground(); goIdle(); }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9 && cfg && cfg.scenes[n - 1]) selectScene(cfg.scenes[n - 1]);
});

$('again').onclick = () => { resetBackground(); goIdle(); };
$('retry').onclick = () => { resetBackground(); goIdle(); };

boot();
