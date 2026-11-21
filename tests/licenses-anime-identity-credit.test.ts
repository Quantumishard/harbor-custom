import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const load = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const panel = load("src/views/settings/licenses-panel.tsx");
const notice = load("src/assets/licenses/anime-identity-data.txt");
const pack = load("src-tauri/src/identity/pack.rs");

test("Licenses credits the downloaded anime database's current maintainer and original author", () => {
  assert.match(pack, /repos\/cedya77\/anime-offline-database\/releases\/tags\/latest/);
  assert.match(panel, /name: "anime-offline-database \(cedya77\)"/);
  assert.match(panel, /name: "manami-project \(original creator\)"/);
  assert.match(panel, /name: "Anime-Lists contributors"/);
  for (const upstream of [
    "https://github.com/cedya77/anime-offline-database",
    "https://github.com/manami-project/anime-offline-database",
    "https://github.com/Anime-Lists/anime-lists",
  ]) {
    assert.ok(panel.includes(upstream), `missing clickable source ${upstream}`);
    assert.ok(notice.includes(upstream), `missing source in notice ${upstream}`);
  }
  assert.match(pack, /Anime-Lists\/anime-lists\/master\/anime-list-master\.xml/);
});

test("The download notice is registered and distinguishes data licenses from app code", () => {
  assert.match(panel, /id: "anime-identity-data"/);
  assert.match(panel, /file: "anime-identity-data"/);
  assert.match(panel, /import\.meta\.glob\("\.\.\/\.\.\/assets\/licenses\/\*\.txt"/);
  assert.match(notice, /Open Database License \(ODbL\) v1\.0/);
  assert.match(notice, /Database Contents License \(DbCL\) v1\.0/);
  assert.match(notice, /separately licensed from Harbor's MIT-licensed software/);
});
