param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DestinationRoot = '',
  [datetime]$Now = (Get-Date)
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

$originalLocation = Get-Location
$pushed = $false
$bundle = ''
$bundleCreated = $false

try {
  $RepositoryRoot = Get-CanonicalPath $RepositoryRoot
  $inside = (& git -C $RepositoryRoot rev-parse '--is-inside-work-tree').Trim()
  if ($LASTEXITCODE -ne 0 -or $inside -ne 'true') { throw 'RepositoryRoot is not a Git repository.' }
  $prefix = (& git -C $RepositoryRoot rev-parse '--show-prefix') -join ''
  if ($LASTEXITCODE -ne 0 -or $prefix.Trim()) {
    throw 'RepositoryRoot must be the root of the independent Codex Remote repository.'
  }

  $manifestPath = Join-Path $RepositoryRoot 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Codex Remote package.json is missing.'
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -ne 'codex-phone-remote') {
    throw 'RepositoryRoot is not the Codex Remote repository.'
  }

  $dirty = @(& git -C $RepositoryRoot status '--porcelain' '--untracked-files=all')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Git working tree.' }
  if ($dirty.Count -gt 0) { throw 'Working tree must be clean before creating a Git backup.' }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Push-Location $RepositoryRoot
  $pushed = $true
  Invoke-Native $npm @('run', 'release:verify')
  Pop-Location
  $pushed = $false

  if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path (Split-Path -Parent $RepositoryRoot) 'CodexRemote-backups'
  } elseif (-not [IO.Path]::IsPathRooted($DestinationRoot)) {
    $DestinationRoot = Join-Path (Split-Path -Parent $RepositoryRoot) $DestinationRoot
  }
  $DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

  $bundle = Join-Path $DestinationRoot ('codex-remote-' + $Now.ToString('yyyyMMdd-HHmmss') + '.bundle')
  if (Test-Path -LiteralPath $bundle) { throw "Backup already exists: $bundle" }

  Invoke-Native 'git' @('-C', $RepositoryRoot, 'bundle', 'create', $bundle, '--all')
  $bundleCreated = $true
  Invoke-Native 'git' @('-C', $RepositoryRoot, 'bundle', 'verify', $bundle)

  Write-Host '[git-backup] OK'
  Write-Host "Bundle: $bundle"
  Write-Host "Restore: git clone `"$bundle`" CodexRemote-restored"
} catch {
  if ($bundleCreated -and $bundle -and (Test-Path -LiteralPath $bundle)) {
    Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if ($pushed) { Pop-Location }
  Set-Location $originalLocation
}
