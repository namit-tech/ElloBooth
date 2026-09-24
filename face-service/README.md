# Face service

Replaces the AI-drawn face in a generated photo with the visitor's real one.

Runs on CPU, on the same machine as the Next.js app, on `127.0.0.1:8000`. It is
not exposed to the internet and has no auth of its own — only the Next.js
server ever calls it.

## Why it is a separate process

The blend used to run in the booth's browser with canvas. Two things it needed
do not exist there:

- **Poisson blending.** `cv2.seamlessClone` solves a sparse linear system over
  the transplanted region. Canvas can only alpha-blend, which means choosing
  between a visible seam and averaging the two faces together — and the
  averaged ring is the jaw, chin and hairline, which is where likeness lives.
- **A real warp.** A triangle mesh warp over ~900 triangles is fine in OpenCV
  and painful in canvas.

Moving it server-side also fixed two things for free: photos generated from the
offline queue now get the real face too (they never did before, because the
blend only ran in the live capture path), and the image stored behind the QR
link is the same one shown on screen instead of a second upload racing it.

## Setup

```powershell
cd face-service
py -3.11 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run

```powershell
.venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8000
```

Then point the app at it in `.env`:

```
FACE_SERVICE_URL=http://127.0.0.1:8000
```

Leave that unset and the app skips the swap entirely and serves the model's own
photo — useful for testing generation on its own.

## API

`GET /health` → `{"ok": true, "model": true}`

`POST /swap`

```json
{
  "target": "<base64 image>   the photograph the model produced",
  "source": "<base64 image>   the booth's capture of the visitor",
  "avoid":  "<base64 image>   the scene's reference artwork (optional)",
  "sharpen": true
}
```

Always answers `200`. A swap that could not happen is `ok: false` with a reason,
because the right response to "no face found" is to keep the photo the model
drew, not to fail a visitor standing in front of a camera.

```json
{
  "ok": true,
  "image": "<base64 jpeg>",
  "ms": 1840,
  "detail": {
    "faces_in_photo": 2,
    "reference_face_found": true,
    "chosen_face": 1,
    "score": 0.41,
    "all_scores": [-0.92, 0.41],
    "score_vs_reference": -0.77,
    "capture_face_px": 214,
    "photo_face_px": 337,
    "scale_ratio": 1.57
  }
}
```

`detail` is stored on every generation row, so the dashboard can answer the
question the old browser blend could not: *is this working, and if not, why.*

- `all_scores` — how much each face in the photo resembles the visitor. In a
  temple scene the deity should score clearly lower than the visitor.
- `score_vs_reference` — the veto. If the chosen face resembles the scene's own
  artwork more than it resembles the visitor, nothing is swapped, so a visitor
  is never transplanted onto a murti.
- `scale_ratio` — how much the capture's face had to be enlarged. Consistently
  above ~2.0 means the camera is too far from the visitor or the capture is
  being downscaled too hard, and no amount of blending will recover the detail.

## Cost of each step

Rough, on a mid-range CPU with no GPU, for a 1K photo:

| Step | ms |
|---|---|
| landmark detection ×3 (capture, photo, reference) | 200–500 |
| triangulation + ~900 triangle warps | 150–400 |
| `seamlessClone` | 200–600 |

Around 1–2 s total, against 10–40 s for generation itself.
