// @ts-expect-error Node test types are outside browser config.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside browser config.
import test from "node:test";
import { contentActions as buildContentActions } from "../src/components/context-menu/content-actions.tsx";

const contentActions = (content: Parameters<typeof buildContentActions>[0]) =>
  buildContentActions(content, () => {}, true);

test("a linked poster keeps its independent page link alongside image commands", () => {
  const actions = contentActions({
    image: {
      src: "https://images.example.org/poster.png",
      publicUrl: "https://images.example.org/poster.png",
    },
    link: "https://games.example.org/game",
  });
  assert.deepEqual(
    actions.map((action) => action.id),
    ["link:open", "link:copy", "image:view", "image:save", "image:copy-link", "image:open-link"],
  );
});

test("image tools remain available without duplicating a link to the same image", () => {
  for (const image of [
    { src: "https://images.example.org/poster.png" },
    {
      src: "https://images.example.org/poster.png",
      publicUrl: "https://images.example.org/poster.png",
    },
    {
      src: "https://images.example.org/small.png",
      originalSrc: "https://images.example.org/full.png",
    },
    { src: "blob:https://example.org/fixture" },
    { src: "data:image/png;base64,iVBORw0KGgo=" },
  ]) {
    const ids = contentActions({ image }).map((a) => a.id);
    assert.ok(ids.includes("image:view"));
    assert.ok(ids.includes("image:save"));
    assert.deepEqual(
      contentActions({ image, link: image.src }).map((a) => a.id),
      ids,
    );
    if (image.originalSrc)
      assert.deepEqual(
        contentActions({ image, link: image.originalSrc }).map((a) => a.id),
        ids,
      );
  }
});

test("selected text keeps its own command alongside image tools", () => {
  const actions = contentActions({
    selection: "selected words",
    image: { src: "blob:https://example.org/fixture" },
  });
  assert.deepEqual(
    actions.map((action) => action.id),
    ["selection:copy", "image:view", "image:save"],
  );
});

test("ordinary links preserve opening and safe copying without adding image tools", () => {
  const actions = contentActions({ link: "https://site.example.org/page" });
  assert.deepEqual(
    actions.map((action) => action.id),
    ["link:open", "link:copy"],
  );
  const privateLink = contentActions({ link: "https://site.example.org/page?token=fixture" });
  assert.deepEqual(
    privateLink.map((action) => action.id),
    ["link:open"],
  );
});
