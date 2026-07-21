param([Parameter(Mandatory = $true)][string]$Project)

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public'))
$projectRoot = [IO.Path]::GetFullPath($Project).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $projectRoot 'entry\src\main\resources\rawfile'))
$requiredPrefix = $projectRoot + [IO.Path]::DirectorySeparatorChar
$managedManifestName = 'codex-remote-managed-files.json'

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "The public directory does not exist: $source"
}
if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) {
  throw "The DevEco project does not exist: $projectRoot"
}
if (-not $destination.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The rawfile destination must stay inside the selected DevEco project.'
}
$requiredWebFiles = @(
  'artifact-ui.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs'
)
foreach ($relative in $requiredWebFiles) {
  $requiredSource = Join-Path $source $relative
  if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) {
    throw "Required Codex Remote source asset is missing: $relative"
  }
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
$destinationPrefix = $destination.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$managedManifest = Join-Path $destination $managedManifestName

if (Test-Path -LiteralPath $managedManifest -PathType Leaf) {
  $previousFiles = @(Get-Content -LiteralPath $managedManifest -Raw -Encoding UTF8 | ConvertFrom-Json)
  foreach ($relative in $previousFiles) {
    if ([string]::IsNullOrWhiteSpace([string]$relative)) { continue }
    $target = [IO.Path]::GetFullPath((Join-Path $destination ([string]$relative)))
    if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Managed rawfile path escaped the selected DevEco project: $relative"
    }
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    }
  }
}

$managedFiles = @()
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
  $relative = $file.FullName.Substring($source.Length + 1)
  $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
  if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Source path escaped the selected DevEco project: $relative"
  }
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  $managedFiles += $relative
}
foreach ($relative in $requiredWebFiles) {
  $requiredAsset = Join-Path $destination $relative
  if (-not (Test-Path -LiteralPath $requiredAsset -PathType Leaf)) {
    throw "Required Codex Remote web asset was not copied: $relative"
  }
}

ConvertTo-Json -InputObject @($managedFiles) | Set-Content -LiteralPath $managedManifest -Encoding UTF8

Write-Host "Copied Codex Remote web assets to: $destination"
Get-ChildItem -LiteralPath $destination -Recurse -File |
  ForEach-Object { Write-Host ('  ' + $_.FullName.Substring($destination.Length + 1)) }
