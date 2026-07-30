# AI Assistant

The **AI Assistant** is a right-docked chat panel. Open it from
**Processing → AI Assistant** or the command palette. It docks as a resizable
panel (drag its left edge to resize, **✕** to close).

## Current status: not connected to a model backend

The panel is a plain chat window: it keeps a conversation history, shows a
loading state while a message is in flight, and renders replies as markdown.
There is currently **no LLM provider wired up** — sending a message always
returns a visible error ("The AI Assistant is not connected to a model backend
yet.") rather than a fabricated reply. Nothing is sent to any external service.

Type a request and press **Ctrl/Cmd + Enter** (or click **Send**). While a
message is in flight, **Send** becomes **Stop** — click it to cancel. **Clear**
(the eraser icon) starts a fresh conversation. Prompt history is recalled with
the **Up/Down** arrows from an empty/edge caret position.

## Tool catalog

A catalog of GeoInt-native tools — inspecting layers, running read-only
Spatial SQL, styling layers, running the registered processing algorithms,
searching STAC imagery, adding tile/vector layers, moving the map, web search,
and JavaScript/Python code fallbacks — lives in
`apps/geolibre-desktop/src/lib/assistant/tool-registry.ts` as a
framework-agnostic registry (`ASSISTANT_TOOLS`, plus `listAssistantTools()` /
`getAssistantTool()` / `runAssistantTool()` helpers). Each tool has a name, a
description, a [zod](https://zod.dev) input schema, and a handler function that
acts through the app's store, the SQL Workspace, or the symbology helpers —
never by mutating the map directly — so any future invocation stays covered by
undo/redo.

**Nothing calls this registry yet.** It exists so a future model integration
has a clean, documented surface to call into, rather than requiring another
redesign of the tool layer once a backend is wired up.

## What's next

Wiring up a real backend means replacing the placeholder
`AssistantSession.stream()` in
`apps/geolibre-desktop/src/lib/assistant/session.ts` with an actual request to
a model, and having that integration call into the tool registry above when
the model decides to use a tool.
