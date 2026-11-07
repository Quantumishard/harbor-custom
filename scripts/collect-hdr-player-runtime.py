"""Collect the pinned libmpv build and its non-system DLL dependency closure."""
from pathlib import Path
import ctypes as c
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

build, out = map(Path, sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
source = next(build.rglob("libmpv-2.dll"), None)
if source is None:
    raise RuntimeError("Built libmpv-2.dll not found")
prefix = Path(subprocess.check_output(["cygpath", "-w", os.environ["MINGW_PREFIX"]], text=True).strip())
lookup = {p.name.lower(): p for p in (prefix / "bin").glob("*.dll")}
queue = [source]
seen = set()
while queue:
    dll = queue.pop()
    if dll.name.lower() in seen:
        continue
    seen.add(dll.name.lower())
    shutil.copyfile(dll, out / dll.name)
    imports = subprocess.check_output(["objdump", "-p", str(dll)], text=True, errors="replace")
    for name in re.findall(r"DLL Name: (.+)", imports):
        candidate = lookup.get(name.strip().lower())
        if candidate is not None:
            queue.append(candidate)

licenses = prefix / "share/licenses"
if licenses.exists():
    shutil.copytree(licenses, out / "licenses/msys2", dirs_exist_ok=True)
for p in Path(".").glob("Copyright*"):
    shutil.copyfile(p, out / p.name)
for p in Path(".").glob("LICENSE*"):
    shutil.copyfile(p, out / p.name)
for p in Path(".").glob("COPYING*"):
    shutil.copyfile(p, out / p.name)
shutil.copyfile(Path("../patches/mpv-force-render-cache.patch"), out / "mpv-force-render-cache.patch")
(out / "packages.txt").write_text(subprocess.check_output(["pacman", "-Q"], text=True), encoding="utf-8")
(out / "SOURCE.txt").write_text("mpv source: https://github.com/mpv-player/mpv/tree/902818753849d9ad8f0096fad6ca5aeaa37113b9\nBuild recipe and patch: https://github.com/Quantumishard/harbor-custom/tree/build/hdr-render-cache-20261107\nDependency sources and build recipes: https://github.com/msys2/MINGW-packages\n", encoding="utf-8")
os.add_dll_directory(str(out.resolve()))
m = c.CDLL(str((out / "libmpv-2.dll").resolve()))
m.mpv_create.restype = c.c_void_p
m.mpv_set_option_string.argtypes = [c.c_void_p, c.c_char_p, c.c_char_p]
m.mpv_initialize.argtypes = [c.c_void_p]
m.mpv_get_property_string.argtypes = [c.c_void_p, c.c_char_p]
m.mpv_get_property_string.restype = c.c_void_p
m.mpv_free.argtypes = [c.c_void_p]
m.mpv_terminate_destroy.argtypes = [c.c_void_p]
ctx = m.mpv_create()
assert m.mpv_set_option_string(ctx, b"config", b"no") >= 0
assert m.mpv_set_option_string(ctx, b"force-render-cache", b"yes") >= 0
assert m.mpv_initialize(ctx) >= 0
p = m.mpv_get_property_string(ctx, b"force-render-cache")
assert p and c.string_at(p) == b"yes"
m.mpv_free(p)
m.mpv_terminate_destroy(ctx)
manifest = {str(p.relative_to(out)).replace(os.sep, "/"): hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob("*") if p.is_file()}
(out / "SHA256-MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps({"files": len(manifest), "dlls": len(seen), "cacheOptionSmokePassed": True}))
