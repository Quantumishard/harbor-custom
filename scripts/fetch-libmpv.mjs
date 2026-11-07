import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const SHA256 = "25fff07c193e9d4ac49b619cbf8b94ecce33e164fd5a1d9777103152910a6de1";
const ARCHIVE_SHA256 = "23c4e5ea37111ad58fdb8aacb4e71afa333326838ed11eec374fef032e15c0d6";
const MANIFEST_SHA256 = "c33256f83db16e98a44318c9454f7168ebb90c7c22ed6a85950f94d9e25ae6a9";
const TAG = process.env.HARBOR_LIBMPV_TAG ?? "custom-1.0.2-beta-hdr-render-cache-20261107";
// Built from the pinned mpv source and patch in hdr-player-runtime.yml. The
// archive includes the matching dependency closure, licenses and source recipe.
const url =
  process.env.HARBOR_LIBMPV_URL ??
  `https://github.com/Quantumishard/harbor-custom/releases/download/${TAG}/Harbor-player-windows-x64.zip`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(root, "src-tauri", "libmpv");
const digest = (buf) => createHash("sha256").update(buf).digest("hex");

function targetFor(name) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid player runtime path: ${name}`);
  }
  const target = resolve(dest, name);
  if (!target.startsWith(dest + sep)) throw new Error("Player runtime path escaped its directory");
  return target;
}

function validatedManifest(bytes) {
  if (digest(bytes) !== MANIFEST_SHA256)
    throw new Error("Player runtime manifest checksum mismatch");
  const manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (manifest["libmpv-2.dll"] !== SHA256) throw new Error("Unexpected player DLL in manifest");
  for (const [name, sha] of Object.entries(manifest)) {
    targetFor(name);
    if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha))
      throw new Error("Invalid runtime checksum");
  }
  return manifest;
}

if (process.platform !== "win32" && !process.env.HARBOR_LIBMPV_FORCE) {
  console.log("[libmpv] not Windows, skipping (mac and linux link system libmpv)");
  process.exit(0);
}

const marker = join(dest, "SHA256-MANIFEST.json");
if (existsSync(marker)) {
  try {
    const manifest = validatedManifest(readFileSync(marker));
    if (
      Object.entries(manifest).every(([name, sha]) => {
        const file = targetFor(name);
        return existsSync(file) && digest(readFileSync(file)) === sha;
      })
    ) {
      console.log("[libmpv] custom player and dependencies already present and verified");
      process.exit(0);
    }
  } catch {
    /* A missing or old runtime is replaced by the pinned archive below. */
  }
}

console.log(`[libmpv] fetching ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`Player download failed (${res.status} ${res.statusText})`);
const archive = Buffer.from(await res.arrayBuffer());
if (digest(archive) !== ARCHIVE_SHA256) throw new Error("Player runtime archive checksum mismatch");
const files = unzipSync(archive);
const manifestBytes = files["SHA256-MANIFEST.json"];
if (!manifestBytes) throw new Error("Player runtime archive has no manifest");
const manifest = validatedManifest(manifestBytes);
// Validate the complete archive before touching the existing runtime.
for (const [name, sha] of Object.entries(manifest)) {
  if (!files[name] || digest(files[name]) !== sha)
    throw new Error(`Player file checksum mismatch: ${name}`);
}
for (const name of Object.keys(files)) {
  if (name.endsWith("/")) continue;
  targetFor(name);
  if (name !== "SHA256-MANIFEST.json" && !(name in manifest))
    throw new Error(`Unlisted player file: ${name}`);
}
for (const name of [...Object.keys(manifest), "SHA256-MANIFEST.json"]) {
  const target = targetFor(name);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.harbor-download`;
  writeFileSync(temporary, files[name]);
  renameSync(temporary, target);
}
console.log(`[libmpv] staged ${Object.keys(manifest).length} verified player runtime files`);
