#Requires -Version 5.1
# ort-sys 2.0.0-rc.10 copies runtime DLLs into OUT_DIR/../../..
# Cargo can place OUT_DIR beneath release/build/ort-sys/<hash>/out,
# which makes that destination release/build instead of release.
function Initialize-OrtRuntimeDirectories {
  param([Parameter(Mandatory = $true)][string]$ReleaseDir)

  foreach ($base in @($ReleaseDir, (Join-Path $ReleaseDir 'build'))) {
    foreach ($dir in @($base, (Join-Path $base 'examples'), (Join-Path $base 'deps'))) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
  }
}

function Stage-OrtRuntimeDlls {
  param([Parameter(Mandatory = $true)][string]$ReleaseDir)

  # Newer Cargo layouts make ort-sys copy its runtime DLLs into
  # release/build, while Shipyard packages files beside release/harbor.exe.
  $buildDir = Join-Path $ReleaseDir 'build'
  $runtimePattern = '^(?:onnxruntime.*|DirectML)\.dll$'
  $fromBuild = @(Get-ChildItem -LiteralPath $buildDir -File -Filter '*.dll' |
    Where-Object { $_.Name -match $runtimePattern })
  foreach ($dll in $fromBuild) {
    Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $ReleaseDir $dll.Name) -Force
  }

  $runtimeDlls = @(Get-ChildItem -LiteralPath $ReleaseDir -File -Filter '*.dll' |
    Where-Object { $_.Name -match $runtimePattern })
  # The pinned ort-sys Windows archive links the 303 MB onnxruntime.lib
  # statically into harbor.exe. It ships DirectML.dll but no onnxruntime.dll.
  # Fail if the DLL imported by the executable is absent or empty.
  if (-not ($runtimeDlls | Where-Object { $_.Name -ieq 'DirectML.dll' -and $_.Length -gt 0 })) {
    throw 'Sidecar Core did not stage a valid DirectML.dll'
  }
  $emptyDlls = @($runtimeDlls | Where-Object { $_.Length -le 0 })
  if ($emptyDlls.Count -gt 0) {
    throw "Sidecar Core staged an empty runtime DLL: $($emptyDlls[0].Name)"
  }
}
