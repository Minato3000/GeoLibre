"""Satellite mosaic sidecar endpoints (DuckDB metadata + NAS fetch + on-demand COG).

Backs a location + date picker: the desktop app queries a location's available
acquisition dates, then requests the mosaic for one as a georeferenced
Cloud-Optimized GeoTIFF, which is rendered through the existing COG raster
pipeline (``@geoint/plugins``' ``maplibre-raster.ts``) unchanged.

The mosaic metadata (per-location, per-date rows with a GDAL-style geotransform)
lives in a local, read-only DuckDB file pointed to by ``GEOINT_MOSAIC_DB_PATH``.
That file never stores image bytes, only a Windows UNC path to a PNG on a NAS
share reachable over SMB. Resolving a path mirrors the reference debug tool
(``tools/mosaic_viewer/app.py`` in the source project) in three tiers: a local
CIFS mount (fastest, no credentials needed in this container), a disk cache of
a prior SMB fetch, then a fresh SMB fetch via ``smbclient``.

``duckdb`` is required for every endpoint here (the whole feature is DB-backed);
``rasterio``/``rio-cogeo``/Pillow are only needed to build a COG the first time
a given mosaic is requested — after that the COG is served straight from cache
and the raster runtime is never touched again for that mosaic. Both dependency
groups are optional sidecar extras (the ``mosaics`` extra installs all four),
so ``/mosaics/status`` reports what is actually available rather than the
endpoints throwing an unhandled ImportError.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import struct
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .vector import _atomic_write

router = APIRouter(prefix="/mosaics", tags=["mosaics"])
logger = logging.getLogger(__name__)

DB_PATH = os.environ.get("GEOINT_MOSAIC_DB_PATH", "").strip()
MOUNT = Path(os.environ.get("GEOINT_MOSAIC_MOUNT", "/mnt/satellite_nets"))
CACHE_ROOT = Path(os.environ.get("GEOINT_MOSAIC_CACHE", "/var/cache/geoint-mosaics"))
PNG_CACHE_DIR = CACHE_ROOT / "png"
COG_CACHE_DIR = CACHE_ROOT / "cog"

SMB_USER = os.environ.get("GEOINT_MOSAIC_SMB_USER", "").strip()
SMB_PASSWORD = os.environ.get("GEOINT_MOSAIC_SMB_PASSWORD", "")
SMB_DOMAIN = os.environ.get("GEOINT_MOSAIC_SMB_DOMAIN", "").strip() or None

# A handful of rows in the source data are known junk (an accidental shortcut
# file, a stray Thumbs.db, a mistyped entry) that all share center = (0, 0).
# Filtering them here keeps every caller (locations list, future search) from
# having to know about this upstream data-quality issue.
_JUNK_LOCATION_FILTER = (
    "center_lat <> 0 AND center_lon <> 0"
    " AND location_name NOT ILIKE '%thumbs%' AND location_name NOT ILIKE '%.lnk%'"
)

_spatial_extension_loaded = False


def duckdb_import_error() -> Optional[str]:
    """Return the duckdb import error message, or None if it imports cleanly."""
    try:
        import duckdb  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)
    return None


def raster_import_error() -> Optional[str]:
    """Return the raster-stack import error message, or None if all import cleanly.

    Only needed to *build* a COG; already-cached mosaics never touch this.
    """
    try:
        import rasterio  # noqa: F401
        import rio_cogeo  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)
    return None


def _db_ready() -> bool:
    return bool(DB_PATH) and Path(DB_PATH).is_file() and duckdb_import_error() is None


def _connect() -> Any:
    """Open a fresh read-only DuckDB connection with the spatial extension loaded."""
    import duckdb

    global _spatial_extension_loaded
    conn = duckdb.connect(DB_PATH, read_only=True)
    if not _spatial_extension_loaded:
        conn.execute("INSTALL spatial")
        _spatial_extension_loaded = True
    conn.execute("LOAD spatial")
    return conn


def _require_db() -> None:
    if not DB_PATH:
        raise HTTPException(
            status_code=503,
            detail="GEOINT_MOSAIC_DB_PATH is not set; the mosaic feature is disabled.",
        )
    if not Path(DB_PATH).is_file():
        raise HTTPException(status_code=503, detail=f"Mosaic database not found: {DB_PATH}")
    import_error = duckdb_import_error()
    if import_error is not None:
        raise HTTPException(
            status_code=503, detail=f"duckdb is not installed in the sidecar: {import_error}"
        )


@router.get("/status")
def mosaics_status() -> dict[str, Any]:
    """Report mosaic-feature availability so the panel can disable itself gracefully."""
    db_ready = _db_ready()
    raster_error = raster_import_error()
    return {
        "available": db_ready,
        "db_path": DB_PATH or None,
        "raster_available": raster_error is None,
        "mount_available": MOUNT.is_dir(),
        "smb_configured": bool(SMB_USER),
        "message": (
            "Mosaic database is available."
            if db_ready
            else "GEOINT_MOSAIC_DB_PATH is not set or the file is missing."
        ),
    }


@router.get("/locations")
def list_locations() -> dict[str, Any]:
    """List the valid mosaic locations (junk rows filtered), with a mosaic count each."""
    _require_db()
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT l.location_id, l.location_name, l.center_lat, l.center_lon,
                   l.radius_m, COUNT(m.mosaic_id) AS mosaic_count
            FROM locations l
            LEFT JOIN mosaics m ON m.location_id = l.location_id
            WHERE {_JUNK_LOCATION_FILTER}
            GROUP BY l.location_id, l.location_name, l.center_lat, l.center_lon, l.radius_m
            ORDER BY l.location_name
            """
        ).fetchall()
    return {
        "locations": [
            {
                "location_id": row[0],
                "location_name": row[1],
                "center_lat": row[2],
                "center_lon": row[3],
                "radius_m": row[4],
                "mosaic_count": row[5],
            }
            for row in rows
        ]
    }


@router.get("/dates")
def list_dates(location_id: int) -> dict[str, Any]:
    """List a location's mosaics ordered by acquisition date."""
    _require_db()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT mosaic_id, mosaic_no, acquisition_date
            FROM mosaics
            WHERE location_id = ?
            ORDER BY acquisition_date ASC
            """,
            (location_id,),
        ).fetchall()
    return {
        "location_id": location_id,
        "mosaics": [
            {"mosaic_id": row[0], "mosaic_no": row[1], "acquisition_date": str(row[2])}
            for row in rows
        ],
    }


# --- UNC path resolution (mount -> disk cache -> SMB), ported from the source
# project's tools/mosaic_viewer/app.py -----------------------------------


def _parse_unc(unc: str) -> tuple[str, str, str]:
    """``\\\\host\\share\\rest\\file.png`` -> (host, share, "rest/file.png")."""
    normalized = (unc or "").strip().replace("\\", "/")
    if not normalized.startswith("//"):
        raise ValueError(f"Not a UNC path: {unc!r}")
    parts = normalized.lstrip("/").split("/", 2)
    if len(parts) < 3:
        raise ValueError(f"UNC path missing share/file: {unc!r}")
    host, share, rel = parts
    return host, share, rel


def _unc_to_mount_path(unc: str) -> Path:
    _, _, rel = _parse_unc(unc)
    return MOUNT / rel


def _png_cache_path(unc: str) -> Path:
    digest = hashlib.sha1(unc.encode("utf-8")).hexdigest()[:16]
    try:
        name = Path(_parse_unc(unc)[2]).name
    except ValueError:
        name = "mosaic.png"
    if not name.lower().endswith(".png"):
        name += ".png"
    return PNG_CACHE_DIR / f"{digest}_{name}"


_smb_sessions: set[str] = set()


def _ensure_smb_session(smbclient: Any, host: str) -> None:
    if host in _smb_sessions:
        return
    smbclient.register_session(
        host,
        username=SMB_USER,
        password=SMB_PASSWORD,
        **({"domain": SMB_DOMAIN} if SMB_DOMAIN else {}),
    )
    _smb_sessions.add(host)


def _fetch_via_smb(unc: str) -> bytes:
    if not SMB_USER:
        raise HTTPException(
            status_code=502,
            detail=(
                "Mosaic is not on the local mount and no SMB credentials are configured "
                "(GEOINT_MOSAIC_SMB_USER / GEOINT_MOSAIC_SMB_PASSWORD)."
            ),
        )
    try:
        import smbclient
    except Exception as exc:  # noqa: BLE001 - surface a stable, actionable error
        raise HTTPException(
            status_code=503, detail=f"smbclient is not installed in the sidecar: {exc}"
        ) from exc

    host, share, rel = _parse_unc(unc)
    _ensure_smb_session(smbclient, host)

    try:
        with smbclient.open_file(f"//{host}/{share}/{rel}", mode="rb") as remote:
            data = remote.read()
    except Exception as exc:  # noqa: BLE001 - surface a stable, actionable error
        raise HTTPException(status_code=502, detail=f"SMB fetch failed: {exc}") from exc
    if not data:
        raise HTTPException(status_code=502, detail="SMB read returned an empty file.")
    return data


def _resolve_png(unc: str) -> Path:
    """Resolve a mosaic's UNC path to a local PNG: mount -> disk cache -> SMB fetch."""
    mounted = _unc_to_mount_path(unc)
    if mounted.is_file():
        return mounted

    cached = _png_cache_path(unc)
    if cached.is_file() and cached.stat().st_size > 0:
        return cached

    data = _fetch_via_smb(unc)
    PNG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write(cached, lambda tmp: tmp.write_bytes(data))
    return cached


# --- Pixel dimensions (for grouping a location's timeline by image size) --
#
# Verified against the real DuckDB file: pixel_size_x is an identical Web
# Mercator zoom-15 constant everywhere, pixel_size_y varies only by ~1e-9
# per location (latitude jitter, not real size differences), radius_m and
# zoom_level are constant across the whole table, and there is no bottom-right
# corner column -- so width/height cannot be derived from the geotransform and
# genuinely must be read from each PNG (confirmed real dimensions vary, e.g.
# 768x768 vs 1024x1024 vs 1280x1536, presumably from a varying number of
# stitched source tiles per acquisition).
#
# A PNG's dimensions live in the first IHDR chunk, 24 bytes into the file, so
# probing every mosaic for a location needs only a tiny partial read rather
# than a full fetch (average full mosaic PNG is ~1.2MB; 300+ of those just to
# show a size-filter picker would hammer the NAS for no reason). Results are
# cached persistently by mosaic_id so a location's sizes are computed once.

_DIMENSIONS_CACHE_FILE = "dimensions.json"
_dimensions_cache: Optional[dict[str, list[int]]] = None


def _load_dimensions_cache() -> dict[str, list[int]]:
    global _dimensions_cache
    if _dimensions_cache is None:
        path = CACHE_ROOT / _DIMENSIONS_CACHE_FILE
        try:
            _dimensions_cache = json.loads(path.read_text())
        except (OSError, ValueError):
            _dimensions_cache = {}
    return _dimensions_cache


def _save_dimensions_cache() -> None:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    path = CACHE_ROOT / _DIMENSIONS_CACHE_FILE
    _atomic_write(path, lambda tmp: tmp.write_text(json.dumps(_dimensions_cache)))


def _parse_png_dimensions(header: bytes) -> Optional[tuple[int, int]]:
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def _read_png_dimensions(unc: str) -> Optional[tuple[int, int]]:
    """Read a mosaic PNG's pixel dimensions via a ~24-byte partial read.

    Tries the local mount, then the on-disk PNG cache (both cheap local
    reads), then a partial SMB read -- never a full fetch just for this.
    """
    mounted = _unc_to_mount_path(unc)
    if mounted.is_file():
        with mounted.open("rb") as f:
            return _parse_png_dimensions(f.read(24))

    cached = _png_cache_path(unc)
    if cached.is_file():
        with cached.open("rb") as f:
            return _parse_png_dimensions(f.read(24))

    if not SMB_USER:
        return None
    try:
        import smbclient

        host, share, rel = _parse_unc(unc)
        _ensure_smb_session(smbclient, host)
        with smbclient.open_file(f"//{host}/{share}/{rel}", mode="rb") as remote:
            header = remote.read(24)
        return _parse_png_dimensions(header)
    except Exception:  # noqa: BLE001 - a size probe failure just excludes that mosaic
        logger.debug("Could not read PNG dimensions for %s", unc, exc_info=True)
        return None


@router.get("/sizes")
def get_mosaic_sizes(location_id: int) -> dict[str, Any]:
    """Group a location's mosaics by pixel dimensions, for a same-size filter.

    Each group lists the matching mosaic ids and a count, so the frontend can
    offer "768x768 (240)" / "1024x1024 (80)" style choices and filter the
    timeline down to a single consistent size.
    """
    _require_db()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT mosaic_id, mosaic_path FROM mosaics WHERE location_id = ?",
            (location_id,),
        ).fetchall()

    cache = _load_dimensions_cache()
    dirty = False
    groups: dict[tuple[int, int], list[int]] = {}
    for mosaic_id, mosaic_path in rows:
        key = str(mosaic_id)
        dims = cache.get(key)
        if dims is None:
            resolved = _read_png_dimensions(mosaic_path)
            if resolved is None:
                continue
            dims = list(resolved)
            cache[key] = dims
            dirty = True
        groups.setdefault((dims[0], dims[1]), []).append(mosaic_id)

    if dirty:
        _save_dimensions_cache()

    return {
        "location_id": location_id,
        "sizes": [
            {"width": width, "height": height, "mosaic_ids": sorted(ids), "count": len(ids)}
            for (width, height), ids in sorted(groups.items(), key=lambda kv: -len(kv[1]))
        ],
    }


# --- PNG + geotransform -> COG --------------------------------------------


def _cog_cache_path(mosaic_id: int) -> Path:
    return COG_CACHE_DIR / f"{mosaic_id}.tif"


def _build_cog(mosaic_id: int, png_path: Path, geotransform: dict[str, float]) -> Path:
    """Wrap a mosaic PNG with its stored geotransform and write a cached COG.

    The mosaics table stores a standard GDAL 6-parameter geotransform (WGS84,
    degrees/pixel) split across ``top_left_x/y``, ``pixel_size_x/y`` and
    ``rotation_x/y`` columns; ``Affine.from_gdal`` takes exactly that tuple.
    """
    import numpy as np
    import rasterio
    from affine import Affine
    from PIL import Image
    from rio_cogeo.cogeo import cog_translate
    from rio_cogeo.profiles import cog_profiles

    with Image.open(png_path) as img:
        array = np.array(img.convert("RGB"))
    height, width, bands = array.shape

    transform = Affine.from_gdal(
        geotransform["top_left_x"],
        geotransform["pixel_size_x"],
        geotransform["rotation_x"],
        geotransform["top_left_y"],
        geotransform["rotation_y"],
        geotransform["pixel_size_y"],
    )

    dest = _cog_cache_path(mosaic_id)
    COG_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _write(tmp: Path) -> None:
        with rasterio.MemoryFile() as mem:
            with mem.open(
                driver="GTiff",
                height=height,
                width=width,
                count=bands,
                dtype=array.dtype,
                crs="EPSG:4326",
                transform=transform,
            ) as src:
                for band in range(bands):
                    src.write(array[:, :, band], band + 1)
            cog_translate(mem, str(tmp), cog_profiles.get("deflate"), in_memory=True, quiet=True)

    _atomic_write(dest, _write)
    return dest


def _ensure_cog(mosaic_id: int) -> Path:
    """Return the cached COG path for a mosaic, building it on first request."""
    cached_cog = _cog_cache_path(mosaic_id)
    if cached_cog.is_file():
        return cached_cog

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT mosaic_path, pixel_size_x, pixel_size_y, rotation_x, rotation_y,
                   top_left_x, top_left_y
            FROM mosaics WHERE mosaic_id = ?
            """,
            (mosaic_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No mosaic with id {mosaic_id}")

    raster_error = raster_import_error()
    if raster_error is not None:
        raise HTTPException(
            status_code=503,
            detail=f"Raster runtime (rasterio/rio-cogeo/Pillow) is not installed: {raster_error}",
        )

    mosaic_path, pixel_size_x, pixel_size_y, rotation_x, rotation_y, top_left_x, top_left_y = row
    try:
        png_path = _resolve_png(mosaic_path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid mosaic path: {exc}") from exc

    return _build_cog(
        mosaic_id,
        png_path,
        {
            "pixel_size_x": pixel_size_x,
            "pixel_size_y": pixel_size_y,
            "rotation_x": rotation_x,
            "rotation_y": rotation_y,
            "top_left_x": top_left_x,
            "top_left_y": top_left_y,
        },
    )


@router.get("/cog/{mosaic_id}")
def get_mosaic_cog(mosaic_id: int) -> FileResponse:
    """Serve a mosaic as a georeferenced COG, building and caching it on first request."""
    _require_db()
    return FileResponse(_ensure_cog(mosaic_id), media_type="image/tiff")


@router.get("/bbox/{mosaic_id}")
def get_mosaic_bbox(mosaic_id: int) -> dict[str, Any]:
    """Return a mosaic's footprint (WGS84 bounds), for a client-side highlight mask.

    Reuses whatever COG is already cached for this mosaic (building one if this
    is the first request for it, same as `/cog`) rather than recomputing the
    footprint separately, so the two endpoints can never disagree.
    """
    _require_db()
    cog_path = _ensure_cog(mosaic_id)

    import rasterio

    with rasterio.open(cog_path) as src:
        west, south, east, north = src.bounds
    return {"mosaic_id": mosaic_id, "west": west, "south": south, "east": east, "north": north}
