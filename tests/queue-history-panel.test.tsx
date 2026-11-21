import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

type HistoryFixture = {
  id: string;
  meta: {
    id: string;
    name: string;
    type: "movie";
  };
  addedAt: number;
  recordedAt: number;
  reason: "completed" | "skipped";
};

test("queue history displays the completed or skipped date from recordedAt", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://fixture.invalid",
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const language = "en-US";
  const empty = () => null;

  const dependencies: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {
      CheckCircle2: empty,
      History: empty,
      ListVideo: empty,
      Play: empty,
      SkipForward: empty,
      Trash2: empty,
    },
    "@/lib/i18n": {
      useUiLanguage: () => language,
      useT: () => (key: string, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
          key,
        ),
    },
  };

  const output = ts.transpileModule(
    readFileSync("src/components/queue-basket/queue-history-panel.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

  const api: Record<string, React.ComponentType> = {};

  new Function("require", "exports", output)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, api);

  const completedRecordedAt = Date.UTC(2026, 10, 18, 12);
  const skippedRecordedAt = Date.UTC(2026, 11, 2, 12);

  const history: HistoryFixture[] = [
    {
      id: "completed",
      meta: {
        id: "completed-movie",
        name: "Completed movie",
        type: "movie",
      },
      addedAt: Date.UTC(2000, 0, 1, 12),
      recordedAt: completedRecordedAt,
      reason: "completed",
    },
    {
      id: "skipped",
      meta: {
        id: "skipped-movie",
        name: "Skipped movie",
        type: "movie",
      },
      addedAt: Date.UTC(2000, 1, 1, 12),
      recordedAt: skippedRecordedAt,
      reason: "skipped",
    },
  ];

  const QueueHistoryPanel = api.QueueHistoryPanel;
  assert.ok(QueueHistoryPanel);

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);

  try {
    await React.act(() =>
      root.render(
        React.createElement(QueueHistoryPanel, {
          history,
          onPlay: () => {},
          onClear: () => {},
        }),
      ),
    );

    const formatter = new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
    });
    const text = document.body.textContent ?? "";

    assert.ok(text.includes(`Completed on ${formatter.format(completedRecordedAt)}`));
    assert.ok(text.includes(`Skipped on ${formatter.format(skippedRecordedAt)}`));

    for (const item of history) {
      assert.equal(text.includes(formatter.format(item.addedAt)), false);
    }
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
  }
});

test("every queue locale preserves the history date placeholder", () => {
  const locales = [
    "ar",
    "de",
    "es",
    "fr",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "pl",
    "pt",
    "ru",
    "tr",
    "vi",
    "zh",
  ];

  for (const locale of locales) {
    const source = readFileSync(`src/lib/i18n/locales/${locale}/queue-basket.ts`, "utf8");

    for (const key of ["Completed on {date}", "Skipped on {date}"]) {
      const property = `"${key}":`;
      const start = source.indexOf(property);

      assert.notEqual(start, -1, `${locale} is missing ${key}`);

      const end = source.indexOf("\n", start);
      const value = source.slice(start + property.length, end);

      assert.ok(value.includes("{date}"), `${locale} does not preserve {date} in ${key}`);
    }
  }
});
