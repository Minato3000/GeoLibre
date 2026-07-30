import type { GeoIntAppAPI, GeoIntPlugin } from "../types";

const OSM_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export const osmBasemapPlugin: GeoIntPlugin = {
  id: "osm-basemap",
  name: "OpenStreetMap Basemap",
  version: "0.1.0",
  activate: (app: GeoIntAppAPI) => {
    app.setBasemap(OSM_STYLE);
  },
  deactivate: () => {
    /* basemap remains until user changes it */
  },
};
