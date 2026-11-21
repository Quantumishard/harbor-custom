import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

const manifest = {
  id: "com.test.torrentio",
  name: "Torrentio",
  version: "0.0.15",
  resources: ["stream"],
  types: ["movie"],
};

(globalThis as any).fetch = async (url: string) => {
  const group = /\/group-(\d+)\//.exec(url)?.[1];
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () =>
      group ? { ...manifest, id: `com.test.group.${group}`, name: `Group ${group}` } : manifest,
  };
};

import { installFromUrl, loadInstalled } from "@/lib/addon-store";

const TB = "https://torrentio.invalid/tb/manifest.json";
const AD = "https://torrentio.invalid/ad/manifest.json";

test("a second configuration of one addon id keeps both installs", async () => {
  localStorage.clear();
  await installFromUrl(TB);
  await installFromUrl(AD, { newInstance: true });
  assert.deepEqual(
    loadInstalled().map((a) => a.transportUrl),
    [TB, AD],
  );
});

test("a configure link replaces only the instance it came from", async () => {
  localStorage.clear();
  await installFromUrl(TB);
  await installFromUrl(AD, { newInstance: true });
  const reconfigured = "https://torrentio.invalid/ad2/manifest.json";
  const result = await installFromUrl(reconfigured, { replaceUrl: AD });
  assert.equal(result.replaced, true);
  assert.deepEqual(
    loadInstalled().map((a) => a.transportUrl),
    [TB, reconfigured],
  );
});

test("a lone install is still updated in place", async () => {
  localStorage.clear();
  await installFromUrl(TB);
  const result = await installFromUrl(AD);
  assert.equal(result.replaced, true);
  assert.deepEqual(
    loadInstalled().map((a) => a.transportUrl),
    [AD],
  );
});

test("different manifest ids on one host stay separate addons", async () => {
  localStorage.clear();
  const one = "https://groups.invalid/group-1/manifest.json";
  const two = "https://groups.invalid/group-2/manifest.json";
  await installFromUrl(one);
  const result = await installFromUrl(two);
  assert.equal(result.replaced, false);
  assert.deepEqual(
    loadInstalled().map((a) => a.transportUrl),
    [one, two],
  );
});
