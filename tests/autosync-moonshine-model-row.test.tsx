import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { Dropdown } from "../src/components/dropdown.tsx";
import {
  MOONSHINE_LANGUAGES,
  isMoonshineLanguage,
} from "../src/lib/subtitles/autosync/moonshine-models.ts";

type Status = { language: string; supported: boolean; runtimeInstalled: boolean; installed: boolean };
type Request = { command: string; language?: string; resolve: (result: Status | undefined) => void };

function loadRow(invoke: (command: string, args?: { language?: string }) => Promise<unknown>,
                 getPreference: () => string) {
  const source = readFileSync(new URL("../src/views/settings/moonshine-model-row.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    react: React,
    "@/components/dropdown": { Dropdown },
    "react/jsx-runtime": jsxRuntime,
    "@tauri-apps/api/core": { invoke },
    "@/lib/settings": {
      useSettings: () => ({
        settings: { subtitleMoonshineLanguage: getPreference() },
        update: () => {},
      }),
    },
    "@/lib/i18n": { useT: () => (key: string) => key },
    "./kit": {
      SettingRow: ({ label, desc, children }: { label: string; desc: React.ReactNode; children: React.ReactNode }) =>
        React.createElement("section", null, React.createElement("h2", null, label), desc, children),
      ROW_ACTION_PRIMARY: "primary",
      ROW_ACTION_DANGER: "danger",
    },
    "@/lib/subtitles/autosync/moonshine-models": { MOONSHINE_LANGUAGES, isMoonshineLanguage },
  };
  const exports: Record<string, any> = {};
  new Function("require", "exports", output)((name: string) => {
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  }, exports);
  return exports.MoonshineModelRow as React.ComponentType;
}

async function harness(initialInstalled: boolean) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.invalid" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let preference = "en";
  const requests: Request[] = [];
  const invoke = (command: string, args?: { language?: string }): Promise<unknown> =>
    new Promise((resolve) => requests.push({ command, language: args?.language, resolve }));
  const Row = loadRow(invoke, () => preference);
  const root = createRoot(document.getElementById("root")!);
  const render = async () => {
    await React.act(async () => { root.render(React.createElement(Row)); });
  };
  const take = (command: string, language?: string) => {
    const index = requests.findIndex((request) =>
      request.command === command && request.language === language);
    assert.ok(index !== -1, `Expected pending ${command} for ${language}; got ${JSON.stringify(requests.map(({ command, language }) => [command, language]))}`);
    return requests.splice(index, 1)[0];
  };
  const finishStatus = async (language: string, installed: boolean) => {
    const request = take("moonshine_model_status", language);
    await React.act(async () => {
      request.resolve({ language, supported: true, runtimeInstalled: true, installed });
    });
  };
  const button = (label: string) => {
    const result = Array.from(document.querySelectorAll("button"))
      .find((element) => element.textContent?.trim() === label);
    assert.ok(result, `Button ${label} not found`);
    return result;
  };
  await render();
  await finishStatus("en", initialInstalled);
  return {
    requests, take, finishStatus, button,
    changePreference: async (next: string) => {
      preference = next;
      await render();
    },
    close: async () => {
      await React.act(async () => { root.unmount(); });
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}

for (const mode of ["download", "remove"] as const) {
  test(`Moonshine ${mode} completion cannot replace another selected language's model status`, async () => {
    const h = await harness(mode === "remove");
    try {
      const buttonLabel = mode === "download" ? "Download language model" : "Remove model";
      const command = mode === "download" ? "moonshine_model_download" : "moonshine_model_remove";
      await React.act(async () => { h.button(buttonLabel).click(); });
      const operation = h.take(command, "en");

      const preference = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Moonshine language selection:"]',
      )!;
      const managed = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Language model to manage:"]',
      )!;
      assert.equal(preference.disabled, true, "override must not change during an operation");
      assert.equal(managed.disabled, true);

      // A settings change from elsewhere can still change the managed language.
      await h.changePreference("ja");
      assert.match(managed.textContent ?? "", /Japanese/);
      await h.finishStatus("ja", true);
      assert.match(document.body.textContent ?? "", /Language model installed/);

      await React.act(async () => { operation.resolve(undefined); });
      assert.equal(h.requests.some((r) =>
        r.command === "moonshine_model_status" && r.language === "en"), false,
        "the old operation must not issue a status request for its old language");
      await h.finishStatus("ja", true);
      assert.match(managed.textContent ?? "", /Japanese/);
      assert.ok(h.button("Remove model"), "the completed old operation cannot overwrite Japanese state");
    } finally {
      await h.close();
    }
  });
}
