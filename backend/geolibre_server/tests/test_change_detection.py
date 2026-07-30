"""Tests for the /changedetect change-detection proxy router.

The router is a thin reverse-proxy in front of an already-running external
Change Detection API, so these tests exercise the proxy logic (status
reporting, mosaic-id -> path resolution, request forwarding, error mapping)
without a live GPU model server.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import change_detection, mosaics

try:
    import duckdb  # noqa: F401

    HAS_DUCKDB = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_DUCKDB = False

requires_duckdb = pytest.mark.skipif(not HAS_DUCKDB, reason="duckdb optional extra not installed")

_REAL_UNC = r"\\10.10.180.51\Nets\Tiles\Real Place\mosaics\mosaic_2024-06-01_zoom15.png"
_REAL_UNC_2 = r"\\10.10.180.51\Nets\Tiles\Real Place\mosaics\mosaic_2024-01-01_zoom15.png"


def _make_test_db(path: Path) -> None:
    conn = duckdb.connect(str(path))
    try:
        conn.execute("INSTALL spatial")
        conn.execute("LOAD spatial")
        conn.execute(
            """
            CREATE TABLE locations (
                location_id INTEGER PRIMARY KEY,
                location_name VARCHAR,
                center_lat DOUBLE,
                center_lon DOUBLE,
                radius_m DOUBLE,
                geom GEOMETRY
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE mosaics (
                mosaic_id INTEGER PRIMARY KEY,
                location_id INTEGER,
                mosaic_no INTEGER,
                acquisition_date DATE,
                zoom_level INTEGER,
                mosaic_filename VARCHAR,
                mosaic_path VARCHAR,
                pixel_size_x DOUBLE,
                pixel_size_y DOUBLE,
                rotation_x DOUBLE,
                rotation_y DOUBLE,
                top_left_x DOUBLE,
                top_left_y DOUBLE
            )
            """
        )
        conn.execute(
            "INSERT INTO locations VALUES (1, 'Real Place', 27.4, 88.9, 3000, ST_Point(88.9, 27.4))"
        )
        conn.execute(
            "INSERT INTO mosaics VALUES "
            "(10, 1, 2, '2024-06-01', 15, 'mosaic_2024-06-01_zoom15', ?, "
            "0.0001, -0.0001, 0, 0, 88.9, 27.41), "
            "(9, 1, 1, '2024-01-01', 15, 'mosaic_2024-01-01_zoom15', ?, "
            "0.0001, -0.0001, 0, 0, 88.9, 27.41)",
            [_REAL_UNC, _REAL_UNC_2],
        )
    finally:
        conn.close()


@pytest.fixture()
def db_path(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "test_mosaics.duckdb"
    _make_test_db(path)
    monkeypatch.setattr(mosaics, "DB_PATH", str(path))
    monkeypatch.setattr(mosaics, "_spatial_extension_loaded", False)
    return path


@pytest.fixture(autouse=True)
def _clear_result_cache():
    change_detection._reset_result_cache_for_tests()
    yield
    change_detection._reset_result_cache_for_tests()


async def _drain(response) -> bytes:
    """Consume a StreamingResponse's body, mirroring what serving it over
    ASGI would do (needed so post-completion side effects, like writing the
    result cache, actually run)."""
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode())
    return b"".join(chunks)


# --- fakes ------------------------------------------------------------------


class _FakeResp:
    def __init__(self, content=b'{"ok": 1}', status_code=200, content_type="application/json"):
        self.content = content
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    def json(self):
        return json.loads(self.content)

    async def aiter_bytes(self):
        yield self.content

    async def aclose(self):
        pass


class _FakeRequest:
    def __init__(self, method, url, content=None, data=None, headers=None):
        self.method = method
        self.url = url
        self.content = content
        self.data = data
        self.headers = headers


class _FakeAsyncClient:
    # Content served by the next `send()` call; tests can override this to
    # exercise different upstream payloads/status codes.
    next_response = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url):
        _FakeHttpx.calls.append(("GET", url))
        return _FakeResp()

    def build_request(self, method, url, content=None, data=None, headers=None):
        return _FakeRequest(method, url, content=content, data=data, headers=headers)

    async def send(self, request, stream=False):
        content = request.content
        if content is not None and hasattr(content, "__aiter__"):
            buffered = b""
            async for chunk in content:
                buffered += chunk
            content = buffered
        _FakeHttpx.calls.append(
            (request.method, request.url, content, request.data, request.headers)
        )
        return _FakeAsyncClient.next_response or _FakeResp(
            content=b'{"status": "success", "geojson": {"type": "FeatureCollection"}}'
        )

    async def aclose(self):
        pass


class _FakeHttpx:
    """Minimal stand-in for the httpx module used by change_detection.py."""

    calls: list = []
    HTTPError = Exception
    AsyncClient = _FakeAsyncClient
    Timeout = dict

    @staticmethod
    def get(url, timeout=None):
        if url.endswith("/health"):
            return _FakeResp(
                content=b'{"status": "ok", "device": "cuda", "gpu": "RTX PRO 6000", '
                b'"weights_dir": "/data/keerthana/Kavin/Final_CD/final_model", '
                b'"models_loaded": ["bit", "snunet"]}'
            )
        return _FakeResp()


# --- status ------------------------------------------------------------------


def test_status_unavailable_when_url_unset(monkeypatch):
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "")
    status = change_detection.change_detection_status()
    assert status["available"] is False
    assert "GEOINT_CHANGE_DETECTION_URL" in status["message"]


def test_status_unavailable_when_not_responding(monkeypatch):
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://127.0.0.1:9999")
    monkeypatch.setattr(change_detection, "_is_healthy", lambda base, timeout=3.0: None)
    status = change_detection.change_detection_status()
    assert status["available"] is False
    assert "not responding" in status["message"]


def test_status_available_reports_models_and_never_leaks_weights_dir(monkeypatch):
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    status = change_detection.change_detection_status()
    assert status["available"] is True
    assert status["models_loaded"] == ["bit", "snunet"]
    assert status["gpu"] == "RTX PRO 6000"
    assert "weights_dir" not in json.dumps(status)


def test_status_redacts_credentials_in_url(monkeypatch):
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://user:pass@10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)
    status = change_detection.change_detection_status()
    assert status["url"] == "http://10.10.116.215:8005"


def test_redact_url_strips_credentials():
    assert change_detection._redact_url("http://user:pass@gpu-host:8005") == (
        "http://gpu-host:8005"
    )
    assert change_detection._redact_url("http://gpu-host:8005") == "http://gpu-host:8005"


# --- /models -----------------------------------------------------------------


def test_resolve_base_raises_503_when_unset(monkeypatch):
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "")
    with pytest.raises(HTTPException) as exc:
        change_detection._resolve_base()
    assert exc.value.status_code == 503


# --- predict_paths: mosaic-id -> path resolution -----------------------------


@requires_duckdb
def test_get_mosaic_path_resolves_unc(db_path: Path) -> None:
    assert mosaics.get_mosaic_path(10) == _REAL_UNC
    assert mosaics.get_mosaic_path(9) == _REAL_UNC_2


@requires_duckdb
def test_get_mosaic_path_missing_id_returns_404(db_path: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        mosaics.get_mosaic_path(999999)
    assert exc.value.status_code == 404


@requires_duckdb
def test_predict_paths_resolves_ids_and_forwards_paths(monkeypatch, db_path: Path) -> None:
    _FakeHttpx.calls.clear()
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    body = change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10, threshold=0.6)
    result = asyncio.run(change_detection.predict_paths("bit", body))

    assert result.status_code == 200
    forwarded = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert forwarded, "expected a forwarded POST call"
    _, url, _content, data, _headers = forwarded[0]
    assert url == "http://10.10.116.215:8005/predict_paths/bit"
    assert data["pre_path"] == _REAL_UNC_2
    assert data["post_path"] == _REAL_UNC
    assert data["threshold"] == 0.6


@requires_duckdb
def test_predict_paths_missing_mosaic_id_returns_404(monkeypatch, db_path: Path) -> None:
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    body = change_detection.MosaicPairRequest(pre_mosaic_id=999999, post_mosaic_id=10)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(change_detection.predict_paths("bit", body))
    assert exc.value.status_code == 404


@requires_duckdb
def test_predict_paths_rejects_out_of_range_threshold() -> None:
    with pytest.raises(Exception):  # pydantic ValidationError
        change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10, threshold=5.0)


# --- predict_paths: result cache ---------------------------------------------


@requires_duckdb
def test_predict_paths_second_identical_request_is_cached(monkeypatch, db_path: Path) -> None:
    _FakeHttpx.calls.clear()
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    body = change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10, threshold=0.6)

    first = asyncio.run(change_detection.predict_paths("bit", body))
    asyncio.run(_drain(first))
    forwarded_after_first = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert len(forwarded_after_first) == 1

    second = asyncio.run(change_detection.predict_paths("bit", body))
    forwarded_after_second = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert len(forwarded_after_second) == 1, "identical request should be served from cache"
    assert second.status_code == 200
    assert second.body == b'{"status": "success", "geojson": {"type": "FeatureCollection"}}'


@requires_duckdb
def test_predict_paths_different_threshold_is_not_cached(monkeypatch, db_path: Path) -> None:
    _FakeHttpx.calls.clear()
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    first = asyncio.run(
        change_detection.predict_paths(
            "bit",
            change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10, threshold=0.5),
        )
    )
    asyncio.run(_drain(first))
    asyncio.run(
        change_detection.predict_paths(
            "bit",
            change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10, threshold=0.6),
        )
    )
    forwarded = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert len(forwarded) == 2, "a different threshold must not hit the same cache entry"


@requires_duckdb
def test_predict_paths_cache_disabled_when_ttl_is_zero(monkeypatch, db_path: Path) -> None:
    _FakeHttpx.calls.clear()
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)
    monkeypatch.setattr(change_detection, "_CACHE_TTL_SECS", 0.0)

    body = change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10)
    first = asyncio.run(change_detection.predict_paths("bit", body))
    asyncio.run(_drain(first))
    asyncio.run(change_detection.predict_paths("bit", body))
    forwarded = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert len(forwarded) == 2, "TTL of 0 must disable caching entirely"


# --- error message fallback ---------------------------------------------------


def test_backend_error_detail_falls_back_to_exception_type_when_message_empty() -> None:
    class _EmptyMessageError(Exception):
        def __str__(self) -> str:
            return ""

    detail = change_detection._backend_error_detail(_EmptyMessageError())
    assert detail == "Change detection backend error: _EmptyMessageError"
    assert detail != "Change detection backend error: "


@requires_duckdb
def test_predict_paths_surfaces_non_empty_message_on_connect_failure(
    monkeypatch, db_path: Path
) -> None:
    class _EmptyConnectError(Exception):
        def __str__(self) -> str:
            return ""

    class _FailingClient(_FakeAsyncClient):
        def build_request(self, *args, **kwargs):
            raise _EmptyConnectError()

    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    failing_httpx = type(
        "FailingHttpx",
        (),
        {"HTTPError": Exception, "AsyncClient": _FailingClient, "Timeout": dict},
    )
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: failing_httpx)

    body = change_detection.MosaicPairRequest(pre_mosaic_id=9, post_mosaic_id=10)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(change_detection.predict_paths("bit", body))
    assert exc.value.detail != "Change detection backend error: "
    assert "_EmptyConnectError" in exc.value.detail


# --- predict: multipart passthrough (needs httpx for TestClient) ------------


def test_predict_forwards_multipart_body_unchanged(monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from geolibre_server.app.main import app

    _FakeHttpx.calls.clear()
    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "http://10.10.116.215:8005")
    monkeypatch.setattr(change_detection, "_require_httpx", lambda: _FakeHttpx)

    client = TestClient(app)
    resp = client.post(
        "/changedetect/predict/bit",
        files={
            "pre": ("pre.png", b"prebytes", "image/png"),
            "post": ("post.png", b"postbytes", "image/png"),
        },
        data={"threshold": "0.5"},
    )
    assert resp.status_code == 200
    forwarded = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert forwarded and forwarded[0][1] == "http://10.10.116.215:8005/predict/bit"
    assert b"prebytes" in forwarded[0][2]
    assert b"postbytes" in forwarded[0][2]


def test_predict_returns_503_when_url_unset(monkeypatch):
    from fastapi.testclient import TestClient

    from geolibre_server.app.main import app

    monkeypatch.setattr(change_detection, "_EXTERNAL_URL", "")
    client = TestClient(app)
    resp = client.post(
        "/changedetect/predict/bit",
        files={"pre": ("a.png", b"x", "image/png"), "post": ("b.png", b"y", "image/png")},
    )
    assert resp.status_code == 503
