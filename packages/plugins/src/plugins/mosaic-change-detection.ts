import { useAppStore } from "@geoint/core";
import type { FeatureCollection } from "geojson";
import type { GeoIntAppAPI } from "../types";
import { acquireMosaicLayer, releaseMosaicLayer } from "./mosaic-layer-cache";
import {
  fetchMosaicJson,
  mosaicCogUrl,
  resolveSidecarBaseUrl,
  type MosaicBbox,
  type MosaicDateEntry,
} from "./mosaic-timeline";

export type ChangeDetectionSectionDeps = Pick<GeoIntAppAPI, "getMap" | "addGeoJsonLayer"> & {
  addCogLayer: NonNullable<GeoIntAppAPI["addCogLayer"]>;
};

interface ChangeDetectionModelInfo {
  name: string;
  loaded: boolean;
  checkpoint_val_f1?: number;
}

interface ChangeDetectionResult {
  status?: string;
  model?: string;
  changed_area_pct?: number;
  polygon_count?: number;
  inference_ms?: number;
  geojson?: FeatureCollection;
  overlay_base64?: string;
  heatmap_base64?: string;
  mask_base64?: string;
}

// Matches the visual language of mosaic-timeline.ts's own `style` tokens
// (duplicated rather than shared -- this sibling module has its own small,
// fixed set of CSS var-based strings, consistent with that file not
// exporting a shared "theme").
const style = {
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:7px;background:hsl(var(--card));",
  label: "font-size:10px;color:hsl(var(--muted-foreground));",
  status: "font-size:11px;line-height:1.4;color:hsl(var(--muted-foreground));",
  select:
    "border-radius:5px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));padding:3px 5px;font-size:11px;",
  input:
    "width:100%;min-width:0;box-sizing:border-box;padding:5px 7px;border-radius:5px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));",
  runButton:
    "padding:5px 10px;border-radius:5px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-size:11px;width:100%;",
  stepButton:
    "border:none;background:transparent;cursor:pointer;padding:0 2px;color:hsl(var(--muted-foreground));font-size:12px;",
  chip: "display:flex;align-items:center;gap:2px;font-size:11px;padding:2px 4px;border-radius:4px;",
  viewToggle:
    "display:flex;align-items:center;justify-content:center;gap:5px;align-self:center;" +
    "border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));" +
    "cursor:pointer;font-size:11px;padding:4px 10px;",
} as const;

// Simplified eye glyph (not a literal icon-library import -- packages/plugins
// is framework-agnostic and cannot use lucide-react).
const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';

const SETTLE_DEBOUNCE_MS = 150;

const RESULT_OVERLAY_SOURCE = "geoint-change-detection-result-overlay";
const RESULT_OVERLAY_LAYER = "geoint-change-detection-result-overlay-layer";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Decode a base64 PNG string into a revocable object URL, or null if empty. */
function base64PngToObjectUrl(base64: string | undefined): string | null {
  if (!base64) return null;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

async function postMosaicJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${resolveSidecarBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof errBody?.detail === "string" ? errBody.detail : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface ChangeDetectionChip {
  el: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  dateText: HTMLSpanElement;
}

function buildChip(): ChangeDetectionChip {
  const wrap = el("div");
  wrap.style.cssText = style.chip;
  const prevBtn = el("button", "‹");
  prevBtn.type = "button";
  prevBtn.style.cssText = style.stepButton;
  const dateText = el("span", "—");
  dateText.style.cssText = "min-width:76px;text-align:center;";
  const nextBtn = el("button", "›");
  nextBtn.type = "button";
  nextBtn.style.cssText = style.stepButton;
  wrap.append(prevBtn, dateText, nextBtn);
  return { el: wrap, prevBtn, nextBtn, dateText };
}

/**
 * Builds the Mosaic Timeline panel's "Change Detection" section: a dotted A/B
 * timeline (modeled on Google Earth's Historical Imagery slider) with a single
 * click-to-toggle button that switches which of the two chosen mosaics is
 * visible on the map, plus model/threshold controls and inline results.
 */
export function buildChangeDetectionSection(deps: ChangeDetectionSectionDeps): {
  element: HTMLElement;
  setLocationId(id: number | null): void;
  setDates(dates: MosaicDateEntry[]): void;
  dispose(): void;
} {
  let dates: MosaicDateEntry[] = [];
  let locationId: number | null = null;
  let aIndex = 0;
  let bIndex = 0;
  let layerAId: string | null = null;
  let layerAMosaicId: number | null = null;
  let layerBId: string | null = null;
  let layerBMosaicId: number | null = null;
  let loadToken = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let collapsed = true;
  let dragging: "a" | "b" | null = null;
  let activeSide: "a" | "b" = "b";

  let models: ChangeDetectionModelInfo[] = [];
  let modelName = "";
  let threshold = 0.5;
  let running = false;
  let runToken = 0;
  let activeRunController: AbortController | null = null;
  let resultOverlayUrl: string | null = null;
  let resultGeoJsonLayerId: string | null = null;

  // --- DOM ---------------------------------------------------------------

  const root = el("div");
  root.style.cssText = style.section;

  const header = el("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;cursor:pointer;";
  const headerLabel = el("span", "▸ Change Detection");
  headerLabel.style.cssText = style.label;
  header.append(headerLabel);

  const body = el("div");
  body.style.cssText = "display:none;flex-direction:column;gap:8px;";

  const trackWrap = el("div");
  trackWrap.style.cssText = "position:relative;height:20px;margin:8px 4px 4px;cursor:pointer;";
  const trackLine = el("div");
  trackLine.style.cssText =
    "position:absolute;left:0;right:0;top:50%;height:2px;background:hsl(var(--border));" +
    "transform:translateY(-50%);pointer-events:none;";
  const spanBar = el("div");
  spanBar.style.cssText =
    "position:absolute;top:50%;height:3px;background:hsl(var(--primary)/0.35);" +
    "transform:translateY(-50%);pointer-events:none;";
  const dotsLayer = el("div");
  dotsLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  trackWrap.append(trackLine, spanBar, dotsLayer);

  const chipsRow = el("div");
  chipsRow.style.cssText = "display:flex;justify-content:space-between;gap:8px;";
  const chipA = buildChip();
  const chipB = buildChip();
  chipsRow.append(chipA.el, chipB.el);

  const viewToggleIcon = el("span");
  viewToggleIcon.style.cssText = "display:flex;align-items:center;";
  const viewToggleLabel = el("span");
  const viewToggle = el("button");
  viewToggle.type = "button";
  viewToggle.style.cssText = style.viewToggle;
  viewToggle.append(viewToggleIcon, viewToggleLabel);

  const cdStatus = el("div", "");
  cdStatus.style.cssText = style.status;

  const controlsRow = el("div");
  controlsRow.style.cssText = "display:grid;grid-template-columns:1fr 70px;gap:8px;";
  const modelSelect = el("select");
  modelSelect.style.cssText = style.select + "width:100%;";
  const thresholdInput = el("input");
  thresholdInput.type = "number";
  thresholdInput.min = "0";
  thresholdInput.max = "1";
  thresholdInput.step = "0.05";
  thresholdInput.value = "0.5";
  thresholdInput.style.cssText = style.input;
  controlsRow.append(modelSelect, thresholdInput);

  const runButton = el("button", "Run Change Detection");
  runButton.type = "button";
  runButton.style.cssText = style.runButton;
  runButton.disabled = true;

  const resultBox = el("div", "");
  resultBox.style.cssText = style.status;

  body.append(trackWrap, chipsRow, viewToggle, cdStatus, controlsRow, runButton, resultBox);
  root.append(header, body);

  // --- Header collapse -----------------------------------------------------

  header.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "flex";
    updateHeaderLabel();
  });

  function updateHeaderLabel(): void {
    const a = dates[aIndex]?.acquisition_date;
    const b = dates[bIndex]?.acquisition_date;
    const range = a && b ? ` — ${a} → ${b}` : "";
    headerLabel.textContent = `${collapsed ? "▸" : "▾"} Change Detection${range}`;
  }

  // --- Dotted A/B timeline ---------------------------------------------

  function renderTrack(): void {
    dotsLayer.innerHTML = "";
    const n = dates.length;
    if (n === 0) {
      spanBar.style.width = "0";
      return;
    }
    const denom = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const isA = i === aIndex;
      const isB = i === bIndex;
      const size = isA || isB ? 10 : 5;
      const color = isA ? "#2563eb" : isB ? "#ea580c" : "hsl(var(--border))";
      const dot = el("div");
      dot.style.cssText =
        `position:absolute;top:50%;left:${(i / denom) * 100}%;width:${size}px;height:${size}px;` +
        `border-radius:50%;background:${color};transform:translate(-50%,-50%);` +
        `z-index:${isA || isB ? 2 : 1};`;
      dotsLayer.append(dot);
    }
    const aPct = (aIndex / denom) * 100;
    const bPct = (bIndex / denom) * 100;
    spanBar.style.left = `${Math.min(aPct, bPct)}%`;
    spanBar.style.width = `${Math.abs(bPct - aPct)}%`;
  }

  function indexFromClientX(clientX: number): number | null {
    const rect = trackWrap.getBoundingClientRect();
    if (rect.width === 0 || dates.length === 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (dates.length - 1));
  }

  function applyDragIndex(index: number): void {
    if (dates.length < 2) return;
    if (dragging === "a") {
      aIndex = Math.min(index, bIndex - 1);
      aIndex = Math.max(0, aIndex);
    } else if (dragging === "b") {
      bIndex = Math.max(index, aIndex + 1);
      bIndex = Math.min(dates.length - 1, bIndex);
    }
    renderTrack();
    updateChipLabels();
  }

  trackWrap.addEventListener("pointerdown", (event) => {
    const index = indexFromClientX(event.clientX);
    if (index === null) return;
    event.preventDefault();
    dragging = Math.abs(index - aIndex) <= Math.abs(index - bIndex) ? "a" : "b";
    applyDragIndex(index);
    const onMove = (moveEvent: PointerEvent) => {
      const idx = indexFromClientX(moveEvent.clientX);
      if (idx !== null) applyDragIndex(idx);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragging = null;
      scheduleSettle();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  function updateChipLabels(): void {
    chipA.dateText.textContent = dates[aIndex]?.acquisition_date ?? "—";
    chipB.dateText.textContent = dates[bIndex]?.acquisition_date ?? "—";
    updateHeaderLabel();
  }

  chipA.prevBtn.addEventListener("click", () => {
    if (aIndex > 0) {
      aIndex -= 1;
      renderTrack();
      updateChipLabels();
      scheduleSettle();
    }
  });
  chipA.nextBtn.addEventListener("click", () => {
    if (aIndex < bIndex - 1) {
      aIndex += 1;
      renderTrack();
      updateChipLabels();
      scheduleSettle();
    }
  });
  chipB.prevBtn.addEventListener("click", () => {
    if (bIndex > aIndex + 1) {
      bIndex -= 1;
      renderTrack();
      updateChipLabels();
      scheduleSettle();
    }
  });
  chipB.nextBtn.addEventListener("click", () => {
    if (bIndex < dates.length - 1) {
      bIndex += 1;
      renderTrack();
      updateChipLabels();
      scheduleSettle();
    }
  });

  // --- Single click-to-toggle A/B visibility button -----------------------

  function applyVisibility(): void {
    if (layerAId) useAppStore.getState().setLayerVisibility(layerAId, activeSide === "a");
    if (layerBId) useAppStore.getState().setLayerVisibility(layerBId, activeSide === "b");
    viewToggleIcon.innerHTML = EYE_ICON;
    viewToggleLabel.textContent = activeSide === "a" ? "Viewing A" : "Viewing B";
    viewToggleLabel.style.color = activeSide === "a" ? "#2563eb" : "#ea580c";
  }

  viewToggle.addEventListener("click", () => {
    activeSide = activeSide === "a" ? "b" : "a";
    applyVisibility();
  });

  // --- Loading A/B mosaic layers -------------------------------------------

  function scheduleSettle(): void {
    // A/B changed; a change-detection run in flight for the old pair is now
    // pointless (and would otherwise render a stale, misleading result) --
    // cancel it so the GPU host stops working on a discarded pair too.
    activeRunController?.abort();
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void loadLayers(), SETTLE_DEBOUNCE_MS);
  }

  async function loadLayers(): Promise<void> {
    const entryA = dates[aIndex];
    const entryB = dates[bIndex];
    if (!entryA || !entryB || locationId === null) return;
    clearResultOverlay();
    resultBox.textContent = "";
    const token = ++loadToken;

    cdStatus.textContent = `Loading ${entryA.acquisition_date} / ${entryB.acquisition_date}…`;
    // Load A and B together instead of one after the other -- there is no
    // dependency between them, so awaiting them sequentially only doubled
    // the wait before "Run" could enable.
    const [resultA, resultB] = await Promise.allSettled([
      acquireMosaicLayer(entryA.mosaic_id, () =>
        deps.addCogLayer(
          `Change Detection A (${entryA.acquisition_date})`,
          mosaicCogUrl(entryA.mosaic_id),
        ),
      ),
      acquireMosaicLayer(entryB.mosaic_id, () =>
        deps.addCogLayer(
          `Change Detection B (${entryB.acquisition_date})`,
          mosaicCogUrl(entryB.mosaic_id),
        ),
      ),
    ]);

    if (token !== loadToken) {
      // Superseded by a newer A/B pair while both were loading; release
      // whichever side actually succeeded.
      if (resultA.status === "fulfilled") releaseMosaicLayer(entryA.mosaic_id);
      if (resultB.status === "fulfilled") releaseMosaicLayer(entryB.mosaic_id);
      return;
    }

    if (resultA.status === "rejected") {
      cdStatus.textContent =
        resultA.reason instanceof Error ? resultA.reason.message : "Could not load mosaic A";
      if (resultB.status === "fulfilled") releaseMosaicLayer(entryB.mosaic_id);
      return;
    }
    if (resultB.status === "rejected") {
      cdStatus.textContent =
        resultB.reason instanceof Error ? resultB.reason.message : "Could not load mosaic B";
      releaseMosaicLayer(entryA.mosaic_id);
      return;
    }

    if (layerAMosaicId !== null) releaseMosaicLayer(layerAMosaicId);
    layerAId = resultA.value.layerId;
    layerAMosaicId = entryA.mosaic_id;

    if (layerBMosaicId !== null) releaseMosaicLayer(layerBMosaicId);
    layerBId = resultB.value.layerId;
    layerBMosaicId = entryB.mosaic_id;

    cdStatus.textContent = "";
    updateRunEnabled();
    applyVisibility();
  }

  // --- Model / threshold / run ---------------------------------------------

  async function loadModels(): Promise<void> {
    try {
      const list = await fetchMosaicJson<ChangeDetectionModelInfo[]>("/changedetect/models");
      models = list.filter((m) => m.loaded);
      modelSelect.innerHTML = "";
      for (const m of models) {
        const option = el("option", m.name);
        option.value = m.name;
        modelSelect.append(option);
      }
      const best = [...models].sort(
        (a, b) => (b.checkpoint_val_f1 ?? 0) - (a.checkpoint_val_f1 ?? 0),
      )[0];
      modelName = best?.name ?? models[0]?.name ?? "";
      if (modelName) modelSelect.value = modelName;
      updateRunEnabled();
    } catch {
      // Change detection backend not configured/unreachable; Run stays
      // disabled (see updateRunEnabled) and the select stays empty.
    }
  }

  modelSelect.addEventListener("change", () => {
    modelName = modelSelect.value;
    updateRunEnabled();
  });
  thresholdInput.addEventListener("change", () => {
    const parsed = Number(thresholdInput.value);
    threshold = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
  });

  function updateRunEnabled(): void {
    runButton.disabled = running || !layerAId || !layerBId || !modelName;
  }

  function clearResultOverlay(): void {
    const map = deps.getMap?.();
    if (map) {
      if (map.getLayer(RESULT_OVERLAY_LAYER)) map.removeLayer(RESULT_OVERLAY_LAYER);
      if (map.getSource(RESULT_OVERLAY_SOURCE)) map.removeSource(RESULT_OVERLAY_SOURCE);
    }
    if (resultOverlayUrl) {
      URL.revokeObjectURL(resultOverlayUrl);
      resultOverlayUrl = null;
    }
    if (resultGeoJsonLayerId) {
      try {
        useAppStore.getState().removeLayer(resultGeoJsonLayerId);
      } catch {
        // Already gone; ignore.
      }
      resultGeoJsonLayerId = null;
    }
  }

  async function runChangeDetection(): Promise<void> {
    const entryA = dates[aIndex];
    const entryB = dates[bIndex];
    if (!layerAId || !layerBId || !modelName || !entryA || !entryB || running) return;
    running = true;
    updateRunEnabled();
    resultBox.textContent = "";
    cdStatus.textContent = "Running change detection…";
    const token = ++runToken;
    const controller = new AbortController();
    activeRunController = controller;
    try {
      const response = await postMosaicJson<ChangeDetectionResult>(
        `/changedetect/predict_paths/${encodeURIComponent(modelName)}`,
        {
          pre_mosaic_id: entryA.mosaic_id,
          post_mosaic_id: entryB.mosaic_id,
          threshold,
          window_overlap: 16,
        },
        controller.signal,
      );
      // Discard if superseded by a newer run, or if the A/B selection moved
      // on while this one was in flight -- rendering it would silently
      // overwrite whatever the user is now looking at with a result for a
      // pair they've since left.
      if (token !== runToken) return;
      const stillCurrent =
        dates[aIndex]?.mosaic_id === entryA.mosaic_id &&
        dates[bIndex]?.mosaic_id === entryB.mosaic_id;
      if (!stillCurrent) {
        cdStatus.textContent = "A/B selection changed before the result arrived — discarded.";
        return;
      }
      cdStatus.textContent = "";
      clearResultOverlay();

      const features = response.geojson?.features ?? [];
      if (features.length > 0) {
        resultGeoJsonLayerId = deps.addGeoJsonLayer(
          `Change detection (${modelName})`,
          response.geojson as FeatureCollection,
        );
      }

      const overlayBase64 =
        response.overlay_base64 ?? response.heatmap_base64 ?? response.mask_base64;
      const objectUrl = base64PngToObjectUrl(overlayBase64);
      if (objectUrl) {
        const bbox = await fetchMosaicJson<MosaicBbox>(`/mosaics/bbox/${entryB.mosaic_id}`);
        const map = deps.getMap?.();
        if (map) {
          resultOverlayUrl = objectUrl;
          map.addSource(RESULT_OVERLAY_SOURCE, {
            type: "image",
            url: objectUrl,
            coordinates: [
              [bbox.west, bbox.north],
              [bbox.east, bbox.north],
              [bbox.east, bbox.south],
              [bbox.west, bbox.south],
            ],
          });
          map.addLayer({
            id: RESULT_OVERLAY_LAYER,
            type: "raster",
            source: RESULT_OVERLAY_SOURCE,
            paint: { "raster-opacity": 0.85 },
          });
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      }

      const stats: string[] = [];
      if (response.changed_area_pct != null)
        stats.push(`Changed area: ${response.changed_area_pct}%`);
      if (response.polygon_count != null) stats.push(`${response.polygon_count} polygon(s)`);
      if (response.inference_ms != null)
        stats.push(`Inference: ${Math.round(response.inference_ms)} ms`);
      resultBox.textContent = stats.join(" · ") || "Done.";
    } catch (error) {
      if (token !== runToken) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        cdStatus.textContent = "";
        return;
      }
      cdStatus.textContent = error instanceof Error ? error.message : "Change detection failed.";
    } finally {
      if (activeRunController === controller) activeRunController = null;
      if (token === runToken) {
        running = false;
        updateRunEnabled();
      }
    }
  }

  runButton.addEventListener("click", () => void runChangeDetection());

  // --- Public API ------------------------------------------------------

  void loadModels();

  function setLocationId(id: number | null): void {
    locationId = id;
  }

  function setDates(nextDates: MosaicDateEntry[]): void {
    dates = nextDates;
    aIndex = 0;
    bIndex = dates.length > 1 ? dates.length - 1 : 0;
    renderTrack();
    updateChipLabels();
    if (dates.length >= 2) scheduleSettle();
  }

  function dispose(): void {
    activeRunController?.abort();
    if (settleTimer !== null) clearTimeout(settleTimer);
    clearResultOverlay();
    if (layerAMosaicId !== null) {
      releaseMosaicLayer(layerAMosaicId);
      layerAId = null;
      layerAMosaicId = null;
    }
    if (layerBMosaicId !== null) {
      releaseMosaicLayer(layerBMosaicId);
      layerBId = null;
      layerBMosaicId = null;
    }
  }

  return { element: root, setLocationId, setDates, dispose };
}
