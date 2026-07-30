import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useAppStore } from "@geoint/core";
import {
  __resetMosaicLayerCacheForTests,
  acquireMosaicLayer,
  releaseMosaicLayer,
} from "../packages/plugins/src/plugins/mosaic-layer-cache";

describe("mosaic-layer-cache", () => {
  const originalRemoveLayer = useAppStore.getState().removeLayer;
  let removeLayer: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    __resetMosaicLayerCacheForTests();
    removeLayer = mock.fn();
    useAppStore.setState({ removeLayer: removeLayer as unknown as (id: string) => void });
  });

  afterEach(() => {
    useAppStore.setState({ removeLayer: originalRemoveLayer });
  });

  it("shares one load across concurrent acquires and only removes after the last release", async () => {
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return "layer-1";
    };

    const [a, b] = await Promise.all([acquireMosaicLayer(42, load), acquireMosaicLayer(42, load)]);
    assert.equal(loadCalls, 1, "concurrent acquires for the same id share one load");
    assert.equal(a.layerId, "layer-1");
    assert.equal(b.layerId, "layer-1");
    assert.equal(a.created, true, "the call that actually loaded reports created");
    assert.equal(b.created, false, "a call that just joined an in-flight load does not");

    releaseMosaicLayer(42);
    assert.equal(removeLayer.mock.callCount(), 0, "layer stays while another holder remains");
    releaseMosaicLayer(42);
    assert.equal(removeLayer.mock.callCount(), 1, "removed once the last holder releases");
    assert.deepEqual(removeLayer.mock.calls[0].arguments, ["layer-1"]);
  });

  it("starts a fresh load after the cache entry is fully released", async () => {
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return `layer-${loadCalls}`;
    };
    const first = await acquireMosaicLayer(7, load);
    releaseMosaicLayer(7);
    const second = await acquireMosaicLayer(7, load);
    assert.equal(loadCalls, 2);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.layerId, second.layerId);
  });

  it("does not cache a failed load, so the next acquire retries", async () => {
    let attempt = 0;
    const load = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return "layer-ok";
    };
    await assert.rejects(() => acquireMosaicLayer(99, load));
    const result = await acquireMosaicLayer(99, load);
    assert.equal(result.layerId, "layer-ok");
    assert.equal(attempt, 2);
  });

  it("removes the layer immediately once a fully-released in-flight load lands", async () => {
    let resolveLoad!: (id: string) => void;
    const load = () =>
      new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });

    const pending = acquireMosaicLayer(5, load);
    releaseMosaicLayer(5); // released before the load even resolves
    resolveLoad("layer-5");
    await pending;
    assert.equal(removeLayer.mock.callCount(), 1);
    assert.deepEqual(removeLayer.mock.calls[0].arguments, ["layer-5"]);
  });
});
