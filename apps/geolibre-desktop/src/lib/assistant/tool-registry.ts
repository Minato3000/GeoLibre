import {
  DEFAULT_LAYER_STYLE,
  OPENFREEMAP_BASEMAPS,
  useAppStore,
  type GeoIntLayer,
} from "@geoint/core";
import type { MapController } from "@geoint/map";
import maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { z } from "zod";
import { projectedGeoJsonCrs } from "../crs-utils";
import { inferPropertyColumns } from "../pglite-sql";
import { consoleDeps, runConsoleCode } from "../pyodide/pyodide-console";
import { cleanStatement, maskSqlLiterals, previewLayerTables, runSqlQuery } from "../sql-workspace";
import { createXyzTileUrlTemplate } from "../xyz-url";
import { findNamedTileBasemap, NAMED_TILE_BASEMAPS } from "./basemaps";
import { buildSymbologyStyle } from "./symbology";
import { webSearch } from "./web-search";

/**
 * Reference system prompt for a future model integration describing the
 * assistant's role and how to use the tools below. Nothing sends this today —
 * kept here as the natural home for "what can the assistant do" guidance
 * alongside the tool catalog itself.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You are GeoInt's geospatial assistant. You help the user explore and analyze the data already loaded in their map by calling the provided tools.

Guidelines:
- Always act through the tools. Never claim to have changed the map unless a tool call succeeded.
- Call list_layers to discover the current layers, their attribute fields, and the SQL table names before referencing them.
- For data questions, prefer run_sql with a single read-only DuckDB Spatial SQL statement against the SQL table names from list_layers. Show the SQL you ran. Only add the result as a layer when the user asks to map it or when geometry is clearly wanted.
- For styling requests, use apply_symbology with the layer's real field names.
- For geoprocessing (buffer, clip, dissolve, intersection, difference, union, spatial join, simplify, centroids, H3 grids, …), call list_algorithms to discover ids and typed parameters, then run_algorithm with the algorithm id and parameters. A 'layer' parameter takes a layer id. Build a multi-step pipeline by feeding one run's returned result layer id into the next.
- To add satellite/aerial imagery or other earth-observation data, use search_stac and add_stac_layer against the Planetary Computer (collections such as sentinel-2-l2a, landsat-c2-l2, naip, cop-dem-glo-30); the bounding box defaults to the current view.
- To add tile basemaps (OpenStreetMap, OpenTopoMap, CARTO Dark Matter, etc.), use add_tile_layer with a known name or an XYZ url, rather than asking the user or saying you cannot.
- Use web_search when you need current information from the internet.
- When no dedicated tool fits the request (e.g. changing the map projection to globe, enabling terrain or sky, setting a custom paint/layout property), do not say you can't — use run_maplibre_js to accomplish it with a small JavaScript snippet against the live \`map\` object.
- For data processing or computation (numpy/pandas/geopandas, custom analysis), use run_python; a \`geoint\` object is available there to drive the map.
- Keep replies short. Report exactly what each tool did (e.g. the SQL run, the rows returned, the layer added/styled). Every change is undoable, so prefer acting over asking when the request is clear.
- Never fabricate field names, layer names, or results — read them with the tools first.`;

/** Dependencies the assistant tools need beyond the global store. */
export interface AssistantToolDeps {
  /** Returns the live map controller, or null before the map mounts. */
  getMapController: () => MapController | null;
  /**
   * Ask the user to approve executing model-generated code before it runs.
   * Resolves true to proceed, false to decline. The assistant can be steered by
   * untrusted content (e.g. `web_search` results, layer attributes) into
   * emitting a `run_python`/`run_maplibre_js` snippet that exfiltrates secrets
   * or mutates the app, so these two tools are gated behind an explicit user
   * confirmation. When omitted (e.g. in tests) code runs without a prompt; the
   * desktop UI always provides it.
   */
  confirmCodeExecution?: (request: {
    tool: "run_python" | "run_maplibre_js";
    code: string;
  }) => Promise<boolean>;
}

/** A framework-agnostic assistant tool: name, description, input schema, handler. */
export interface AssistantTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (input: Input, deps: AssistantToolDeps) => Promise<Output> | Output;
  /**
   * Static metadata only — this tool runs model-authored code and should be
   * gated behind explicit user confirmation once something actually invokes
   * it. Not enforced by the registry itself; each such handler already calls
   * `deps.confirmCodeExecution` inline. Lets "what needs approval" be listed
   * without executing anything.
   */
  requiresConfirmation?: boolean;
}

/** A short, model-facing description of one layer (no feature data leaked). */
interface LayerSummary {
  id: string;
  name: string;
  type: string;
  geometryType: string | null;
  featureCount: number;
  fields: { name: string; type: string }[];
}

/** Statement keywords that write data or have side effects. */
const SQL_WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|ATTACH|DETACH|COPY|EXPORT|IMPORT|INSTALL|LOAD|PRAGMA|VACUUM|CHECKPOINT)\b/;

/**
 * True when a SQL statement is a read-only SELECT/WITH query. Guards both the
 * leading keyword and the body (with string/comment literals masked) so a
 * data-modifying CTE — `WITH x AS (DELETE …) …` — is also rejected.
 */
function isReadOnlySql(sql: string): boolean {
  const cleaned = cleanStatement(sql);
  const head = cleaned.trimStart().toUpperCase();
  if (!head.startsWith("SELECT") && !head.startsWith("WITH")) return false;
  return !SQL_WRITE_KEYWORDS.test(maskSqlLiterals(cleaned).toUpperCase());
}

/**
 * Validate a model-supplied URL before fetching: only http(s), and never a
 * loopback/private/link-local address (guards against AI-directed SSRF to the
 * local sidecar or internal services via prompt injection).
 */
function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol}).`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) before the IPv4 checks.
  const v4 = host.startsWith("::ffff:") ? host.slice(7) : host;
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    /^0\./.test(v4) || // 0.0.0.0/8 (incl. 0.0.0.0)
    /^127\./.test(v4) ||
    /^10\./.test(v4) ||
    /^192\.168\./.test(v4) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    /^169\.254\./.test(v4) || // link-local
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) || // 100.64/10 CGNAT
    /^(fc|fd)[0-9a-f]{2}:/.test(host) || // unique-local IPv6
    /^fe80:/.test(host); // link-local IPv6
  if (isPrivate) {
    throw new Error(`Refusing to fetch a private/loopback address: ${host}`);
  }
}

/**
 * Read a response body as text, aborting once `maxBytes` is exceeded — so an
 * over-large (or Content-Length–less) response can't buffer unbounded into
 * memory before the size check.
 */
async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Response too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large (> ${maxBytes} bytes).`);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concatBytes(chunks, total));
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Detect a layer's geometry family from its first feature. */
function geometryTypeOf(layer: GeoIntLayer): string | null {
  return layer.geojson?.features?.[0]?.geometry?.type ?? null;
}

/** Summarize a layer's identity and schema without exposing row data. */
function summarizeLayer(layer: GeoIntLayer): LayerSummary {
  const features = layer.geojson?.features ?? [];
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    geometryType: geometryTypeOf(layer),
    featureCount: features.length,
    fields: features.length
      ? inferPropertyColumns(features).map((column) => ({
          name: column.name,
          type: column.type,
        }))
      : [],
  };
}

/**
 * Build a compact, model-facing description of the current layers and the SQL
 * table names they map to. Used to seed a future model integration with names
 * and schemas only — never full datasets.
 */
export function describeLayers(layers: GeoIntLayer[]): string {
  if (layers.length === 0) return "No layers are currently loaded.";
  // previewLayerTables returns one entry per layer in order, so align by index —
  // keying by name would collapse layers that share a name onto one table.
  const tables = previewLayerTables(layers);
  return layers
    .map((layer, index) => {
      const summary = summarizeLayer(layer);
      const table = tables[index]?.tableName;
      const fields = summary.fields.map((field) => `${field.name}:${field.type}`).join(", ");
      return [
        `- "${layer.name}" (${summary.type}`,
        summary.geometryType ? `, ${summary.geometryType}` : "",
        `, ${summary.featureCount} features`,
        table ? `, SQL table ${table}` : "",
        `)`,
        fields ? ` fields: ${fields}` : "",
      ].join("");
    })
    .join("\n");
}

/** Resolve a layer by id first, then case-insensitive name match. */
function resolveLayer(reference: string): GeoIntLayer | null {
  const layers = useAppStore.getState().layers;
  const byId = layers.find((layer) => layer.id === reference);
  if (byId) return byId;
  const target = reference.trim().toLowerCase();
  const exact = layers.find((layer) => layer.name.toLowerCase() === target);
  if (exact) return exact;
  // Only fall back to a substring match for references long enough to be
  // meaningful, so a 1–2 char string can't match an arbitrary layer.
  if (target.length < 3) return null;
  return layers.find((layer) => layer.name.toLowerCase().includes(target)) ?? null;
}

/** Resolve a basemap name/id/url to a style URL via the known presets. */
function resolveBasemap(reference: string): string | null {
  const target = reference.trim().toLowerCase();
  if (target.startsWith("http")) {
    // Only accept https style URLs; an http style could mix-content fail and is
    // a needless freeform-URL surface.
    return target.startsWith("https://") ? reference.trim() : null;
  }
  const preset = OPENFREEMAP_BASEMAPS.find(
    (basemap) => basemap.id.toLowerCase() === target || basemap.name.toLowerCase() === target,
  );
  return preset?.styleUrl ?? null;
}

/** Validate that a fetched payload is GeoJSON the store can ingest. */
function asFeatureCollection(data: unknown): FeatureCollection {
  const value = data as { type?: string; features?: unknown };
  if (value?.type === "FeatureCollection" && Array.isArray(value.features)) {
    return value as FeatureCollection;
  }
  if (value?.type === "Feature") {
    return { type: "FeatureCollection", features: [value as never] };
  }
  throw new Error("URL did not return a GeoJSON Feature or FeatureCollection.");
}

/** The current map viewport as [west, south, east, north], or null. */
function viewBboxFor(deps: AssistantToolDeps): [number, number, number, number] | null {
  const map = deps.getMapController()?.getMap();
  if (!map) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

/** Reduce a STAC bbox (2D or 3D) to a 2D [w, s, e, n]. */
function bbox2d(bbox: number[]): [number, number, number, number] | null {
  return bbox.length >= 6
    ? [bbox[0], bbox[1], bbox[3], bbox[4]]
    : bbox.length >= 4
      ? [bbox[0], bbox[1], bbox[2], bbox[3]]
      : null;
}

/**
 * Gate model-authored code behind the user's confirmation hook. Returns true
 * when execution may proceed (approved, or no hook configured).
 */
function approveCodeExecution(
  deps: AssistantToolDeps,
  toolName: "run_python" | "run_maplibre_js",
  code: string,
): Promise<boolean> {
  return deps.confirmCodeExecution
    ? deps.confirmCodeExecution({ tool: toolName, code })
    : Promise.resolve(true);
}

// Lazily load the shared processing executor (Phase 2). It pulls in the
// algorithm registries (Turf, DuckDB), so it is imported only when used.
type ScriptingHandlers = {
  listAlgorithms: () => unknown;
  runAlgorithm: (input: {
    id: string;
    params: Record<string, unknown>;
  }) => Promise<{ logs?: string[]; resultLayerIds?: string[] }>;
};
let scriptingPromise: Promise<ScriptingHandlers> | null = null;
function getScripting(deps: AssistantToolDeps): Promise<ScriptingHandlers> {
  scriptingPromise ??= import("../scripting/scriptingApi").then(
    ({ createScriptingHandlers }) =>
      createScriptingHandlers({
        getController: deps.getMapController,
      }) as unknown as ScriptingHandlers,
  );
  return scriptingPromise;
}

/**
 * Define one tool, inferring its handler's input type from `inputSchema`
 * (mirroring how Strands' own `tool()` helper worked) and widening the result
 * to the registry's shared `AssistantTool` shape. Keeps each handler body
 * fully typed against its own schema while letting `ASSISTANT_TOOLS` hold a
 * single, uniformly-typed array.
 */
function defineTool<Schema extends z.ZodTypeAny>(tool: {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (input: z.infer<Schema>, deps: AssistantToolDeps) => Promise<unknown> | unknown;
  requiresConfirmation?: boolean;
}): AssistantTool {
  // The schema-specific handler type is intentionally narrower than
  // AssistantTool's boxed `unknown`, so a direct `as` isn't accepted — this is
  // the deliberate widening step, exactly mirroring runAssistantTool's
  // `inputSchema.parse(rawInput)` validating before a handler ever sees it.
  return tool as unknown as AssistantTool;
}

/**
 * The full GeoInt-native tool catalog. Every tool acts through the Zustand
 * store, the SQL Workspace, or the symbology helpers — never by mutating
 * MapLibre directly — so all changes flow through the app's one-way data flow
 * and are covered by undo/redo. Nothing invokes these yet (no model backend
 * is wired up); this is the catalog a future integration will call into via
 * {@link runAssistantTool}.
 */
export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  defineTool({
    name: "list_layers",
    description:
      "List the layers currently loaded in the map, with their id, type, geometry, feature count, attribute field names, and the SQL table name to use in run_sql. Call this before referring to a layer.",
    inputSchema: z.object({}),
    handler: () => ({ layers: useAppStore.getState().layers.map(summarizeLayer) }),
  }),
  defineTool({
    name: "run_sql",
    description:
      "Run a single read-only DuckDB Spatial SQL statement against the loaded layers (use the SQL table names from list_layers) and/or remote files. Returns column names, the row count, and a small preview. Set add_as_layer to add a geometry result to the map.",
    inputSchema: z.object({
      sql: z.string().describe("A single SELECT statement (no trailing semicolon needed)."),
      add_as_layer: z
        .boolean()
        .optional()
        .describe("When the result has geometry, add it to the map as a new layer."),
      layer_name: z
        .string()
        .optional()
        .describe("Name for the added layer (when add_as_layer is true)."),
    }),
    handler: async (input) => {
      if (!isReadOnlySql(input.sql)) {
        throw new Error("Only read-only SELECT/WITH queries are allowed.");
      }
      const result = await runSqlQuery(input.sql, useAppStore.getState().layers);
      let addedLayerId: string | null = null;
      if (input.add_as_layer && result.geojson) {
        addedLayerId = useAppStore
          .getState()
          .addGeoJsonLayer(input.layer_name?.trim() || "SQL result", result.geojson);
      }
      return {
        columns: result.columns,
        rowCount: result.rowCount,
        hasGeometry: Boolean(result.geojson),
        preview: result.rows.slice(0, 10),
        addedLayerId,
      };
    },
  }),
  defineTool({
    name: "add_layer_from_url",
    description: "Fetch a public GeoJSON URL and add it to the map as a new vector layer.",
    inputSchema: z.object({
      url: z.string().describe("A public URL returning GeoJSON."),
      name: z.string().optional().describe("Optional layer name."),
    }),
    handler: async (input) => {
      assertPublicHttpUrl(input.url);
      const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guard against OOM.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(input.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }
        // Check the advertised length first (cheap), then stream the body with
        // a hard byte cap — Content-Length is optional and bypassable.
        const length = response.headers.get("content-length");
        if (length && Number(length) > MAX_BYTES) {
          throw new Error(`Response too large (${length} bytes).`);
        }
        const parsed = asFeatureCollection(JSON.parse(await readTextCapped(response, MAX_BYTES)));
        // A projected GeoJSON declares a non-WGS84 CRS via a legacy top-level
        // `crs` member; reproject to WGS84 so MapLibre receives lon/lat. The
        // DuckDB loader is pulled in only when such a member is present.
        const sourceCrs = projectedGeoJsonCrs(parsed);
        const geojson = sourceCrs
          ? await (
              await import("../duckdb-vector-loader")
            ).reprojectFeatureCollectionToWgs84(parsed, sourceCrs)
          : parsed;
        const name =
          input.name?.trim() || input.url.split("/").pop()?.split("?")[0] || "Remote layer";
        const id = useAppStore.getState().addGeoJsonLayer(name, geojson, input.url);
        return {
          addedLayerId: id,
          name,
          featureCount: geojson.features.length,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  }),
  defineTool({
    name: "remove_layer",
    description: "Remove a layer from the map by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
    }),
    handler: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      useAppStore.getState().removeLayer(layer.id);
      return { removedLayerId: layer.id, name: layer.name };
    },
  }),
  defineTool({
    name: "set_layer_visibility",
    description: "Show or hide a layer by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      visible: z.boolean(),
    }),
    handler: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      useAppStore.getState().setLayerVisibility(layer.id, input.visible);
      return { layerId: layer.id, visible: input.visible };
    },
  }),
  defineTool({
    name: "set_layer_opacity",
    description: "Set a layer's opacity (0 transparent to 1 opaque) by name or id.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      opacity: z.number().min(0).max(1),
    }),
    handler: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      useAppStore.getState().setLayerOpacity(layer.id, input.opacity);
      return { layerId: layer.id, opacity: input.opacity };
    },
  }),
  defineTool({
    name: "add_tile_layer",
    description: `Add an XYZ raster tile basemap/layer to the map. Use a known name (${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")}) or a custom XYZ url template containing {z}/{x}/{y}. The layer is placed underneath existing layers so it acts as a basemap.`,
    inputSchema: z.object({
      basemap: z
        .string()
        .optional()
        .describe(
          `Known basemap name, one of: ${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")}.`,
        ),
      url: z
        .string()
        .optional()
        .describe("Custom XYZ tile URL template with {z}, {x}, {y} placeholders."),
      name: z.string().optional(),
      attribution: z.string().optional(),
    }),
    handler: (input) => {
      let url = input.url?.trim();
      let name = input.name?.trim();
      let attribution = input.attribution?.trim();
      if (input.basemap?.trim()) {
        const found = findNamedTileBasemap(input.basemap);
        if (found) {
          url = url || found.url;
          name = name || found.label;
          attribution = attribution || found.attribution;
        } else if (!url) {
          throw new Error(
            `Unknown basemap "${input.basemap}". Known: ${NAMED_TILE_BASEMAPS.map((basemap) => basemap.id).join(", ")} — or pass a url.`,
          );
        }
      }
      if (!url) {
        throw new Error("Provide a known basemap name or an XYZ url template with {z}/{x}/{y}.");
      }
      const tileUrl = createXyzTileUrlTemplate(url);
      const layer: GeoIntLayer = {
        id: crypto.randomUUID(),
        name: name || "Tile layer",
        type: "xyz",
        source: {
          type: "raster",
          tiles: [tileUrl.renderUrl],
          tileSize: 256,
          url: tileUrl.originalUrl,
          ...(attribution ? { attribution } : {}),
        },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: { sourceKind: "xyz-url" },
      };
      // Insert at the bottom of the stack (index 0) so imagery sits under data.
      const bottomBeforeId = useAppStore.getState().layers[0]?.id ?? null;
      useAppStore.getState().addLayer(layer, bottomBeforeId);
      return {
        addedLayerId: layer.id,
        name: layer.name,
        url: tileUrl.originalUrl,
      };
    },
  }),
  defineTool({
    name: "web_search",
    description:
      "Search the web for current information (news, recent data, documentation). Returns top results with title, url, and snippet, plus a short answer when available. Most reliable when TAVILY_API_KEY is configured; the keyless fallback is best-effort and may be blocked by the browser.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
    }),
    handler: async (input) => {
      try {
        const response = await webSearch(input.query);
        return {
          provider: response.provider,
          answer: response.answer ?? null,
          results: response.results.slice(0, 8),
        };
      } catch (error) {
        // Don't surface a raw fetch/CORS error as a tool crash — tell the model
        // search is unavailable so it can fall back gracefully.
        return {
          error:
            "Web search is unavailable from the browser. Configure TAVILY_API_KEY in Settings → Environment Variables for reliable search.",
          detail: error instanceof Error ? error.message : String(error),
          results: [],
        };
      }
    },
  }),
  defineTool({
    name: "set_basemap",
    description: `Switch the basemap. Accepts a known name (${OPENFREEMAP_BASEMAPS.map((basemap) => basemap.id).join(", ")}) or a full style URL.`,
    inputSchema: z.object({
      basemap: z.string().describe("A basemap name/id or a style URL."),
    }),
    handler: (input) => {
      const styleUrl = resolveBasemap(input.basemap);
      if (!styleUrl) throw new Error(`Unknown basemap "${input.basemap}".`);
      useAppStore.getState().setBasemapStyleUrl(styleUrl);
      return { basemap: styleUrl };
    },
  }),
  defineTool({
    name: "zoom_to",
    description:
      "Move the camera to fit a layer (by name or id) or an explicit bounding box [west, south, east, north].",
    inputSchema: z
      .object({
        layer: z.string().optional().describe("Layer name or id to fit."),
        bbox: z
          .array(z.number())
          .length(4)
          .optional()
          .describe("Bounding box [west, south, east, north] in WGS84."),
      })
      .refine((value) => value.layer !== undefined || value.bbox !== undefined, {
        message: "Provide either a layer or a bbox.",
      }),
    handler: (input, deps) => {
      const controller = deps.getMapController();
      if (!controller) throw new Error("The map is not ready yet.");
      if (input.bbox) {
        controller.fitBounds(input.bbox as [number, number, number, number]);
        return { fit: "bbox", bbox: input.bbox };
      }
      if (input.layer) {
        const layer = resolveLayer(input.layer);
        if (!layer) throw new Error(`No layer matching "${input.layer}".`);
        controller.fitLayer(layer);
        return { fit: "layer", layerId: layer.id };
      }
      throw new Error("Provide either a layer or a bbox.");
    },
  }),
  defineTool({
    name: "run_python",
    description:
      "Run a Python snippet in the in-app Pyodide runtime for data/compute tasks (numpy, pandas, etc.). A `geoint` object is in scope to drive the live map, e.g. `geoint.get_center()` or `geoint.add_geojson(name, data)`; `await geoint.load_package('geopandas')` installs packages. Returns captured stdout and the repr of the last expression. The first call boots the Python runtime and can take several seconds. Prefer run_sql for querying layer attributes.",
    inputSchema: z.object({
      code: z.string().describe("Python source to execute."),
    }),
    requiresConfirmation: true,
    handler: async (input, deps) => {
      if (!(await approveCodeExecution(deps, "run_python", input.code))) {
        return {
          output: "",
          error: "The user declined to run this Python code.",
        };
      }
      const pyDeps = consoleDeps(deps.getMapController);
      const result = await runConsoleCode(pyDeps, input.code);
      // Cap stdout so a snippet printing megabytes can't blow the model's
      // context window on the next turn.
      const MAX_OUTPUT = 8000;
      const output =
        result.output.length > MAX_OUTPUT
          ? `${result.output.slice(0, MAX_OUTPUT)}\n[truncated]`
          : result.output;
      return { output, error: result.error };
    },
  }),
  defineTool({
    name: "run_maplibre_js",
    description:
      "Fallback for tasks with no dedicated tool (e.g. globe projection, terrain, sky, custom paint/layout properties, controls, markers). Runs a small JavaScript snippet against the live map. The snippet is a function body with `map` (the MapLibre GL JS map) and `maplibregl` (the MapLibre GL JS module, e.g. `maplibregl.TerrainControl`, `maplibregl.Marker`) in scope, and may `return` a JSON-serializable value. Example — switch to globe: `map.setProjection({ type: 'globe' })`. Prefer dedicated tools when one exists; changes made here bypass the store and are NOT undoable.",
    inputSchema: z.object({
      code: z.string().describe("JavaScript function body; `map` and `maplibregl` are in scope."),
    }),
    requiresConfirmation: true,
    handler: async (input, deps) => {
      if (!(await approveCodeExecution(deps, "run_maplibre_js", input.code))) {
        return { ok: false, error: "The user declined to run this code." };
      }
      const map = deps.getMapController()?.getMap();
      if (!map) throw new Error("The map is not ready yet.");
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const run = new Function("map", "maplibregl", input.code) as (
        map: unknown,
        maplibregl: unknown,
      ) => unknown;
      const result = run(map, maplibregl);
      // Coerce to a JSON-safe value so non-serializable returns (e.g. the map
      // object itself) don't blow up the tool result.
      let safe: unknown = null;
      try {
        safe = JSON.parse(JSON.stringify(result ?? null));
      } catch {
        safe = String(result);
      }
      return { ok: true, result: safe };
    },
  }),
  defineTool({
    name: "apply_symbology",
    description:
      "Color a vector layer by one of its attribute fields using a graduated (numeric) or categorized (text) color ramp. Use list_layers to find field names and color ramps like reds, blues, viridis.",
    inputSchema: z.object({
      layer: z.string().describe("Layer name or id."),
      property: z.string().describe("Attribute field to style by."),
      mode: z.enum(["graduated", "categorized"]),
      color_ramp: z.string().optional().describe("Color ramp id (e.g. reds, viridis)."),
      class_count: z.number().optional().describe("Number of classes for graduated mode."),
      scheme: z.enum(["equal-interval", "quantile"]).optional(),
    }),
    handler: (input) => {
      const layer = resolveLayer(input.layer);
      if (!layer) throw new Error(`No layer matching "${input.layer}".`);
      const style = buildSymbologyStyle(layer, {
        mode: input.mode,
        property: input.property,
        colorRamp: input.color_ramp,
        classCount: input.class_count,
        scheme: input.scheme,
      });
      useAppStore.getState().setLayerStyle(layer.id, style);
      return {
        layerId: layer.id,
        mode: input.mode,
        property: input.property,
        classes: style.vectorStyleStops?.length ?? 0,
      };
    },
  }),
  defineTool({
    name: "list_algorithms",
    description:
      "List the available client-side processing algorithms (vector geometry/overlay tools like buffer, clip, dissolve, intersection, difference, union, spatial-join; plus H3 grids) with their id, name, group, and typed parameters. Call this before run_algorithm.",
    inputSchema: z.object({}),
    handler: async (_input, deps) => ({ algorithms: (await getScripting(deps)).listAlgorithms() }),
  }),
  defineTool({
    name: "run_algorithm",
    description:
      "Run a processing algorithm by id (from list_algorithms) and add its result as a new layer. `params` is an object keyed by parameter id; a 'layer' parameter takes a layer id (from list_layers). Build a pipeline by running one algorithm, then passing its returned result layer id into the next. Returns the run log and the new layer id(s).",
    inputSchema: z.object({
      id: z.string().describe("Algorithm id, e.g. 'buffer', 'clip', 'dissolve'."),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parameter values keyed by parameter id; layer params take a layer id."),
    }),
    handler: async (input, deps) => {
      const result = await (
        await getScripting(deps)
      ).runAlgorithm({
        id: input.id,
        params: (input.params as Record<string, unknown>) ?? {},
      });
      return {
        logs: result.logs ?? [],
        resultLayerIds: result.resultLayerIds ?? [],
      };
    },
  }),
  defineTool({
    name: "search_stac",
    description:
      "Search the Microsoft Planetary Computer STAC catalog for earth-observation items in a collection (e.g. 'sentinel-2-l2a', 'landsat-c2-l2', 'naip', 'cop-dem-glo-30'). Defaults the bounding box to the current map view and sorts newest-first. Returns matching items (id, datetime, cloud cover, bbox).",
    inputSchema: z.object({
      collection: z.string().describe("STAC collection id, e.g. 'sentinel-2-l2a'."),
      bbox: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("[west, south, east, north]; defaults to the current view."),
      datetime: z
        .string()
        .optional()
        .describe("RFC3339 datetime or range, e.g. '2024-06-01/2024-09-30'."),
      limit: z.number().optional().describe("Max items (default 10)."),
    }),
    handler: async (input, deps) => {
      const { STACClient } = await import("maplibre-gl-planetary-computer");
      const bbox =
        (input.bbox as [number, number, number, number] | undefined) ??
        viewBboxFor(deps) ??
        undefined;
      const items = await new STACClient().search({
        collections: [input.collection],
        bbox,
        datetime: input.datetime,
        limit: input.limit ?? 10,
        sortby: [{ field: "datetime", direction: "desc" }],
      });
      return {
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          datetime: item.properties.datetime,
          cloudCover: item.properties["eo:cloud_cover"] ?? null,
          bbox: item.bbox,
        })),
      };
    },
  }),
  defineTool({
    name: "add_stac_layer",
    description:
      "Add a Planetary Computer STAC item as a raster tile layer (tiles are signed server-side — no credentials needed). Give a collection and optionally a specific itemId from search_stac; otherwise the newest item over the current view is used. Renders with the collection's default band/colormap preset.",
    inputSchema: z.object({
      collection: z.string().describe("STAC collection id, e.g. 'sentinel-2-l2a'."),
      itemId: z
        .string()
        .optional()
        .describe("A specific item id; otherwise the latest over the view is used."),
      bbox: z.array(z.number()).length(4).optional(),
      datetime: z.string().optional(),
      name: z.string().optional(),
    }),
    handler: async (input, deps) => {
      const { STACClient, TiTilerClient, getDefaultPreset } =
        await import("maplibre-gl-planetary-computer");
      const stac = new STACClient();
      let item;
      if (input.itemId) {
        item = await stac.getItem(input.collection, input.itemId);
      } else {
        const bbox =
          (input.bbox as [number, number, number, number] | undefined) ??
          viewBboxFor(deps) ??
          undefined;
        const items = await stac.search({
          collections: [input.collection],
          bbox,
          datetime: input.datetime,
          limit: 1,
          sortby: [{ field: "datetime", direction: "desc" }],
        });
        if (!items.length) {
          throw new Error(`No ${input.collection} items found for the given area/time.`);
        }
        item = items[0];
      }
      const preset = getDefaultPreset(input.collection);
      const tileUrl = new TiTilerClient().getItemTileUrl(input.collection, item.id, preset?.params);
      const bounds = bbox2d(item.bbox);
      const layer: GeoIntLayer = {
        id: crypto.randomUUID(),
        name: input.name?.trim() || `${input.collection} ${item.properties.datetime ?? item.id}`,
        type: "xyz",
        source: {
          type: "raster",
          tiles: [tileUrl],
          tileSize: 256,
          attribution: "Microsoft Planetary Computer",
        },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: {
          sourceKind: "stac-planetary-computer",
          stacCollectionId: input.collection,
          stacItemId: item.id,
        },
      };
      const bottomBeforeId = useAppStore.getState().layers[0]?.id ?? null;
      useAppStore.getState().addLayer(layer, bottomBeforeId);
      if (bounds) deps.getMapController()?.fitBounds(bounds);
      return {
        addedLayerId: layer.id,
        itemId: item.id,
        datetime: item.properties.datetime ?? null,
      };
    },
  }),
];

/** List every tool's id and description without executing anything. */
export function listAssistantTools(): Array<Pick<AssistantTool, "name" | "description">> {
  return ASSISTANT_TOOLS.map(({ name, description }) => ({ name, description }));
}

/** Look up a tool by name. */
export function getAssistantTool(name: string): AssistantTool | undefined {
  return ASSISTANT_TOOLS.find((tool) => tool.name === name);
}

/** Validate `rawInput` against the tool's schema and run its handler. */
export async function runAssistantTool(
  name: string,
  rawInput: unknown,
  deps: AssistantToolDeps,
): Promise<unknown> {
  const tool = getAssistantTool(name);
  if (!tool) throw new Error(`Unknown tool "${name}".`);
  return tool.handler(tool.inputSchema.parse(rawInput), deps);
}
