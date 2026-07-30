import type { GeoIntAppAPI, GeoIntPlugin } from "../types";

const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export const cartoLightPlugin: GeoIntPlugin = {
  id: "carto-light",
  name: "Carto Light Basemap",
  version: "0.1.0",
  activate: (app: GeoIntAppAPI) => {
    app.setBasemap(CARTO_LIGHT);
  },
  deactivate: () => {},
};
