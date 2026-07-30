import type { GeoIntAppAPI, GeoIntMapControlPosition, GeoIntPlugin } from "../types";

let layerControlPosition: GeoIntMapControlPosition = "top-right";

export const maplibreLayerControlPlugin: GeoIntPlugin = {
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.16.0",
  activeByDefault: true,
  activate: (app: GeoIntAppAPI) => app.setBuiltInMapControlVisible("layer-control", true),
  deactivate: (app: GeoIntAppAPI) => {
    app.setBuiltInMapControlVisible("layer-control", false);
  },
  getMapControlPosition: () => layerControlPosition,
  setMapControlPosition: (app: GeoIntAppAPI, position: GeoIntMapControlPosition) => {
    layerControlPosition = position;
    return app.setBuiltInMapControlPosition("layer-control", position);
  },
};
