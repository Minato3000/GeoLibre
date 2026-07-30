import { useAppStore } from "@geoint/core";

/**
 * Reference-counted registry of mosaic COG layers, shared between
 * `mosaic-timeline.ts`'s own scrubber and `mosaic-change-detection.ts`'s A/B
 * track so the same `mosaic_id` is never fetched and decoded twice into two
 * separate layers just because both features happen to be showing it at
 * once (e.g. the Timeline's current date matches Change Detection's B date).
 *
 * Concurrent `acquireMosaicLayer` calls for the same id while a load is
 * in-flight share the one underlying promise instead of racing two loads.
 */

interface CacheEntry {
  refCount: number;
  layerId: string | null;
  loadPromise: Promise<string> | null;
  /** Set when refCount hit 0 while still loading; the layer is removed the moment it lands. */
  cancelled: boolean;
}

const entries = new Map<number, CacheEntry>();

export interface AcquireResult {
  layerId: string;
  /** True only when this call triggered the actual load (a fresh layer, opacity 0 -- a fade-in candidate). False when reusing an already-loaded (or loading) layer another caller holds. */
  created: boolean;
}

/**
 * Get (or start loading) the layer for `mosaicId`, bumping its reference
 * count. Pair every successful call with a later `releaseMosaicLayer`.
 */
export async function acquireMosaicLayer(
  mosaicId: number,
  load: () => Promise<string>,
): Promise<AcquireResult> {
  const existing = entries.get(mosaicId);
  if (existing) {
    existing.refCount += 1;
    if (existing.loadPromise) {
      const layerId = await existing.loadPromise;
      return { layerId, created: false };
    }
    return { layerId: existing.layerId as string, created: false };
  }

  const entry: CacheEntry = { refCount: 1, layerId: null, loadPromise: null, cancelled: false };
  entries.set(mosaicId, entry);
  const promise = load();
  entry.loadPromise = promise;
  try {
    const layerId = await promise;
    entry.layerId = layerId;
    entry.loadPromise = null;
    if (entry.cancelled) {
      // Every holder released before the load even landed; don't leave it
      // orphaned on the map.
      try {
        useAppStore.getState().removeLayer(layerId);
      } catch {
        // Nothing to clean up.
      }
    }
    return { layerId, created: true };
  } catch (error) {
    // Failed load: don't cache the failure, so the next acquire retries.
    if (entries.get(mosaicId) === entry) entries.delete(mosaicId);
    throw error;
  }
}

/** Release one reference to `mosaicId`; removes the layer once nothing else holds it. */
export function releaseMosaicLayer(mosaicId: number): void {
  const entry = entries.get(mosaicId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entries.delete(mosaicId);
  if (entry.layerId) {
    try {
      useAppStore.getState().removeLayer(entry.layerId);
    } catch {
      // Already gone; ignore.
    }
  } else {
    // Still loading (or the load hasn't resolved into `entry.layerId` yet);
    // mark it so the layer is removed the instant it lands instead of
    // orphaning it on the map.
    entry.cancelled = true;
  }
}

/** Test-only: drop all cache state between test cases. */
export function __resetMosaicLayerCacheForTests(): void {
  entries.clear();
}
