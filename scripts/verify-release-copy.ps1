param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [switch]$Keep
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Invoke-Native {
  param([string]$File, [string[]]$Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
}

function Get-CanonicalPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
}

$Source = Get-CanonicalPath $Source
$tempRoot = Get-CanonicalPath $env:TEMP
$runRoot = Join-Path $tempRoot ("Codex Remote release-check-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $runRoot 'codex-remote.zip'
$installCopyName = -join @([char]0x5B89, [char]0x88C5, [char]0x9A8C, [char]0x8BC1, [char]0x526F, [char]0x672C)
$launcherCopyName = -join @([char]0x542F, [char]0x52A8, [char]0x5668, [char]0x9A8C, [char]0x8BC1, [char]0x526F, [char]0x672C)
$installCopy = Join-Path $runRoot $installCopyName
$launcherCopy = Join-Path $runRoot $launcherCopyName
$oldCache = $env:npm_config_cache
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source

try {
  New-Item -ItemType Directory -Path $runRoot | Out-Null
  $prefix = (& git -C $Source rev-parse '--show-prefix').Trim().TrimEnd('/')
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse --show-prefix failed' }
  $repoRoot = (& git -C $Source rev-parse '--show-toplevel').Trim()
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse --show-toplevel failed' }
  $repoRoot = Get-CanonicalPath $repoRoot
  $treeish = if ($prefix) { "HEAD:$prefix" } else { 'HEAD' }
  Invoke-Native 'git' @('-c', 'core.autocrlf=false', '-C', $repoRoot, 'archive', '--format=zip', "--output=$zip", $treeish)

  Expand-Archive -LiteralPath $zip -DestinationPath $installCopy
  Expand-Archive -LiteralPath $zip -DestinationPath $launcherCopy
  foreach ($copy in @($installCopy, $launcherCopy)) {
    if (Test-Path -LiteralPath (Join-Path $copy 'node_modules')) { throw "Archive contains node_modules: $copy" }
    if (Test-Path -LiteralPath (Join-Path $copy '.npm-cache')) { throw "Archive contains npm cache: $copy" }
  }

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not $localAppData) { $localAppData = $tempRoot }
  $env:npm_config_cache = Join-Path $localAppData 'CodexRemote\release-npm-cache'

  Push-Location $installCopy
  try {
    Invoke-Native $node @('-e', "for(const f of ['package-lock.json','app-android/package-lock.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))")
    Invoke-Native $npm @('ci', '--no-audit', '--no-fund')
    Invoke-Native $npm @('run', 'verify')
  } finally { Pop-Location }

  Push-Location $launcherCopy
  try {
    if (Test-Path -LiteralPath 'node_modules') { throw 'Launcher copy was contaminated by install copy' }
    Get-ChildItem -LiteralPath $launcherCopy -Recurse -File | ForEach-Object { $_.IsReadOnly = $true }
    Invoke-Native $node @('--test', 'test/start-bat.test.js')
  } finally { Pop-Location }

  Write-Host '[release-copy] OK'
  if ($Keep) {
    Write-Host "Install copy: $installCopy"
    Write-Host "Launcher copy: $launcherCopy"
  }
} finally {
  if ($null -eq $oldCache) { Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue }
  else { $env:npm_config_cache = $oldCache }
  if (-not $Keep -and (Test-Path -LiteralPath $runRoot)) {
    $resolvedRunRoot = Get-CanonicalPath $runRoot
    $expectedPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedRunRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a path outside TEMP: $resolvedRunRoot"
    }
    Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
  }
}
