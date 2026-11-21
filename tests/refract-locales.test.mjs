import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

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
const localePath = (locale) => new URL(`../src/lib/i18n/locales/${locale}.ts`, import.meta.url);

function catalog(locale) {
  const file = ts.createSourceFile(
    locale,
    readFileSync(localePath(locale), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(file.parseDiagnostics.length, 0, `${locale}: invalid TypeScript catalog`);
  const entries = new Map();
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      ts.isStringLiteral(node.initializer)
    ) {
      const key = node.name.text;
      assert.equal(entries.has(key), false, `${locale}: duplicate key ${key}`);
      entries.set(key, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return entries;
}

const english = catalog("ui-fallback");
const refractKeys = [...english.keys()].filter(
  (key) =>
    /refract/i.test(key) ||
    [
      "Network error; retry scheduled",
      "Movie not found in Refract",
      "Episode not found; verify season numbering",
    ].includes(key),
);
const placeholders = (value) =>
  [...value.matchAll(/\{[a-zA-Z][\w]*\}/g)].map((match) => match[0]).sort();
const scopes = ["profile:read", "library:read", "library:write", "history:write"];

for (const locale of locales) {
  test(`Refract translations in ${locale} cover English keys and preserve API tokens`, () => {
    const translated = catalog(locale);
    for (const key of refractKeys) {
      assert.ok(translated.has(key), `${locale}: missing ${key}`);
      const value = translated.get(key);
      assert.ok(value.trim(), `${locale}: empty translation for ${key}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(english.get(key)),
        `${locale}: placeholders for ${key}`,
      );
      for (const scope of scopes) {
        if (english.get(key).includes(scope)) {
          assert.ok(value.includes(scope), `${locale}: missing ${scope} in ${key}`);
        }
      }
    }
  });
}
