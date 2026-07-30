"""Change-detection sidecar endpoints.

These endpoints back the GeoInt Change Detection dialog: compare a "before"
and "after" image and get back a change mask/overlay/heatmap plus a GeoJSON of
changed-area polygons. Like ``ml.py`` (AI segmentation), this module never
loads any model itself — it is a thin reverse-proxy in front of an already
running external "Change Detection API" (FastAPI, GPU-backed), reached at a
fixed URL. Unlike ``ml.py`` there is no local child-process launch path: this
backend is always a separate, already-running service.

Two ways to compare images, matching the external API's two endpoints:

- ``POST /changedetect/predict/{model_name}`` — any two images. A transparent
  multipart passthrough: the browser uploads the "pre"/"post" bytes (a local
  file, or bytes fetched from a map layer) and this endpoint forwards them
  unchanged.
- ``POST /changedetect/predict_paths/{model_name}`` — a Mosaic Timeline pair.
  The browser only ever supplies two ``mosaic_id`` values; this endpoint
  resolves each to its raw NAS/local path via the mosaics DB (server-side
  only, never the browser) and forwards those paths as form data. The
  external host has its own direct network/SMB access to the imagery NAS, so
  no image bytes cross this sidecar for this path.

Configuration (environment variables):

- ``GEOINT_CHANGE_DETECTION_URL`` — base URL of the already-running Change
  Detection API (e.g. ``http://10.10.116.215:8005``). Required; when unset,
  ``GET /changedetect/status`` reports ``available: false`` and the work
  endpoints return 503.

All endpoints degrade gracefully, mirroring ``ml.py``: ``GET
/changedetect/status`` never raises, and the work endpoints return 503 when
the backend URL is unset or unreachable.
"""

from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from .mosaics import get_mosaic_path

router = APIRouter(prefix="/changedetect", tags=["change-detection"])
logger = logging.getLogger("geoint.changedetect")

_EXTERNAL_URL = os.environ.get("GEOINT_CHANGE_DETECTION_URL", "").strip()

# Sliding-window GPU inference over a large mosaic can take a while.
_PROXY_TIMEOUT_SECS = 1800


def _require_httpx():
    """Import httpx lazily so the sidecar runs without the ``ml`` extra.

    Returns:
        The imported ``httpx`` module.

    Raises:
        RuntimeError: If httpx is not installed.
    """
    try:
        import httpx  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - exercised via status path
        raise RuntimeError(
            "The 'ml' extra is not installed (httpx is required). Install with: "
            "pip install geoint-server[ml]"
        ) from exc
    return httpx


def _redact_url(url: str) -> str:
    """Strip embedded credentials from a URL before surfacing it to clients.

    Args:
        url: The URL to sanitise.

    Returns:
        The URL with any userinfo removed, or the original string if it
        cannot be parsed.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if not (parsed.username or parsed.password):
        return url
    host = parsed.hostname or ""
    netloc = f"{host}:{parsed.port}" if parsed.port else host
    return urllib.parse.urlunsplit(parsed._replace(netloc=netloc))


def _is_healthy(base_url: str, timeout: float = 3.0) -> Optional[dict[str, Any]]:
    """Return the backend's /health payload if it answers, else None."""
    try:
        httpx = _require_httpx()
        resp = httpx.get(f"{base_url}/health", timeout=timeout)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        return payload if payload.get("status") == "ok" else None
    except RuntimeError:
        return None
    except Exception as exc:  # noqa: BLE001 - a probe failure means "not healthy"
        logger.debug("Health check for %s failed: %s", _redact_url(base_url), exc)
        return None


@router.get("/status")
def change_detection_status() -> dict[str, Any]:
    """Report whether the change-detection backend is available.

    Cheap by design: it only probes ``/health``. Never leaks the backend's
    ``weights_dir`` (a local filesystem path on the GPU host) to the browser.

    Returns:
        A dict with ``available``, a human ``message``, the resolved ``url``
        when known, and (when reachable) ``device``, ``gpu``, and
        ``models_loaded``.
    """
    if not _EXTERNAL_URL:
        return {
            "available": False,
            "message": (
                "Change detection is not configured. Set GEOINT_CHANGE_DETECTION_URL "
                "to an already-running Change Detection API."
            ),
        }

    base = _EXTERNAL_URL.rstrip("/")
    health = _is_healthy(base)
    if health is None:
        return {
            "available": False,
            "message": (
                f"GEOINT_CHANGE_DETECTION_URL is set to {_redact_url(base)} but "
                "the server is not responding."
            ),
            "url": _redact_url(base),
        }
    return {
        "available": True,
        "message": "Change detection backend is ready.",
        "url": _redact_url(base),
        "device": health.get("device"),
        "gpu": health.get("gpu"),
        "models_loaded": health.get("models_loaded", []),
    }


def _resolve_base() -> str:
    """Resolve the configured backend URL, mapping absence to a 503.

    Returns:
        The configured base URL (no trailing slash).

    Raises:
        HTTPException: 503 if no backend URL is configured.
    """
    if not _EXTERNAL_URL:
        raise HTTPException(
            status_code=503,
            detail=(
                "Change detection is not configured. Set GEOINT_CHANGE_DETECTION_URL "
                "to an already-running Change Detection API."
            ),
        )
    return _EXTERNAL_URL.rstrip("/")


@router.get("/models")
async def change_detection_models():
    """Proxy the backend's model catalogue (available + loaded models)."""
    base = _resolve_base()
    httpx = _require_httpx()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{base}/models")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Change detection backend error: {exc}")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


@router.post("/predict/{model_name}")
async def predict(request: Request, model_name: str) -> Response:
    """Any-images mode: transparent multipart passthrough to /predict/{model}.

    Streams the raw request body and content-type through unchanged so the
    "pre"/"post" files and tuning params (threshold, img_size, window_overlap,
    generate_outputs) all forward exactly as the browser sent them, and a
    large upload is never buffered whole in the sidecar's memory.
    """
    base = _resolve_base()
    httpx = _require_httpx()
    headers = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type

    async def _body_iter():
        async for chunk in request.stream():
            if chunk:
                yield chunk

    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT_SECS) as client:
            resp = await client.post(
                f"{base}/predict/{model_name}", content=_body_iter(), headers=headers
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Change detection backend error: {exc}")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


class MosaicPairRequest(BaseModel):
    pre_mosaic_id: int
    post_mosaic_id: int
    threshold: float = 0.5
    img_size: Optional[int] = None
    window_overlap: int = 16


@router.post("/predict_paths/{model_name}")
async def predict_paths(model_name: str, body: MosaicPairRequest) -> Response:
    """Mosaic Timeline mode: resolve two mosaic ids to NAS paths, forward to
    /predict_paths/{model}. The browser only ever supplies mosaic ids — the
    actual filesystem path is resolved here, server-side, so it can never
    smuggle in an arbitrary path.
    """
    base = _resolve_base()
    httpx = _require_httpx()
    pre_path = get_mosaic_path(body.pre_mosaic_id)
    post_path = get_mosaic_path(body.post_mosaic_id)
    data = {
        "pre_path": pre_path,
        "post_path": post_path,
        "threshold": body.threshold,
        "window_overlap": body.window_overlap,
    }
    if body.img_size is not None:
        data["img_size"] = body.img_size
    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT_SECS) as client:
            resp = await client.post(f"{base}/predict_paths/{model_name}", data=data)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Change detection backend error: {exc}")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )
