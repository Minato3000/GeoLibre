import { useAppStore } from "@geoint/core";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { GeoIntAppAPI, GeoIntPlugin } from "../types";

export const MOSAIC_TIMELINE_PLUGIN_ID = "geoint-mosaic-timeline";
const PANEL_ID = MOSAIC_TIMELINE_PLUGIN_ID;

// The "spotlight" mask (a world polygon with the mosaic footprint cut out as a
// hole) is a plain MapLibre source/layer added directly via getMap(), the same
// pattern maplibre-stac uses for its selection highlight -- it is a transient
// interaction overlay, not data, so it deliberately stays off the Layers panel.
// It is created once and updated in place via source.setData() from then on
// (never removed/re-added), so it never flickers between selections.
const MASK_SOURCE = "geoint-mosaic-timeline-mask";
const MASK_FILL = "geoint-mosaic-timeline-mask-fill";
// A drop-shadow-like frame around the mosaic's edge, same update-in-place
// treatment as the mask above (see ensureMask/updateMask).
const MASK_SHADOW_SOURCE = "geoint-mosaic-timeline-shadow";
const MASK_SHADOW_BLUR = "geoint-mosaic-timeline-shadow-blur";
const MASK_SHADOW_EDGE = "geoint-mosaic-timeline-shadow-edge";

const EMPTY_GEOJSON = { type: "FeatureCollection" as const, features: [] };

// Crossfade duration between one mosaic frame and the next.
const CROSSFADE_MS = 350;
const CROSSFADE_STEPS = 12;
// Debounce for dragging the timeline slider, so a fast drag fires one
// mosaic/bbox fetch instead of one per intermediate value.
const SCRUB_DEBOUNCE_MS = 150;

const FPS_OPTIONS = [0.5, 1, 2, 4, 8] as const;
const DEFAULT_FPS = 1;

interface MosaicLocation {
  location_id: number;
  location_name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  mosaic_count: number;
}

interface MosaicDateEntry {
  mosaic_id: number;
  mosaic_no: number;
  acquisition_date: string;
}

interface MosaicStatus {
  available: boolean;
  message: string;
}

interface MosaicBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface MosaicSizeGroup {
  width: number;
  height: number;
  mosaic_ids: number[];
  count: number;
}

/**
 * User-facing strings for the panel. This package is framework-agnostic and
 * cannot call react-i18next's `t()` directly (the pattern used by
 * `maplibre-stac`/`maplibre-graticule`); English defaults only for now.
 */
interface MosaicTimelineLabels {
  title: string;
  locationLabel: string;
  searchPlaceholder: string;
  noMatchingLocations: string;
  loadingLocations: string;
  dateLabel: string;
  selectLocationFirst: string;
  loadingDates: string;
  noDatesForLocation: string;
  chooseLocation: string;
  datesFailed: string;
  unavailable: string;
  cogUnsupported: string;
  addFailed: string;
  play: string;
  pause: string;
  fpsLabel: string;
  sizeLabel: string;
  allSizes: (count: number) => string;
  sizeOption: (width: number, height: number, count: number) => string;
  adding: (label: string) => string;
  added: (label: string) => string;
}

const labels: MosaicTimelineLabels = {
  title: "Mosaic Timeline",
  locationLabel: "Location",
  searchPlaceholder: "Search locations…",
  noMatchingLocations: "No matching locations",
  loadingLocations: "Loading locations…",
  dateLabel: "Timeline",
  selectLocationFirst: "Choose a location to see its timeline",
  loadingDates: "Loading dates…",
  noDatesForLocation: "No mosaics for this location",
  chooseLocation: "Choose a location.",
  datesFailed: "Could not load dates for this location",
  unavailable: "Satellite mosaic database is not configured on this server.",
  cogUnsupported: "This GeoInt host cannot visualize remote GeoTIFF assets",
  addFailed: "Could not load the mosaic",
  play: "Play",
  pause: "Pause",
  fpsLabel: "FPS",
  sizeLabel: "Image size",
  allSizes: (count) => `All sizes (${count})`,
  sizeOption: (width, height, count) => `${width}×${height} (${count})`,
  adding: (label) => `Loading ${label}…`,
  added: (label) => `Showing ${label}.`,
};

/**
 * Resolve the sidecar base URL the same way `@geoint/processing`'s
 * sidecar-client does. Duplicated rather than imported: no other
 * `packages/plugins` plugin talks to the GeoInt Python sidecar today (every
 * sidecar-backed feature -- Vector/Raster tools, PostGIS, SQL Workspace -- is
 * an app-level dialog in `apps/geolibre-desktop`, not a plugin), so adding
 * that cross-package dependency for one small helper was not worth it.
 *
 * Note: unlike the app's sidecar client, this does not attach the per-launch
 * `X-GeoInt-Token`, which the Docker/web deployment's nginx `/sidecar` proxy
 * injects server-side (the browser never holds it there). A future Tauri
 * desktop build of this feature would need the token threaded through
 * `GeoIntAppAPI`, which does not currently expose it to plugins.
 */
function resolveSidecarBaseUrl(): string {
  if (typeof window === "undefined" || !window.location) return "http://127.0.0.1:8765";
  const { protocol, hostname, port, origin } = window.location;
  const isTauri = protocol === "tauri:" || hostname === "tauri.localhost";
  const isViteDev = port === "5173";
  if (!isTauri && !isViteDev && (protocol === "http:" || protocol === "https:")) {
    return `${origin}/sidecar`;
  }
  return "http://127.0.0.1:8765";
}

async function fetchMosaicJson<T>(path: string): Promise<T> {
  const res = await fetch(`${resolveSidecarBaseUrl()}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function mosaicCogUrl(mosaicId: number): string {
  return `${resolveSidecarBaseUrl()}/mosaics/cog/${mosaicId}`;
}

/**
 * A zoom level (Web Mercator, clamped to [8, 17]) that frames a circular AOI
 * of the given radius with some padding, at the given latitude (tile size in
 * meters/pixel shrinks with cos(latitude)).
 */
function zoomForRadius(radiusM: number, latitudeDeg: number): number {
  const metersPerPixelAtZoom0 = 156543.03392 * Math.cos((latitudeDeg * Math.PI) / 180);
  const targetMetersPerPixel = (radiusM * 2.4) / 480; // ~480px pane, some padding
  const zoom = Math.log2(metersPerPixelAtZoom0 / targetMetersPerPixel);
  return Math.min(17, Math.max(8, zoom));
}

/** A world rectangle with the mosaic's bbox cut out as a hole (RFC 7946 winding). */
function maskGeoJson(bbox: MosaicBbox) {
  const { west, south, east, north } = bbox;
  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        // Exterior ring (the whole world), counterclockwise.
        [
          [-180, -90],
          [180, -90],
          [180, 90],
          [-180, 90],
          [-180, -90],
        ],
        // Interior ring (the hole = the mosaic footprint), clockwise.
        [
          [west, south],
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      ],
    },
  };
}

/** Just the bbox rectangle (no world exterior ring), for the shadow/border line layers. */
function bboxLineGeoJson(bbox: MosaicBbox) {
  const { west, south, east, north } = bbox;
  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

/** Create the mask source/layers once; safe to call repeatedly (no-ops if already present). */
function ensureMask(map: MapLibreMap | null | undefined): void {
  if (!map) return;
  if (!map.getSource(MASK_SOURCE)) {
    map.addSource(MASK_SOURCE, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: MASK_FILL,
      type: "fill",
      source: MASK_SOURCE,
      paint: {
        "fill-color": "#000000",
        // "a slight one": a subtle dim, not a heavy spotlight cutout.
        "fill-opacity": 0.28,
      },
    });
  }
  if (!map.getSource(MASK_SHADOW_SOURCE)) {
    map.addSource(MASK_SHADOW_SOURCE, { type: "geojson", data: EMPTY_GEOJSON });
    // MapLibre has no drop-shadow paint property for fill/raster layers, so this
    // approximates one with two stacked line layers around the mosaic's edge: a
    // wide, blurred, low-opacity line (the soft shadow) under a thin crisp one
    // (a defining edge), both traced along just the bbox rectangle. The blur
    // layer is intentionally wide with a low opacity per pixel so the shadow
    // reads as a soft spread rather than a hard, dark band.
    map.addLayer({
      id: MASK_SHADOW_BLUR,
      type: "line",
      source: MASK_SHADOW_SOURCE,
      paint: {
        "line-color": "#000000",
        "line-width": 26,
        "line-blur": 18,
        "line-opacity": 0.3,
      },
    });
    map.addLayer({
      id: MASK_SHADOW_EDGE,
      type: "line",
      source: MASK_SHADOW_SOURCE,
      paint: {
        "line-color": "#000000",
        "line-width": 1.5,
        "line-opacity": 0.55,
      },
    });
  }
}

/** Update the mask's shape in place -- never removes/re-adds the layers, so it never flickers. */
function updateMask(map: MapLibreMap | null | undefined, bbox: MosaicBbox | null): void {
  if (!map) return;
  ensureMask(map);
  const maskSource = map.getSource(MASK_SOURCE) as GeoJSONSource | undefined;
  maskSource?.setData(bbox ? maskGeoJson(bbox) : EMPTY_GEOJSON);
  const shadowSource = map.getSource(MASK_SHADOW_SOURCE) as GeoJSONSource | undefined;
  shadowSource?.setData(bbox ? bboxLineGeoJson(bbox) : EMPTY_GEOJSON);
}

function removeMask(map: MapLibreMap | null | undefined): void {
  if (!map) return;
  if (map.getLayer(MASK_FILL)) map.removeLayer(MASK_FILL);
  if (map.getSource(MASK_SOURCE)) map.removeSource(MASK_SOURCE);
  if (map.getLayer(MASK_SHADOW_BLUR)) map.removeLayer(MASK_SHADOW_BLUR);
  if (map.getLayer(MASK_SHADOW_EDGE)) map.removeLayer(MASK_SHADOW_EDGE);
  if (map.getSource(MASK_SHADOW_SOURCE)) map.removeSource(MASK_SHADOW_SOURCE);
}

interface MosaicSelection {
  locationId: number;
  mosaicId: number;
}

let appRef: GeoIntAppAPI | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
// Raster sources cannot have their URL swapped in place (packages/map's
// syncRasterTileLayer only calls addSource when the source does not already
// exist), so picking a new date always adds a fresh layer. Rather than
// removing the previous one immediately, up to MAX_ACTIVE_LAYERS stay on the
// map/Layers panel at once (oldest-first eviction) so a short trailing window
// of recent frames remains inspectable during playback; the newest one fades
// in on top of the stack instead of popping in abruptly.
const MAX_ACTIVE_LAYERS = 5;
let activeLayerIds: string[] = [];
let currentSelection: MosaicSelection | null = null;

/** Track a newly added layer, evicting the oldest once more than MAX_ACTIVE_LAYERS are active. */
function pushActiveLayer(layerId: string): void {
  activeLayerIds.push(layerId);
  while (activeLayerIds.length > MAX_ACTIVE_LAYERS) {
    const oldest = activeLayerIds.shift();
    if (oldest) useAppStore.getState().removeLayer(oldest);
  }
}

function clearActiveLayers(): void {
  for (const id of activeLayerIds) {
    try {
      useAppStore.getState().removeLayer(id);
    } catch {
      // Already gone; ignore.
    }
  }
  activeLayerIds = [];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const style = {
  panel:
    "display:flex;flex-direction:column;gap:10px;height:100%;padding:10px;box-sizing:border-box;" +
    "font-size:12px;color:hsl(var(--foreground));overflow:auto;",
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:7px;background:hsl(var(--card));",
  label: "font-size:10px;color:hsl(var(--muted-foreground));",
  input:
    "width:100%;min-width:0;box-sizing:border-box;padding:5px 7px;border-radius:5px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));",
  status: "font-size:11px;line-height:1.4;color:hsl(var(--muted-foreground));",
  list: "display:flex;flex-direction:column;gap:2px;max-height:200px;overflow:auto;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));",
  listRow:
    "display:flex;justify-content:space-between;gap:8px;padding:5px 8px;cursor:pointer;" +
    "border-bottom:1px solid hsl(var(--border));font-size:11px;",
  listRowActive: "background:hsl(var(--accent));color:hsl(var(--accent-foreground));",
  count: "color:hsl(var(--muted-foreground));font-size:10px;",
  row: "display:flex;gap:8px;align-items:center;",
  playButton:
    "padding:5px 10px;border-radius:5px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-size:11px;",
  slider: "flex:1 1 auto;accent-color:hsl(var(--primary));",
  dateLabel: "font-size:11px;min-width:82px;text-align:right;color:hsl(var(--foreground));",
  select:
    "border-radius:5px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));padding:3px 5px;font-size:11px;",
} as const;

function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  const root = el("div");
  root.style.cssText = style.panel;

  const status = el("div", labels.chooseLocation);
  status.style.cssText = style.status;

  const locationSection = el("div");
  locationSection.style.cssText = style.section;
  const locationCaption = el("span", labels.locationLabel);
  locationCaption.style.cssText = style.label;
  const searchInput = el("input");
  searchInput.type = "text";
  searchInput.placeholder = labels.searchPlaceholder;
  searchInput.style.cssText = style.input;
  const locationList = el("div");
  locationList.style.cssText = style.list;
  locationSection.append(locationCaption, searchInput, locationList);

  const sizeSection = el("div");
  sizeSection.style.cssText = style.section;
  const sizeCaption = el("span", labels.sizeLabel);
  sizeCaption.style.cssText = style.label;
  const sizeSelect = el("select");
  sizeSelect.style.cssText = style.select + "width:100%;";
  sizeSelect.disabled = true;
  sizeSection.append(sizeCaption, sizeSelect);

  const timelineSection = el("div");
  timelineSection.style.cssText = style.section;
  const timelineCaption = el("span", labels.dateLabel);
  timelineCaption.style.cssText = style.label;
  const playRow = el("div");
  playRow.style.cssText = style.row;
  const playButton = el("button", labels.play);
  playButton.type = "button";
  playButton.style.cssText = style.playButton;
  playButton.disabled = true;
  const slider = el("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "0";
  slider.step = "1";
  slider.style.cssText = style.slider;
  slider.disabled = true;
  const dateLabel = el("span", labels.selectLocationFirst);
  dateLabel.style.cssText = style.dateLabel;
  playRow.append(playButton, slider);
  const fpsRow = el("div");
  fpsRow.style.cssText = style.row;
  const fpsCaption = el("span", labels.fpsLabel);
  fpsCaption.style.cssText = style.label;
  const fpsSelect = el("select");
  fpsSelect.style.cssText = style.select;
  for (const fps of FPS_OPTIONS) {
    const option = el("option", `${fps}`);
    option.value = String(fps);
    if (fps === DEFAULT_FPS) option.selected = true;
    fpsSelect.append(option);
  }
  fpsRow.append(fpsCaption, fpsSelect);
  timelineSection.append(timelineCaption, playRow, fpsRow, dateLabel);

  root.append(status, locationSection, sizeSection, timelineSection);
  container.append(root);

  let allLocations: MosaicLocation[] = [];
  // The full date list for the active location, and the subset currently
  // shown on the timeline (either all of it, or one same-size group).
  let locationDates: MosaicDateEntry[] = [];
  let activeDates: MosaicDateEntry[] = [];
  let activeLocationId: number | null = null;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let scrubTimer: ReturnType<typeof setTimeout> | null = null;
  let fps = DEFAULT_FPS;
  // Selection token: bumped on every new load so an in-flight crossfade from a
  // superseded request can tell it is stale and bail out instead of finishing
  // into the wrong frame.
  let loadToken = 0;
  // Bumped on every location switch, so a background /mosaics/sizes fetch
  // from a previous location (lazily loaded -- see selectLocation) that
  // resolves after the user has already moved on can tell it is stale.
  let locationToken = 0;

  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.style.color = error ? "hsl(var(--destructive))" : "";
  };

  const stopPlaying = (): void => {
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
    }
    playButton.textContent = labels.play;
  };

  const restartPlayTimer = (): void => {
    if (playTimer === null) return;
    clearInterval(playTimer);
    playTimer = setInterval(advancePlayback, 1000 / fps);
  };

  function advancePlayback(): void {
    if (!activeDates.length) return;
    const next = (Number(slider.value) + 1) % activeDates.length;
    slider.value = String(next);
    dateLabel.textContent = activeDates[next]?.acquisition_date ?? "";
    loadMosaicAt(next);
  }

  fpsSelect.addEventListener("change", () => {
    fps = Number(fpsSelect.value) || DEFAULT_FPS;
    restartPlayTimer();
  });

  const loadMosaicAt = (index: number): void => {
    const entry = activeDates[index];
    const locationId = activeLocationId;
    if (!entry || locationId === null) return;
    void addMosaicLayer(locationId, entry.mosaic_id, entry.acquisition_date);
  };

  const scheduleLoadMosaicAt = (index: number): void => {
    dateLabel.textContent = activeDates[index]?.acquisition_date ?? "";
    if (scrubTimer !== null) clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => loadMosaicAt(index), SCRUB_DEBOUNCE_MS);
  };

  slider.addEventListener("input", () => {
    stopPlaying();
    scheduleLoadMosaicAt(Number(slider.value));
  });

  playButton.addEventListener("click", () => {
    if (playTimer !== null) {
      stopPlaying();
      return;
    }
    if (!activeDates.length) return;
    playButton.textContent = labels.pause;
    playTimer = setInterval(advancePlayback, 1000 / fps);
  });

  const renderLocationRows = (filter: string): void => {
    const query = filter.trim().toLowerCase();
    const matches = query
      ? allLocations.filter((loc) => loc.location_name.toLowerCase().includes(query))
      : allLocations;
    locationList.innerHTML = "";
    if (!matches.length) {
      locationList.append(el("div", labels.noMatchingLocations));
      return;
    }
    for (const loc of matches) {
      const row = el("div");
      row.style.cssText =
        style.listRow + (loc.location_id === activeLocationId ? style.listRowActive : "");
      const name = el("span", loc.location_name);
      const count = el("span", String(loc.mosaic_count));
      count.style.cssText = style.count;
      row.append(name, count);
      row.addEventListener("click", () => void selectLocation(loc));
      locationList.append(row);
    }
  };
  searchInput.addEventListener("input", () => renderLocationRows(searchInput.value));

  const flyToLocation = (loc: MosaicLocation): void => {
    const map = appRef?.getMap?.();
    map?.flyTo({
      center: [loc.center_lon, loc.center_lat],
      zoom: zoomForRadius(loc.radius_m, loc.center_lat),
      duration: 900,
    });
  };

  const populateSizeOptions = (sizes: MosaicSizeGroup[]): void => {
    sizeSelect.innerHTML = "";
    const totalOption = el("option", labels.allSizes(locationDates.length));
    totalOption.value = "";
    sizeSelect.append(totalOption);
    for (const group of sizes) {
      const option = el("option", labels.sizeOption(group.width, group.height, group.count));
      option.value = `${group.width}x${group.height}`;
      option.dataset.ids = group.mosaic_ids.join(",");
      sizeSelect.append(option);
    }
    // Default to the largest same-size group rather than "all sizes": a
    // timeline that silently mixes different image dimensions per frame is
    // the thing being filtered against, so start already filtered.
    if (sizes.length) sizeSelect.value = `${sizes[0].width}x${sizes[0].height}`;
  };

  const applyActiveDatesFromSizeSelection = (): void => {
    const option = sizeSelect.options[sizeSelect.selectedIndex];
    const ids = option?.dataset.ids;
    if (!ids) {
      activeDates = locationDates;
    } else {
      const idSet = new Set(ids.split(",").map(Number));
      activeDates = locationDates.filter((entry) => idSet.has(entry.mosaic_id));
    }
    slider.max = String(Math.max(0, activeDates.length - 1));
    slider.disabled = activeDates.length === 0;
    playButton.disabled = activeDates.length === 0;
    if (!activeDates.length) {
      dateLabel.textContent = labels.noDatesForLocation;
      return;
    }
    const lastIndex = activeDates.length - 1;
    slider.value = String(lastIndex);
    dateLabel.textContent = activeDates[lastIndex]?.acquisition_date ?? "";
    loadMosaicAt(lastIndex);
  };

  sizeSelect.addEventListener("change", () => {
    stopPlaying();
    applyActiveDatesFromSizeSelection();
  });

  const selectLocation = async (loc: MosaicLocation): Promise<void> => {
    stopPlaying();
    clearActiveLayers();
    currentSelection = null;
    activeLocationId = loc.location_id;
    renderLocationRows(searchInput.value);
    flyToLocation(loc);

    const token = ++locationToken;
    slider.disabled = true;
    playButton.disabled = true;
    sizeSelect.disabled = true;
    slider.value = "0";
    slider.max = "0";
    dateLabel.textContent = labels.loadingDates;
    try {
      const datesResult = await fetchMosaicJson<{ mosaics: MosaicDateEntry[] }>(
        `/mosaics/dates?location_id=${loc.location_id}`,
      );
      if (locationToken !== token) return; // a newer location selection has taken over
      locationDates = datesResult.mosaics;
      if (!locationDates.length) {
        dateLabel.textContent = labels.noDatesForLocation;
        return;
      }
      // Show the most recent mosaic right away from the (cheap) date list
      // alone. Grouping by image size needs to probe every mosaic's pixel
      // dimensions (/mosaics/sizes), which can take a few seconds uncached on
      // a large location -- loading it lazily in the background, instead of
      // blocking the very first frame on it, is the whole point.
      activeDates = locationDates;
      sizeSelect.innerHTML = "";
      const allOption = el("option", labels.allSizes(locationDates.length));
      allOption.value = "";
      sizeSelect.append(allOption);
      slider.max = String(activeDates.length - 1);
      slider.disabled = false;
      playButton.disabled = false;
      const lastIndex = activeDates.length - 1;
      slider.value = String(lastIndex);
      dateLabel.textContent = activeDates[lastIndex]?.acquisition_date ?? "";
      loadMosaicAt(lastIndex);

      fetchMosaicJson<{ sizes: MosaicSizeGroup[] }>(`/mosaics/sizes?location_id=${loc.location_id}`)
        .then((sizesResult) => {
          if (locationToken !== token) return; // superseded by a newer location
          sizeSelect.disabled = false;
          populateSizeOptions(sizesResult.sizes);
          applyActiveDatesFromSizeSelection();
        })
        .catch(() => {
          // Size grouping is a nicety; leave "All sizes" selected on failure.
          if (locationToken === token) sizeSelect.disabled = false;
        });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : labels.datesFailed, true);
      dateLabel.textContent = labels.datesFailed;
    }
  };

  /** Fade `layerId` in from 0 -> full opacity over CROSSFADE_MS instead of popping in abruptly. */
  const fadeIn = (layerId: string, token: number): void => {
    const setOpacity = (id: string, value: number): void => {
      try {
        useAppStore.getState().updateLayer(id, { opacity: value });
      } catch {
        // The layer may already be gone (e.g. a fast double-switch); ignore.
      }
    };
    let step = 0;
    setOpacity(layerId, 0);
    const timer = setInterval(() => {
      step += 1;
      const t = Math.min(1, step / CROSSFADE_STEPS);
      if (loadToken !== token) {
        // Superseded by a newer selection; stop animating, leave whichever
        // fade owns the current token to finish on its own.
        clearInterval(timer);
        return;
      }
      setOpacity(layerId, t);
      if (t >= 1) clearInterval(timer);
    }, CROSSFADE_MS / CROSSFADE_STEPS);
  };

  const addMosaicLayer = async (
    locationId: number,
    mosaicId: number,
    dateText: string,
  ): Promise<void> => {
    if (!appRef?.addCogLayer) {
      setStatus(labels.cogUnsupported, true);
      return;
    }
    const token = ++loadToken;
    const locationName =
      allLocations.find((loc) => loc.location_id === locationId)?.location_name ?? "Mosaic";
    const displayLabel = `${locationName} — ${dateText}`;
    setStatus(labels.adding(displayLabel));
    try {
      const newLayerId = await appRef.addCogLayer(displayLabel, mosaicCogUrl(mosaicId));
      if (loadToken !== token) {
        // A newer selection started while this COG was loading; drop this one.
        useAppStore.getState().removeLayer(newLayerId);
        return;
      }
      pushActiveLayer(newLayerId);
      currentSelection = { locationId, mosaicId };
      fadeIn(newLayerId, token);
      setStatus(labels.added(displayLabel));
      void fetchMosaicJson<MosaicBbox>(`/mosaics/bbox/${mosaicId}`)
        .then((bbox) => {
          if (currentSelection?.mosaicId === mosaicId) updateMask(appRef?.getMap?.(), bbox);
        })
        .catch(() => {
          // The mask is a visual nicety; a failed bbox fetch just leaves the last one in place.
        });
    } catch (error) {
      if (loadToken === token) currentSelection = null;
      setStatus(error instanceof Error ? error.message : labels.addFailed, true);
    }
  };

  void (async () => {
    setStatus(labels.loadingLocations);
    try {
      const statusResult = await fetchMosaicJson<MosaicStatus>("/mosaics/status");
      if (!statusResult.available) {
        setStatus(labels.unavailable, true);
        searchInput.disabled = true;
        return;
      }
      const result = await fetchMosaicJson<{ locations: MosaicLocation[] }>("/mosaics/locations");
      allLocations = result.locations;
      renderLocationRows("");

      const restore = currentSelection;
      const restoreLocation = restore
        ? allLocations.find((loc) => loc.location_id === restore.locationId)
        : undefined;
      if (restore && restoreLocation) {
        await selectLocation(restoreLocation);
        const restoreIndex = activeDates.findIndex((entry) => entry.mosaic_id === restore.mosaicId);
        if (restoreIndex >= 0) {
          slider.value = String(restoreIndex);
          dateLabel.textContent = activeDates[restoreIndex]?.acquisition_date ?? "";
          loadMosaicAt(restoreIndex);
        }
      } else {
        setStatus(labels.chooseLocation);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : labels.unavailable, true);
    }
  })();

  return () => {
    stopPlaying();
    if (scrubTimer !== null) clearTimeout(scrubTimer);
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

export const mosaicTimelinePlugin: GeoIntPlugin = {
  id: MOSAIC_TIMELINE_PLUGIN_ID,
  name: "Mosaic Timeline",
  version: "0.1.0",
  activate(app) {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.title,
        dock: "left-of-layers",
        defaultWidth: 340,
        render(container) {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    // activeByDefault means this plugin runs from app startup with no user
    // action -- without opening its panel too, it would be running but have
    // no visible entry point at all (registerRightPanel alone does not show
    // the panel). Matches how e.g. the STAC Catalogs plugin opens itself on
    // activate.
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    removeMask(app.getMap?.());
    clearActiveLayers();
    appRef = null;
  },
  getProjectState: () => (currentSelection ? { ...currentSelection } : undefined),
  applyProjectState: (_app: GeoIntAppAPI, state: unknown) => {
    if (
      state &&
      typeof state === "object" &&
      "locationId" in state &&
      "mosaicId" in state &&
      typeof (state as MosaicSelection).locationId === "number" &&
      typeof (state as MosaicSelection).mosaicId === "number"
    ) {
      currentSelection = { ...(state as MosaicSelection) };
      // If the panel is already mounted (plugin re-activated within the same
      // session), re-render to pick up the restored selection immediately;
      // otherwise the next activate()/render() picks it up.
      if (panelContainer) mountPanel(panelContainer);
      return true;
    }
    currentSelection = null;
    return false;
  },
};

export default mosaicTimelinePlugin;
