"""Tests for the satellite-mosaic sidecar endpoints (app/mosaics.py).

Two tiers, mirroring test_postgis.py's approach:

- Metadata tests (status, locations, dates, UNC parsing, path resolution) need
  only ``duckdb`` installed.
- COG-building tests additionally require the raster stack (``rasterio``,
  ``rio-cogeo``, Pillow — the ``mosaics`` extra) and are skipped otherwise.

None of these touch a real NAS or SMB share: ``_fetch_via_smb`` is stubbed or
exercised only against its "no credentials configured" error path, and mount
resolution is tested against tmp_path fixtures standing in for the CIFS mount.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import mosaics

try:
    import duckdb  # noqa: F401

    HAS_DUCKDB = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_DUCKDB = False

try:
    import numpy  # noqa: F401
    import rasterio  # noqa: F401
    import rio_cogeo  # noqa: F401
    from PIL import Image  # noqa: F401

    HAS_RASTER_STACK = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_RASTER_STACK = False

requires_duckdb = pytest.mark.skipif(not HAS_DUCKDB, reason="duckdb optional extra not installed")
requires_raster_stack = pytest.mark.skipif(
    not HAS_RASTER_STACK, reason="mosaics raster extra not installed"
)

# One valid location plus one of the known junk rows (center 0,0 with a
# telltale ".lnk" name), and two mosaics for the valid location inserted
# out of date order, to check both the junk filter and the ORDER BY.
_REAL_UNC = r"\\10.10.180.51\Nets\Tiles\Real Place\mosaics\mosaic_2024-06-01_zoom15.png"


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
            "INSERT INTO locations VALUES "
            "(1, 'Real Place', 27.4, 88.9, 3000, ST_Point(88.9, 27.4)), "
            "(2, 'Galwan Valley - Shortcut.lnk', 0, 0, 3000, ST_Point(0, 0))"
        )
        conn.execute(
            "INSERT INTO mosaics VALUES "
            "(10, 1, 2, '2024-06-01', 15, 'mosaic_2024-06-01_zoom15', ?, "
            "0.0001, -0.0001, 0, 0, 88.9, 27.41), "
            "(9, 1, 1, '2024-01-01', 15, 'mosaic_2024-01-01_zoom15', "
            r"'\\10.10.180.51\Nets\Tiles\Real Place\mosaics\mosaic_2024-01-01_zoom15.png', "
            "0.0001, -0.0001, 0, 0, 88.9, 27.41)",
            [_REAL_UNC],
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


# --- status / availability -------------------------------------------------


def test_status_unavailable_without_db_path(monkeypatch) -> None:
    monkeypatch.setattr(mosaics, "DB_PATH", "")
    result = mosaics.mosaics_status()
    assert result["available"] is False


def test_status_unavailable_with_missing_file(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(mosaics, "DB_PATH", str(tmp_path / "nope.duckdb"))
    result = mosaics.mosaics_status()
    assert result["available"] is False


@requires_duckdb
def test_status_available_with_real_db(db_path: Path) -> None:
    assert mosaics.mosaics_status()["available"] is True


def test_endpoints_require_db_when_unset(monkeypatch) -> None:
    monkeypatch.setattr(mosaics, "DB_PATH", "")
    with pytest.raises(HTTPException) as exc:
        mosaics.list_locations()
    assert exc.value.status_code == 503


# --- locations / dates -------------------------------------------------


@requires_duckdb
def test_locations_filters_known_junk_rows(db_path: Path) -> None:
    names = [loc["location_name"] for loc in mosaics.list_locations()["locations"]]
    assert names == ["Real Place"]


@requires_duckdb
def test_dates_ordered_ascending_regardless_of_id(db_path: Path) -> None:
    """mosaic_id 10 is the later date, inserted first -- id order must not leak."""
    dates = [row["acquisition_date"] for row in mosaics.list_dates(1)["mosaics"]]
    assert dates == ["2024-01-01", "2024-06-01"]


# --- UNC parsing / cache paths -------------------------------------------------


def test_parse_unc_valid() -> None:
    assert mosaics._parse_unc(r"\\10.10.180.51\Nets\a\b\c.png") == (
        "10.10.180.51",
        "Nets",
        "a/b/c.png",
    )


def test_parse_unc_rejects_non_unc_path() -> None:
    with pytest.raises(ValueError):
        mosaics._parse_unc("/not/a/unc/path.png")


def test_png_cache_path_is_stable_and_readable(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(mosaics, "PNG_CACHE_DIR", tmp_path / "png")
    first = mosaics._png_cache_path(_REAL_UNC)
    second = mosaics._png_cache_path(_REAL_UNC)
    assert first == second
    assert first.name.endswith("mosaic_2024-06-01_zoom15.png")


# --- PNG resolution: mount -> cache -> SMB -------------------------------------------------


def test_resolve_png_prefers_local_mount(monkeypatch, tmp_path: Path) -> None:
    mount = tmp_path / "mount"
    target = mount / "Tiles" / "Real Place" / "mosaics" / "mosaic_2024-06-01_zoom15.png"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"ON-MOUNT")
    monkeypatch.setattr(mosaics, "MOUNT", mount)

    def _boom(unc: str) -> bytes:
        raise AssertionError("must not fall through to SMB when the mount has the file")

    monkeypatch.setattr(mosaics, "_fetch_via_smb", _boom)
    assert mosaics._resolve_png(_REAL_UNC) == target


def test_resolve_png_falls_back_to_disk_cache(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(mosaics, "MOUNT", tmp_path / "no-such-mount")
    monkeypatch.setattr(mosaics, "PNG_CACHE_DIR", tmp_path / "png-cache")
    cached = mosaics._png_cache_path(_REAL_UNC)
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"CACHED")

    def _boom(unc: str) -> bytes:
        raise AssertionError("must not fall through to SMB when already cached")

    monkeypatch.setattr(mosaics, "_fetch_via_smb", _boom)
    assert mosaics._resolve_png(_REAL_UNC) == cached


def test_resolve_png_fetches_via_smb_then_caches(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(mosaics, "MOUNT", tmp_path / "no-such-mount")
    monkeypatch.setattr(mosaics, "PNG_CACHE_DIR", tmp_path / "png-cache")
    monkeypatch.setattr(mosaics, "_fetch_via_smb", lambda unc: b"FROM-SMB")

    resolved = mosaics._resolve_png(_REAL_UNC)
    assert resolved.read_bytes() == b"FROM-SMB"

    # A second resolution must be served from the now-populated cache, not SMB again.
    def _boom(unc: str) -> bytes:
        raise AssertionError("second resolution must be served from cache")

    monkeypatch.setattr(mosaics, "_fetch_via_smb", _boom)
    assert mosaics._resolve_png(_REAL_UNC).read_bytes() == b"FROM-SMB"


def test_fetch_via_smb_without_credentials_raises_502(monkeypatch) -> None:
    monkeypatch.setattr(mosaics, "SMB_USER", "")
    with pytest.raises(HTTPException) as exc:
        mosaics._fetch_via_smb(_REAL_UNC)
    assert exc.value.status_code == 502


# --- PNG + geotransform -> COG -------------------------------------------------


@requires_raster_stack
def test_build_cog_is_valid_and_georeferenced(monkeypatch, tmp_path: Path) -> None:
    import numpy as np
    import rasterio
    from PIL import Image
    from rio_cogeo.cogeo import cog_validate

    monkeypatch.setattr(mosaics, "COG_CACHE_DIR", tmp_path / "cog-cache")
    png_path = tmp_path / "source.png"
    array = (np.random.rand(80, 100, 3) * 255).astype("uint8")
    Image.fromarray(array).save(png_path)

    geotransform = {
        "top_left_x": 88.95,
        "pixel_size_x": 0.0001,
        "rotation_x": 0.0,
        "top_left_y": 27.42,
        "rotation_y": 0.0,
        "pixel_size_y": -0.0001,
    }
    cog_path = mosaics._build_cog(123, png_path, geotransform)

    ok, errors, _warnings = cog_validate(str(cog_path))
    assert ok, errors
    with rasterio.open(cog_path) as src:
        assert src.crs.to_epsg() == 4326
        assert src.bounds.left == pytest.approx(88.95)
        assert src.bounds.top == pytest.approx(27.42)
        assert src.bounds.right == pytest.approx(88.95 + 100 * 0.0001)
        assert src.bounds.bottom == pytest.approx(27.42 - 80 * 0.0001)


@requires_raster_stack
@requires_duckdb
def test_get_mosaic_cog_serves_cached_file_without_touching_nas(
    monkeypatch, tmp_path: Path, db_path: Path
) -> None:
    monkeypatch.setattr(mosaics, "COG_CACHE_DIR", tmp_path / "cog-cache")
    cached = mosaics._cog_cache_path(10)
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"FAKE-COG")

    def _boom(unc: str) -> bytes:
        raise AssertionError("must not fetch from the NAS when a cached COG exists")

    monkeypatch.setattr(mosaics, "_fetch_via_smb", _boom)
    response = mosaics.get_mosaic_cog(10)
    assert Path(response.path) == cached


@requires_duckdb
def test_get_mosaic_cog_missing_id_returns_404(monkeypatch, tmp_path: Path, db_path: Path) -> None:
    monkeypatch.setattr(mosaics, "COG_CACHE_DIR", tmp_path / "cog-cache")
    with pytest.raises(HTTPException) as exc:
        mosaics.get_mosaic_cog(999999)
    assert exc.value.status_code == 404


@requires_raster_stack
@requires_duckdb
def test_get_mosaic_bbox_matches_the_built_cog(monkeypatch, tmp_path: Path, db_path: Path) -> None:
    monkeypatch.setattr(mosaics, "COG_CACHE_DIR", tmp_path / "cog-cache")
    monkeypatch.setattr(mosaics, "MOUNT", tmp_path / "no-such-mount")
    monkeypatch.setattr(mosaics, "PNG_CACHE_DIR", tmp_path / "png-cache")

    import numpy as np
    from PIL import Image

    array = (np.random.rand(80, 100, 3) * 255).astype("uint8")
    png_bytes_path = tmp_path / "fake.png"
    Image.fromarray(array).save(png_bytes_path)
    monkeypatch.setattr(mosaics, "_fetch_via_smb", lambda unc: png_bytes_path.read_bytes())

    bbox = mosaics.get_mosaic_bbox(10)
    assert bbox["mosaic_id"] == 10
    assert bbox["west"] == pytest.approx(88.9)
    assert bbox["north"] == pytest.approx(27.41)
    assert bbox["east"] == pytest.approx(88.9 + 100 * 0.0001)
    assert bbox["south"] == pytest.approx(27.41 - 80 * 0.0001)

    # A second call must reuse the now-cached COG rather than fetching again.
    def _boom(unc: str) -> bytes:
        raise AssertionError("bbox must reuse the cached COG on a second request")

    monkeypatch.setattr(mosaics, "_fetch_via_smb", _boom)
    assert mosaics.get_mosaic_bbox(10) == bbox


@requires_duckdb
def test_get_mosaic_bbox_missing_id_returns_404(monkeypatch, tmp_path: Path, db_path: Path) -> None:
    monkeypatch.setattr(mosaics, "COG_CACHE_DIR", tmp_path / "cog-cache")
    with pytest.raises(HTTPException) as exc:
        mosaics.get_mosaic_bbox(999999)
    assert exc.value.status_code == 404


# --- pixel dimensions / same-size grouping -------------------------------------------------

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _fake_png_header(width: int, height: int) -> bytes:
    """A byte-accurate PNG signature + IHDR chunk (only the fields _parse_png_dimensions reads)."""
    import struct

    return _PNG_SIGNATURE + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height)


def test_parse_png_dimensions_valid_and_invalid() -> None:
    assert mosaics._parse_png_dimensions(_fake_png_header(768, 1024)) == (768, 1024)
    assert mosaics._parse_png_dimensions(b"not a png") is None
    assert mosaics._parse_png_dimensions(_PNG_SIGNATURE) is None  # too short


def test_read_png_dimensions_prefers_mount(monkeypatch, tmp_path: Path) -> None:
    mount = tmp_path / "mount"
    target = mount / "Tiles" / "Real Place" / "mosaics" / "mosaic_2024-06-01_zoom15.png"
    target.parent.mkdir(parents=True)
    target.write_bytes(_fake_png_header(1280, 1536) + b"...rest of file ignored...")
    monkeypatch.setattr(mosaics, "MOUNT", mount)
    assert mosaics._read_png_dimensions(_REAL_UNC) == (1280, 1536)


@requires_duckdb
def test_get_mosaic_sizes_groups_by_dimensions_and_caches(
    monkeypatch, tmp_path: Path, db_path: Path
) -> None:
    monkeypatch.setattr(mosaics, "_dimensions_cache", None)
    monkeypatch.setattr(mosaics, "CACHE_ROOT", tmp_path / "cache")
    mount = tmp_path / "mount"
    monkeypatch.setattr(mosaics, "MOUNT", mount)

    # mosaic 10 (2024-06-01) and mosaic 9 (2024-01-01) from the db_path fixture,
    # given different pixel sizes so they land in separate groups.
    for unc, size in (
        (_REAL_UNC, (768, 768)),
        (
            r"\\10.10.180.51\Nets\Tiles\Real Place\mosaics\mosaic_2024-01-01_zoom15.png",
            (1024, 1024),
        ),
    ):
        path = mosaics._unc_to_mount_path(unc)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_fake_png_header(*size))

    result = mosaics.get_mosaic_sizes(1)
    sizes = {(entry["width"], entry["height"]): entry for entry in result["sizes"]}
    assert sizes[(768, 768)]["mosaic_ids"] == [10]
    assert sizes[(1024, 1024)]["mosaic_ids"] == [9]
    assert (tmp_path / "cache" / "dimensions.json").is_file()

    # Remove the mounted files entirely -- a second call must be served from
    # the persistent cache, not re-read the (now-missing) files.
    for child in mount.rglob("*.png"):
        child.unlink()
    cached_again = mosaics.get_mosaic_sizes(1)
    assert cached_again == result
