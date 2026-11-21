import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function loadThemeStore() {
  const compiled = ts.transpileModule(source("src/lib/theme-store.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "@/lib/custom-themes": {},
    "@/lib/theme-scan": {},
    "@/lib/safe-fetch": {},
    "./theme-auth": { authToken: () => null },
    "@/lib/theme-updates": {},
    "@/lib/config/endpoints": { HARBOR_API_BASE: "https://api.test.invalid" },
  };
  const exports: Record<string, any> = {};
  new Function("require", "exports", compiled)((id: string) => {
    assert.ok(id in dependencies, `unexpected theme-store import: ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}

test("theme submissions and updates send at most six screenshots, never silently omitting the sixth", async () => {
  const store = loadThemeStore();
  assert.equal(store.THEME_SUBMISSION_SCREENSHOT_LIMIT, 6);
  const originalFetch = globalThis.fetch;
  const bodies: FormData[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    bodies.push(init.body);
    return { ok: true, json: async () => ({ id: "theme-id", screenshots: [], share: "" }) };
  }) as typeof fetch;
  try {
    const screenshots = Array.from(
      { length: 7 },
      (_, i) => new Blob([`screenshot-${i}`], { type: "image/png" }),
    );
    await store.uploadTheme("{}", new Blob(["cover"]), screenshots.slice(0, 5), "Author");
    await store.uploadTheme("{}", new Blob(["cover"]), screenshots, "Author");
    await store.updateTheme("theme-id", "{}", null, screenshots, "Update notes");
    assert.equal(bodies[0].getAll("screenshots").length, 5);
    for (const body of bodies.slice(1)) {
      const files = body.getAll("screenshots") as File[];
      assert.equal(files.length, 6);
      assert.deepEqual(await Promise.all(files.map((file) => file.text())), [
        "screenshot-0",
        "screenshot-1",
        "screenshot-2",
        "screenshot-3",
        "screenshot-4",
        "screenshot-5",
      ]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("theme submission and update UIs share the six-screenshot limit and show matching copy", () => {
  const create = source(
    "src/views/settings/theme-panel/custom-themes-section/theme-upload-flow.tsx",
  );
  const update = source(
    "src/views/settings/theme-panel/custom-themes-section/theme-update-flow.tsx",
  );
  const updateSteps = source(
    "src/views/settings/theme-panel/custom-themes-section/theme-update-flow/update-steps.tsx",
  );
  for (const file of [create, update]) {
    assert.match(file, /THEME_SUBMISSION_SCREENSHOT_LIMIT - shots\.length/);
    assert.match(file, /\.slice\(0, THEME_SUBMISSION_SCREENSHOT_LIMIT\)/);
  }
  assert.match(create, /shots\.length < THEME_SUBMISSION_SCREENSHOT_LIMIT/);
  assert.match(updateSteps, /shots\.length < THEME_SUBMISSION_SCREENSHOT_LIMIT/);
  for (const file of [create, updateSteps]) {
    assert.match(file, /Add up to \{n\} screenshots to show your theme in action/);
    assert.match(file, /n: THEME_SUBMISSION_SCREENSHOT_LIMIT/);
  }
  const notes = source("installer/changelog/1.0.4-changelog.json");
  assert.match(
    notes,
    /Theme Submission Screenshots: Theme uploads now allow up to six optional screenshots/,
  );
  assert.doesNotMatch(notes, /up to five optional screenshots/);
});
