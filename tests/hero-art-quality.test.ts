import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "hero.tsx",
  readFileSync("src/components/hero.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const helpers = ["upsizeTmdb", "fullBackdropSize"].map((name) => {
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(fn, `Missing hero declaration: ${name}`);
  return fn.getText(source);
});
const js = ts.transpileModule(helpers.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function heroImage(innerWidth: number, pixelRatio: number) {
  return new Function("window", "devicePixelRatio", `${js}; return upsizeTmdb;`)(
    {
      innerWidth,
    },
    pixelRatio,
  ) as (url?: string, full?: boolean) => string | undefined;
}

test("explicit full hero quality asks for the largest backdrop the display needs", () => {
  for (const [width, ratio, size] of [
    [960, 1, "w1280"],
    [1280, 1, "w1280"],
    [1440, 1, "w1920"],
    [1920, 1, "w1920"],
    [960, 2, "w1920"],
    [2560, 1, "original"],
  ] as const) {
    const image = heroImage(width, ratio);
    assert.equal(
      image("https://image.tmdb.org/t/p/w780/hero.jpg", true),
      `https://image.tmdb.org/t/p/${size}/hero.jpg`,
      `${width}px at ${ratio}x`,
    );
  }
});

test("turning full quality off restores the optimized hero image", () => {
  const image = heroImage(2160, 2);
  assert.equal(
    image("https://image.tmdb.org/t/p/original/hero.jpg", false),
    "https://image.tmdb.org/t/p/w1280/hero.jpg",
  );
  assert.equal(
    image("https://image.tmdb.org/t/p/w780/hero.jpg"),
    "https://image.tmdb.org/t/p/w1280/hero.jpg",
  );
});

test("missing artwork and other providers are preserved", () => {
  const image = heroImage(1080, 1);
  assert.equal(image(undefined, true), undefined);
  const remote = "https://example.com/artwork/hero.jpg";
  assert.equal(image(remote, true), remote);
  assert.equal(image(remote, false), remote);
});
