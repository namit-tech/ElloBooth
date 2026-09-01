# AI Photo Booth — Phase 1

Live kiosk. A visitor walks up to the camera, the booth captures them, and about
ten seconds later the screen shows a photograph of **that same person — their own
face, their own clothes** — standing alongside the chosen subject, in the right
pose for it. A QR code lets them take it home on their phone.

Everything runs in JavaScript. No GPU, no model downloads, no Python.

---

## Setup (5 minutes)

**1. API key**

```powershell
copy .env.example .env
```

Open `.env` and paste your key from https://aistudio.google.com/apikey

**2. Reference images**

Drop them into `scenes/` with the filenames listed in `scenes/README.txt`:
`khatushyam.jpg`, `mahavir.jpg`, `celebrity.jpg`, `mascot.png`.
The scene picker greys out any scene whose file is missing, so partial setups are fine.

**3. Verify the API works** — do this before the event, not at it:

```powershell
node test-api.js                      # checks key + model, no photo needed
node test-api.js khatushyam me.jpg    # full pipeline on a real photo
```

**4. Run**

```powershell
npm start
```

Open http://localhost:3000 in Chrome, allow camera access, press `F` for fullscreen.

---

## Operating the booth

| Key | Action |
|---|---|
| `1`–`9` | switch scene |
| `Space` | capture now (skip auto-detect) |
| `F` | fullscreen |
| `Esc` | abort and return to idle |

The scene bar at the top is faded out; move the mouse near it to bring it up.

Auto-capture fires when someone is clearly in frame **and** has stopped moving
for `autoCaptureSeconds`. After a result the booth waits for the visitor to walk
away before arming again, so it never re-triggers on the same person.

---

## Tuning

Everything lives in `config/` and is re-read on every request — edit it during an
event and just refresh the browser. No restart.

**`config/scenes.json`**

| Field | What it does |
|---|---|
| `model` | speed/cost/quality tradeoff — see the table below |
| `imageSize` | `1K` (flash-lite only supports 1K), `2K`, `4K` |
| `autoCaptureSeconds` | how long the visitor must hold still |
| `resultDisplaySeconds` | how long the finished photo stays up |
| `scenes[].scene` | the environment to place them in |
| `scenes[].pose` | how the visitor stands and interacts |
| `scenes[].mood` | lighting and photographic style |

**Adding a new subject:** drop an image in `scenes/`, add one object to
`scenes[]`, refresh. No code changes.

**Model options:**

| Model | Speed | Cost / image | Use when |
|---|---|---|---|
| `gemini-3.1-flash-lite-image` | fastest | ~$0.034 (₹3) | live event queue — **default** |
| `gemini-3.1-flash-image` | ~2x slower | ~$0.067 (₹6) | better quality |
| `gemini-3-pro-image` | slowest | ~$0.134 (₹12) | print output |

**`config/prompt-template.txt`** holds the identity-preservation rules that apply
to every scene — keep the face and clothing sections strict, they are what stop
the model from beautifying or re-dressing the visitor.

---

## If output quality disappoints

1. **Better reference image first.** The model copies what it sees. A sharp,
   front-facing, clean-background reference fixes more than prompt tweaking does.
2. **Lighting on the visitor.** A softbox or ring light aimed at the subject
   improves face fidelity more than any model upgrade.
3. **Step up the model** in `config/scenes.json`.
4. **Face still not exact?** That is what Phase 2 (identity lock) is for — see below.

---

## Known limits of Phase 1

- **Face likeness lands around 85–90%.** Generative models drift slightly.
  Phase 2 fixes this by blending the original face back onto the result.
- **Real celebrities will be refused.** The API declines to generate identifiable
  public figures; you'll get a clear "model did not return an image" error with
  the reason. Real-person scenes need the face-swap route instead, plus that
  person's permission for commercial use.
- **Needs internet.** Roughly 1–2 MB per photo. On venue Wi-Fi, keep a 4G hotspot
  as backup.
- **No queue handling yet.** One visitor at a time.

---

## Roadmap

- **Phase 2 — identity lock:** a Python sidecar (InsightFace + CodeFormer) that
  re-blends the original captured face onto the generated image, taking likeness
  to ~95%. Adds ~2s. Toggleable.
- **Phase 3 — event hardening:** offline fallback, operator control panel, queue
  handling, multi-person detection, session logs.
- **Phase 4:** DSLR tethering, thermal printing, WhatsApp delivery.

---

## Files

| Path | Role |
|---|---|
| `server.js` | Express API — builds the prompt, calls Gemini, saves output, makes the QR |
| `public/app.js` | camera, presence detection, state machine, capture |
| `public/index.html` `public/style.css` | kiosk screen |
| `config/scenes.json` | subjects, prompts, timings, model |
| `config/prompt-template.txt` | identity-preservation rules |
| `test-api.js` | pre-event API check |
| `scenes/` | your reference images |
| `output/` | generated photos (served over LAN for QR download) |
