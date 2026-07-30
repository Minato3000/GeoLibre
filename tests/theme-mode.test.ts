import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getInitialThemeMode } from "../apps/geolibre-desktop/src/hooks/useThemeMode";

const originalWindow = (globalThis as { window?: unknown }).window;

/** Mock `window` with a search string and an OS dark-mode preference. */
function withWindow(search: string, prefersDark: boolean): void {
  (globalThis as { window?: unknown }).window = {
    location: { search },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
    }),
  };
}

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("getInitialThemeMode", () => {
  it("defaults to light regardless of the OS preference, without a theme param", () => {
    withWindow("", true);
    assert.equal(getInitialThemeMode(), "light");
    withWindow("", false);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("honors ?theme=dark and ?theme=light over the light default", () => {
    withWindow("?theme=dark", false);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=light", true);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    withWindow("?theme=DARK", false);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=%20Light%20", true);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("ignores an unrecognized or empty theme value and defaults to light", () => {
    withWindow("?theme=neon", true);
    assert.equal(getInitialThemeMode(), "light");
    withWindow("?theme=neon", false);
    assert.equal(getInitialThemeMode(), "light");
    // A bare `?theme=` yields "" and should also default to light.
    withWindow("?theme=", true);
    assert.equal(getInitialThemeMode(), "light");
    withWindow("?theme=", false);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("returns light when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(getInitialThemeMode(), "light");
  });
});
