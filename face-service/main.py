"""
HTTP front door for the face transplant.

Runs alongside the Next.js app on the same machine and is never exposed to the
internet - the booth talks to Next.js, Next.js talks to this. Bind it to
127.0.0.1 and it needs no auth of its own.

    uvicorn main:app --host 127.0.0.1 --port 8000

A failed swap is still HTTP 200 with ok=false. The caller's correct response to
"no face found" is to keep the photo the model drew, not to raise an error at a
visitor standing in front of a camera, so failure is an outcome rather than an
exception.
"""

from __future__ import annotations

import base64
import binascii
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field

import composite as compositor
import swap as swapper

# Generated photos arrive at up to 4K and the capture at up to 1080p. Anything
# past this is not a photograph we produced.
MAX_BYTES = 24 * 1024 * 1024

# High enough that the transplanted face is not re-softened by the encoder it
# passes through on the way out.
JPEG_QUALITY = 95


def _decode(field: str, data: str) -> np.ndarray:
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError(f"{field} is not valid base64: {err}") from err
    if len(raw) > MAX_BYTES:
        raise ValueError(f"{field} is larger than {MAX_BYTES // (1024 * 1024)} MB")

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"{field} could not be read as an image")
    return image


def _encode(image: np.ndarray) -> str:
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok:
        raise RuntimeError("Could not encode the blended photo")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load both models now rather than during the first visitor's countdown.
    # A missing segmentation model must not stop the swap path from serving.
    swapper.warm()
    try:
        compositor.warm()
    except Exception as err:  # noqa: BLE001
        print(f"[composite] unavailable: {err}")
    yield


app = FastAPI(title="Ello face service", version="1.0.0", lifespan=lifespan)


class SwapRequest(BaseModel):
    target: str = Field(description="base64 image - the photograph the model produced")
    source: str = Field(description="base64 image - the booth's capture of the visitor")
    avoid: str | None = Field(
        default=None,
        description="base64 image - the scene's reference artwork, whose face must be left alone",
    )
    sharpen: bool = True


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": swapper.MODEL_PATH.exists(),
        "composite": compositor.MODEL_PATH.exists(),
    }


@app.post("/swap")
def do_swap(body: SwapRequest) -> dict:
    started = time.perf_counter()

    def elapsed() -> int:
        return round((time.perf_counter() - started) * 1000)

    try:
        target = _decode("target", body.target)
        source = _decode("source", body.source)
        avoid = _decode("avoid", body.avoid) if body.avoid else None
    except ValueError as err:
        return {"ok": False, "reason": str(err), "ms": elapsed(), "detail": {}}

    try:
        outcome = swapper.swap(target, source, avoid, sharpen=body.sharpen)
    except Exception as err:  # noqa: BLE001 - a live booth must never 500 here
        return {
            "ok": False,
            "reason": f"{type(err).__name__}: {err}",
            "ms": elapsed(),
            "detail": {},
        }

    if not outcome.ok or outcome.image is None:
        return {"ok": False, "reason": outcome.reason, "ms": elapsed(), "detail": outcome.detail}

    return {"ok": True, "image": _encode(outcome.image), "ms": elapsed(), "detail": outcome.detail}


class CompositeRequest(BaseModel):
    person: str = Field(description="base64 image - the booth's capture of the visitor")
    plate: str = Field(description="base64 image - the finished scene to stand them in")
    anchor_x: float = Field(default=0.72, ge=0.0, le=1.0)
    anchor_bottom: float = Field(default=1.0, ge=0.0, le=1.5)
    height: float = Field(default=0.88, gt=0.0, le=1.5)
    shadow: bool = True


@app.post("/composite")
def do_composite(body: CompositeRequest) -> dict:
    """
    The other way of making the photograph: cut the visitor out and stand them
    in a fixed scene, rather than having a model draw the whole thing.

    Same contract as /swap - a failure is a 200 with ok=false, because the right
    answer to "no one was found standing there" is to tell the booth, not to
    raise at someone waiting for their picture.
    """
    started = time.perf_counter()

    def elapsed() -> int:
        return round((time.perf_counter() - started) * 1000)

    try:
        person = _decode("person", body.person)
        plate = _decode("plate", body.plate)
    except ValueError as err:
        return {"ok": False, "reason": str(err), "ms": elapsed(), "detail": {}}

    try:
        outcome = compositor.compose(
            person,
            plate,
            compositor.Placement(
                anchor_x=body.anchor_x,
                anchor_bottom=body.anchor_bottom,
                height=body.height,
            ),
            shadow=body.shadow,
        )
    except Exception as err:  # noqa: BLE001 - a live booth must never 500 here
        return {
            "ok": False,
            "reason": f"{type(err).__name__}: {err}",
            "ms": elapsed(),
            "detail": {},
        }

    if not outcome.ok or outcome.image is None:
        return {"ok": False, "reason": outcome.reason, "ms": elapsed(), "detail": outcome.detail}

    return {"ok": True, "image": _encode(outcome.image), "ms": elapsed(), "detail": outcome.detail}
