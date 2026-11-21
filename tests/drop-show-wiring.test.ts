import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("PublicMetaDB appears in both detail hero tracker layouts", () => {
  const detail = read("src/views/detail.tsx");

  assert.match(detail, /import \{ AddToPmdbButton \}/);
  assert.match(detail, /<AddToPmdbButton/);
  // The button and overflow now share an ID availability guard.
  assert.match(detail, /pmdb=\{\s*listTrackerId\s*\?\s*\{/);
});

test("Drop show is exposed from details and the right-click menu", () => {
  const detail = read("src/views/detail.tsx");
  const menu = read("src/components/context-menu.tsx");
  const overflow = read("src/views/detail/hero-action-overflow.tsx");
  const libraryAction = read("src/views/detail/library-action-button.tsx");
  const confirm = read("src/components/drop-show-confirm-modal.tsx");

  assert.match(detail, /dropContextTitle\(/);
  assert.match(detail, /<DropShowConfirmModal/);
  assert.match(detail, /canDrop=\{canDropTitle\}/);
  assert.match(detail, /onDrop=\{\(\) => setDropConfirmOpen\(true\)\}/);
  assert.match(menu, /key="drop-show"/);
  assert.match(menu, /<DropShowConfirmModal/);
  assert.match(libraryAction, /canDrop/);
  assert.match(libraryAction, /label=\{t\("Drop show"\)\}/);
  assert.doesNotMatch(overflow, /Drop show/);
  assert.doesNotMatch(overflow, /canDrop/);
  assert.match(confirm, /<ModalShell/);
  assert.match(confirm, /harbor-press-pop/);
  assert.match(confirm, /PublicMetaDB will mark this show as Dropped/);
  assert.match(confirm, /pmdbSession\?\.apiKey &&/);
  assert.match(confirm, /PMDB watchlist if present/);
  assert.match(confirm, /Watched episode history is kept/);
  assert.doesNotMatch(confirm, /PublicMetaDB does not have a Dropped status/);
  assert.doesNotMatch(detail, /confirmDialog\(/);
  assert.doesNotMatch(menu, /confirmDialog\(/);
});

test("connected trackers use provider-appropriate drop behavior", () => {
  const providers = read("src/lib/media-provider-actions.ts");

  assert.match(providers, /status: "DROPPED"/);
  assert.match(providers, /status: "dropped"/);
  assert.match(providers, /setSimklStatus\(target, "dropped"\)/);
  assert.match(providers, /"\/users\/hidden\/dropped"/);
  assert.match(providers, /dropPmdbShow/);
  assert.match(providers, /pmdbDeleteResumesForTitle/);
});
