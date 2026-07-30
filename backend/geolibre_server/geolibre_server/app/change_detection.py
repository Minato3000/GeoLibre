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
  no image bytes cross this sidecar for this path. Identical requests (same
  model/mosaic pair/threshold/window_overlap/img_size) are served from a
  short-lived in-process cache instead of re-running GPU inference.

Configuration (environment variables):

- ``GEOINT_CHANGE_DETECTION_URL`` — base URL of the already-running Change
  Detection API (e.g. ``http://10.10.116.215:8005``). Required; when unset,
  ``GET /changedetect/status`` reports ``available: false`` and the work
  endpoints return 503.
- ``GEOINT_CHANGE_DETECTION_CACHE_TTL_SECS`` — how long a ``predict_paths``
  result is cached for, in seconds (default 600). Set to ``0`` to disable
  the cache entirely.

All endpoints degrade gracefully, mirroring ``ml.py``: ``GET
/changedetect/status`` never raises, and the work endpoints return 503 when
the backend URL is unset or unreachable.
"""

from __future__ import annotations

import logging
import os
import time
import urllib.parse
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .mosaics import get_mosaic_path

router = APIRouter(prefix="/changedetect", tags=["change-detection"])
logger = logging.getLogger("geoint.changedetect")

_EXTERNAL_URL = os.environ.get("GEOINT_CHANGE_DETECTION_URL", "").strip()

# Sliding-window GPU inference over a large mosaic can take a while, but a
# genuinely unreachable host should fail fast rather than hang for the full
# budget -- only the read phase (waiting on inference) gets the long timeout.
_PROXY_TIMEOUT_SECS = 1800


def _proxy_timeout(httpx: Any) -> Any:
    return httpx.Timeout(connect=5.0, read=_PROXY_TIMEOUT_SECS, write=30.0, pool=5.0)


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


def _backend_error_detail(exc: Exception) -> str:
    """Build an error message that's never just a bare, empty colon.

    `str()` of a timeout/connect error (`httpx.ConnectTimeout`,
    `httpx.ReadTimeout`, ...) is often the empty string, which would
    otherwise render to the user as "Change detection backend error: " with
    nothing after it.
    """
    message = str(exc) or type(exc).__name__
    return f"Change detection backend error: {message}"


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
        raise HTTPException(status_code=502, detail=_backend_error_detail(exc))
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


async def _forward_streaming(
    httpx: Any,
    method: str,
    url: str,
    *,
    cache_key: Optional[tuple] = None,
    **kwargs: Any,
) -> Response:
    """Issue the request and stream the response back instead of buffering
    the whole body (which can be several MB of base64-encoded PNGs) fully in
    memory before the first byte reaches the browser.

    When `cache_key` is given, the streamed bytes are also accumulated and
    written into the result cache as they pass through -- one buffer copy,
    same as the old non-streaming behavior, but built as a side effect of
    data that's already flowing rather than a dedicated buffering step.
    Callers check the cache themselves before calling this (see
    `predict_paths`), so this function only ever populates it, never serves
    a cached response.
    """
    client = httpx.AsyncClient(timeout=_proxy_timeout(httpx))
    try:
        request = client.build_request(method, url, **kwargs)
        upstream = await client.send(request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=_backend_error_detail(exc))

    status_code = upstream.status_code
    media_type = upstream.headers.get("content-type")

    async def body() -> AsyncIterator[bytes]:
        buffer = bytearray() if cache_key is not None and status_code == 200 else None
        try:
            async for chunk in upstream.aiter_bytes():
                if buffer is not None:
                    buffer.extend(chunk)
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
            if buffer is not None:
                _cache_put(cache_key, bytes(buffer), status_code, media_type)

    return StreamingResponse(body(), status_code=status_code, media_type=media_type)


@router.post("/predict/{model_name}")
async def predict(request: Request, model_name: str) -> Response:
    """Any-images mode: transparent multipart passthrough to /predict/{model}.

    Streams the raw request body and content-type through unchanged so the
    "pre"/"post" files and tuning params (threshold, img_size, window_overlap,
    generate_outputs) all forward exactly as the browser sent them, and a
    large upload is never buffered whole in the sidecar's memory. Not cached
    (the inputs are raw uploaded bytes -- no stable cache key without hashing
    the upload).
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

    return await _forward_streaming(
        httpx, "POST", f"{base}/predict/{model_name}", content=_body_iter(), headers=headers
    )


class MosaicPairRequest(BaseModel):
    pre_mosaic_id: int
    post_mosaic_id: int
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    img_size: Optional[int] = Field(default=None, ge=1)
    window_overlap: int = Field(default=16, ge=0)


# --- predict_paths result cache ---------------------------------------------
#
# Keyed on every input that affects the result; a re-run of the identical
# (model, pre, post, threshold, window_overlap, img_size) tuple -- two tabs,
# or re-checking after an unrelated UI tweak -- is served from here instead of
# re-running GPU inference. A TTL (not a size-bounded LRU) because the
# underlying mosaic imagery could in principle be reprocessed on the NAS, so
# a stale result should eventually fall out on its own rather than live
# forever just because it's popular.
_CACHE_TTL_SECS = float(os.environ.get("GEOINT_CHANGE_DETECTION_CACHE_TTL_SECS", "600"))
_result_cache: dict[tuple, tuple[float, bytes, int, Optional[str]]] = {}


def _cache_key(model_name: str, body: "MosaicPairRequest") -> tuple:
    return (
        model_name,
        body.pre_mosaic_id,
        body.post_mosaic_id,
        round(body.threshold, 4),
        body.window_overlap,
        body.img_size,
    )


def _cache_get(key: tuple) -> Optional[Response]:
    if _CACHE_TTL_SECS <= 0:
        return None
    entry = _result_cache.get(key)
    if entry is None:
        return None
    expires_at, content, status_code, media_type = entry
    if time.monotonic() > expires_at:
        del _result_cache[key]
        return None
    return Response(content=content, status_code=status_code, media_type=media_type)


def _cache_put(key: tuple, content: bytes, status_code: int, media_type: Optional[str]) -> None:
    if _CACHE_TTL_SECS <= 0:
        return
    _result_cache[key] = (time.monotonic() + _CACHE_TTL_SECS, content, status_code, media_type)


def _reset_result_cache_for_tests() -> None:
    _result_cache.clear()


@router.post("/predict_paths/{model_name}")
async def predict_paths(model_name: str, body: MosaicPairRequest) -> Response:
    """Mosaic Timeline mode: resolve two mosaic ids to NAS paths, forward to
    /predict_paths/{model}. The browser only ever supplies mosaic ids — the
    actual filesystem path is resolved here, server-side, so it can never
    smuggle in an arbitrary path.
    """
    cache_key = _cache_key(model_name, body)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    base = _resolve_base()
    httpx = _require_httpx()
    # DuckDB path resolution is synchronous file/DB I/O; off the event loop so
    # one change-detection request doesn't stall every other concurrent
    # sidecar request (mosaics browsing, status polls, ...) for its duration.
    pre_path = await run_in_threadpool(get_mosaic_path, body.pre_mosaic_id)
    post_path = await run_in_threadpool(get_mosaic_path, body.post_mosaic_id)
    data = {
        "pre_path": pre_path,
        "post_path": post_path,
        "threshold": body.threshold,
        "window_overlap": body.window_overlap,
    }
    if body.img_size is not None:
        data["img_size"] = body.img_size
    return await _forward_streaming(
        httpx, "POST", f"{base}/predict_paths/{model_name}", data=data, cache_key=cache_key
    )
