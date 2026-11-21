#!/usr/bin/env pwsh
# Stage the pinned custom player and its complete DLL dependency closure.
$ErrorActionPreference = "Stop"
$playerRoot = $PSScriptRoot
$playerLibDir = Join-Path $playerRoot "libmpv"
& node (Join-Path $playerRoot "..\scripts\fetch-libmpv.mjs")
if ($LASTEXITCODE -ne 0) { throw "Custom player setup failed" }
if (-not (Test-Path -LiteralPath (Join-Path $playerLibDir "mpv.lib"))) {
    throw "Restore the checked-in mpv.lib import library before building"
}
foreach ($playerOutput in @("target\debug", "target\release")) {
    $playerOutputDir = Join-Path $playerRoot $playerOutput
    if (Test-Path -LiteralPath $playerOutputDir) {
        Get-ChildItem -LiteralPath $playerLibDir -Filter "*.dll" -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $playerOutputDir -Force
        }
    }
}
Write-Host "[setup-libmpv] verified custom player and dependency DLLs staged"
