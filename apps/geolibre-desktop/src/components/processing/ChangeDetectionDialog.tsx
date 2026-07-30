import { useAppStore } from "@geoint/core";
import type { MapController } from "@geoint/map";
import {
  fetchChangeDetectionModels,
  fetchChangeDetectionStatus,
  fetchMosaicBbox,
  fetchMosaicDates,
  fetchMosaicLocations,
  runChangeDetectionImages,
  runChangeDetectionMosaicPair,
  type ChangeDetectionModelInfo,
  type ChangeDetectionResult,
  type ChangeDetectionStatus,
  type MosaicDateEntry,
  type MosaicLocation,
} from "@geoint/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geoint/ui";
import { AlertCircle, CheckCircle2, FolderOpen, Info, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";

interface ChangeDetectionDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [{ name: "Imagery", extensions: ["tif", "tiff", "png", "jpg", "jpeg"] }];
const IMAGE_ACCEPT = ".tif,.tiff,.png,.jpg,.jpeg";

type SourceMode = "mosaic" | "images";

const OVERLAY_SOURCE_ID = "geoint-change-detection-overlay";
const OVERLAY_LAYER_ID = "geoint-change-detection-overlay-layer";

/** Decode a base64 PNG string into an object URL, or null if empty. */
function base64PngToObjectUrl(base64: string | undefined): string | null {
  if (!base64) return null;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

/**
 * Change Detection dialog: compare a "before"/"after" pair, either two dates
 * from a chosen Mosaic Timeline location (zero image bytes cross this app —
 * the external GPU host reads the NAS directly) or two locally opened images
 * (uploaded to the sidecar's multipart proxy). Sends the request to the
 * sidecar's `/changedetect/*` proxy in front of an already-running external
 * Change Detection API.
 */
export function ChangeDetectionDialog({
  mapControllerRef,
}: ChangeDetectionDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.changeDetectionOpen);
  const setOpen = useAppStore((s) => s.setChangeDetectionOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [status, setStatus] = useState<ChangeDetectionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState<ChangeDetectionModelInfo[]>([]);
  const [modelName, setModelName] = useState("");
  const [threshold, setThreshold] = useState(0.5);
  const [sourceMode, setSourceMode] = useState<SourceMode>("mosaic");

  // Mosaic Timeline source
  const [locations, setLocations] = useState<MosaicLocation[]>([]);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [dates, setDates] = useState<MosaicDateEntry[]>([]);
  const [preMosaicId, setPreMosaicId] = useState<number | null>(null);
  const [postMosaicId, setPostMosaicId] = useState<number | null>(null);

  // Any-images source
  const [preBytes, setPreBytes] = useState<ArrayBuffer | null>(null);
  const [preName, setPreName] = useState("");
  const [postBytes, setPostBytes] = useState<ArrayBuffer | null>(null);
  const [postName, setPostName] = useState("");

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChangeDetectionResult | null>(null);

  // Tracks the overlay's object URL so it can be revoked when replaced/cleared.
  const overlayUrlRef = useRef<string | null>(null);

  const checkGenRef = useRef(0);

  const checkStatus = useCallback(async () => {
    const gen = ++checkGenRef.current;
    setChecking(true);
    setStatus(null);
    try {
      const next = await fetchChangeDetectionStatus();
      if (gen !== checkGenRef.current) return;
      setStatus(next);
      if (next.available) {
        const modelList = await fetchChangeDetectionModels();
        if (gen !== checkGenRef.current) return;
        setModels(modelList);
        const best = modelList
          .filter((m) => m.loaded)
          .sort((a, b) => (b.checkpoint_val_f1 ?? 0) - (a.checkpoint_val_f1 ?? 0))[0];
        setModelName(best?.name ?? modelList[0]?.name ?? "");
      }
    } catch (err) {
      console.debug("ChangeDetectionDialog: status probe failed", err);
      if (gen === checkGenRef.current) {
        setStatus({ available: false, message: t("changeDetection.status.unavailable") });
      }
    } finally {
      if (gen === checkGenRef.current) setChecking(false);
    }
  }, [t]);

  const clearOverlay = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (map) {
      if (map.getLayer(OVERLAY_LAYER_ID)) map.removeLayer(OVERLAY_LAYER_ID);
      if (map.getSource(OVERLAY_SOURCE_ID)) map.removeSource(OVERLAY_SOURCE_ID);
    }
    if (overlayUrlRef.current) {
      URL.revokeObjectURL(overlayUrlRef.current);
      overlayUrlRef.current = null;
    }
  }, [mapControllerRef]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    setRunning(false);
    void checkStatus();
    void fetchMosaicLocations()
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [open, checkStatus]);

  // Tear down the overlay when the dialog closes or the panel unmounts, so a
  // stale visualization doesn't linger after the user moves on.
  useEffect(() => {
    if (!open) clearOverlay();
    return () => clearOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onLocationChange = useCallback((value: string) => {
    const id = value ? Number(value) : null;
    setLocationId(id);
    setDates([]);
    setPreMosaicId(null);
    setPostMosaicId(null);
    if (id == null) return;
    void fetchMosaicDates(id)
      .then((entries) => {
        setDates(entries);
        if (entries.length >= 2) {
          setPreMosaicId(entries[0].mosaic_id);
          setPostMosaicId(entries[entries.length - 1].mosaic_id);
        }
      })
      .catch(() => setDates([]));
  }, []);

  const pickImage = useCallback(async (side: "pre" | "post") => {
    const result_ = await openLocalDataFileWithFallback({
      filters: IMAGE_FILTERS,
      accept: IMAGE_ACCEPT,
      readBinary: true,
    });
    if (!result_?.data) return;
    const name = (result_.path || `${side}.tif`).split(/[/\\]/).pop() || `${side}.tif`;
    if (side === "pre") {
      setPreBytes(result_.data);
      setPreName(name);
    } else {
      setPostBytes(result_.data);
      setPostName(name);
    }
  }, []);

  const available = status?.available === true;
  const canRun =
    available &&
    Boolean(modelName) &&
    (sourceMode === "mosaic"
      ? preMosaicId != null && postMosaicId != null && preMosaicId !== postMosaicId
      : Boolean(preBytes) && Boolean(postBytes));

  const handleRun = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!canRun) return;
    setRunning(true);
    clearOverlay();
    try {
      const params = { threshold };
      const response =
        sourceMode === "mosaic"
          ? await runChangeDetectionMosaicPair(
              modelName,
              preMosaicId as number,
              postMosaicId as number,
              params,
            )
          : await runChangeDetectionImages(
              modelName,
              new Blob([preBytes as ArrayBuffer]),
              preName || "pre.tif",
              new Blob([postBytes as ArrayBuffer]),
              postName || "post.tif",
              params,
            );
      setResult(response);

      const features = response.geojson?.features ?? [];
      if (features.length > 0) {
        const name = t("changeDetection.layerName", {
          model: response.model || modelName,
        });
        const layerId = addGeoJsonLayer(name, response.geojson!);
        const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
        if (layer) mapControllerRef.current?.fitLayer(layer);
      }

      // The raster overlay/heatmap is only placeable when we know its
      // geographic bounds, which today is true only for a Mosaic Timeline
      // pair (via the post mosaic's known footprint).
      if (sourceMode === "mosaic" && postMosaicId != null) {
        const overlayBase64 =
          response.overlay_base64 ?? response.heatmap_base64 ?? response.mask_base64;
        const objectUrl = base64PngToObjectUrl(overlayBase64);
        if (objectUrl) {
          const bbox = await fetchMosaicBbox(postMosaicId);
          const map = mapControllerRef.current?.getMap();
          if (map) {
            overlayUrlRef.current = objectUrl;
            map.addSource(OVERLAY_SOURCE_ID, {
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
              id: OVERLAY_LAYER_ID,
              type: "raster",
              source: OVERLAY_SOURCE_ID,
              paint: { "raster-opacity": 0.85 },
            });
          } else {
            URL.revokeObjectURL(objectUrl);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("changeDetection.error.failed"));
    } finally {
      setRunning(false);
    }
  }, [
    canRun,
    sourceMode,
    modelName,
    threshold,
    preMosaicId,
    postMosaicId,
    preBytes,
    postBytes,
    preName,
    postName,
    addGeoJsonLayer,
    mapControllerRef,
    clearOverlay,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("changeDetection.title")}</DialogTitle>
          <DialogDescription>{t("changeDetection.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {checking && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("changeDetection.status.checking")}
            </p>
          )}

          {!checking && status && !available && (
            <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {status.message}
              </p>
            </div>
          )}

          {!checking && available && (
            <p className="text-xs text-muted-foreground">
              {t("changeDetection.status.ready", {
                gpu: status?.gpu ?? "",
                device: status?.device ?? "",
              })}
            </p>
          )}

          {/* Source mode */}
          <div className="grid gap-1.5">
            <Label htmlFor="cd-source" className="text-xs">
              {t("changeDetection.sourceLabel")}
            </Label>
            <Select
              id="cd-source"
              value={sourceMode}
              disabled={!available}
              onChange={(e) => setSourceMode(e.target.value as SourceMode)}
            >
              <option value="mosaic">{t("changeDetection.sourceMosaic")}</option>
              <option value="images">{t("changeDetection.sourceImages")}</option>
            </Select>
          </div>

          {sourceMode === "mosaic" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="cd-location" className="text-xs">
                  {t("changeDetection.locationLabel")}
                </Label>
                <Select
                  id="cd-location"
                  value={locationId ?? ""}
                  disabled={!available}
                  onChange={(e) => onLocationChange(e.target.value)}
                >
                  <option value="">{t("changeDetection.locationPlaceholder")}</option>
                  {locations.map((loc) => (
                    <option key={loc.location_id} value={loc.location_id}>
                      {loc.location_name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="cd-pre-date" className="text-xs">
                    {t("changeDetection.beforeLabel")}
                  </Label>
                  <Select
                    id="cd-pre-date"
                    value={preMosaicId ?? ""}
                    disabled={!available || dates.length === 0}
                    onChange={(e) => setPreMosaicId(e.target.value ? Number(e.target.value) : null)}
                  >
                    {dates.map((entry) => (
                      <option key={entry.mosaic_id} value={entry.mosaic_id}>
                        {entry.acquisition_date}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="cd-post-date" className="text-xs">
                    {t("changeDetection.afterLabel")}
                  </Label>
                  <Select
                    id="cd-post-date"
                    value={postMosaicId ?? ""}
                    disabled={!available || dates.length === 0}
                    onChange={(e) =>
                      setPostMosaicId(e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    {dates.map((entry) => (
                      <option key={entry.mosaic_id} value={entry.mosaic_id}>
                        {entry.acquisition_date}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("changeDetection.beforeLabel")}</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                  <Input readOnly disabled={!available} value={preName} />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!available}
                    onClick={() => void pickImage("pre")}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("changeDetection.afterLabel")}</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                  <Input readOnly disabled={!available} value={postName} />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!available}
                    onClick={() => void pickImage("post")}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="cd-model" className="text-xs">
                {t("changeDetection.modelLabel")}
              </Label>
              <Select
                id="cd-model"
                value={modelName}
                disabled={!available || models.length === 0}
                onChange={(e) => setModelName(e.target.value)}
              >
                {models
                  .filter((m) => m.loaded)
                  .map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cd-threshold" className="text-xs">
                {t("changeDetection.thresholdLabel")}
              </Label>
              <Input
                id="cd-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                disabled={!available}
                value={String(threshold)}
                onChange={(e) => {
                  if (e.target.value === "") {
                    setThreshold(0.5);
                    return;
                  }
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setThreshold(Math.min(1, Math.max(0, parsed)));
                }}
              />
            </div>
          </div>

          <div>
            <Button
              onClick={() => void handleRun()}
              disabled={running || !canRun}
              className="gap-2"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("changeDetection.run")}
            </Button>
          </div>

          {error && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}

          {result && !error && (
            <div className="grid gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {t("changeDetection.done")}
              </p>
              {result.changed_area_pct != null && (
                <p>{t("changeDetection.stats.changedPct", { pct: result.changed_area_pct })}</p>
              )}
              {result.polygon_count != null && (
                <p>{t("changeDetection.stats.polygonCount", { count: result.polygon_count })}</p>
              )}
              {result.inference_ms != null && (
                <p>
                  {t("changeDetection.stats.inferenceMs", { ms: Math.round(result.inference_ms) })}
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
