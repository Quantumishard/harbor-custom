import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const css = read("../src/components/queue-basket/queue-basket.css");
const basket = read("../src/components/queue-basket/queue-basket.tsx");
const history = read("../src/components/queue-basket/queue-history-panel.tsx");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);

  const bodyStart = start + selector.length + 2;
  const end = css.indexOf("}", bodyStart);
  assert.notEqual(end, -1, `unclosed CSS rule: ${selector}`);

  return css.slice(bodyStart, end);
}

test("watching queue stays between the top chrome and bottom dock", () => {
  const dialog = rule(".queue-basket-dialog");

  assert.match(dialog, /--queue-basket-top-clearance:\s*max\(80px,/);
  assert.match(dialog, /--queue-basket-bottom-clearance:[\s\S]*--harbor-dock-gap/);
  assert.match(
    dialog,
    /100dvh\s*-\s*var\(--queue-basket-top-clearance\)\s*-\s*var\(--queue-basket-bottom-clearance\)/,
  );
  assert.match(dialog, /max-height:\s*var\(--queue-basket-max-height\)/);
  assert.match(dialog, /overflow:\s*hidden/);
  assert.doesNotMatch(dialog, /80dvh/);
});

test("watching queue shell owns the height constraint while lists own scrolling", () => {
  const panel = rule(".queue-basket-panel");

  assert.match(panel, /max-height:\s*var\(--queue-basket-max-height\)/);
  assert.match(panel, /overflow:\s*hidden/);

  assert.match(basket, /className="queue-basket-panel"/);
  assert.doesNotMatch(basket, /max-h-\[min\(80dvh,680px\)\]/);
  assert.match(basket, /ref=\{listRef\}[\s\S]{0,160}overflow-y-auto/);
  assert.match(history, /<ol className="[^"]*overflow-y-auto[^"]*"/);
});

test("watching queue keeps responsive bounds for both text directions", () => {
  assert.match(css, /\.queue-basket-dialog:dir\(ltr\)/);
  assert.match(css, /\.queue-basket-dialog:dir\(rtl\)/);
  assert.match(basket, /<ArrowLeft[\s\S]{0,100}className="rtl:rotate-180"/);
  assert.match(css, /@media \(max-width:\s*480px\)/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /safe-area-inset-right/);
});
