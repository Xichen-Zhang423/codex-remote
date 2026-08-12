@echo off
setlocal
chcp 65001 >nul
title Stop Codex Remote
set "CODEX_REMOTE_BOOTSTRAP=%~dp0scripts\bootstrap.js"
set "CODEX_REMOTE_LEGACY_SERVER=%~dp0server.js"
if defined LOCALAPPDATA (
  set "CODEX_REMOTE_RUNTIME_ROOT=%LOCALAPPDATA%\CodexRemote\runtime"
) else (
  set "CODEX_REMOTE_RUNTIME_ROOT=%USERPROFILE%\.codex-remote\runtime"
)

echo Stopping the Codex Remote process tree started from this launcher...
powershell -NoProfile -NonInteractive -Command "$q=[char]34; $optionalQuote='(?:'+$q+')?'; $node='^\s*(?:'+$q+'[^'+$q+']*\\node(?:\.exe)?'+$q+'|\S*node(?:\.exe)?)\s+'; $bootstrap=[regex]::Escape([IO.Path]::GetFullPath($env:CODEX_REMOTE_BOOTSTRAP)); $legacy=[regex]::Escape([IO.Path]::GetFullPath($env:CODEX_REMOTE_LEGACY_SERVER)); $runtimeRoot=[regex]::Escape([IO.Path]::GetFullPath($env:CODEX_REMOTE_RUNTIME_ROOT).TrimEnd('\')+'\'); $segment='[^'+$q+'\\]+'; $legacyRuntime=$runtimeRoot+$segment+'\\server\.js'; $nestedRuntime=$runtimeRoot+$segment+'\\apps\\'+$segment+'\\server\.js'; $pattern=$node+$optionalQuote+'(?:'+$bootstrap+'|'+$legacy+'|'+$legacyRuntime+'|'+$nestedRuntime+')'+$optionalQuote+'(?:\s|$)'; $roots=@(Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -and [regex]::IsMatch($_.CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase) }); $queue=New-Object System.Collections.Queue; $roots | ForEach-Object { if($_.CreationDate){ $queue.Enqueue($_) } }; $seen=@{}; $ordered=@(); while($queue.Count -gt 0){ $process=$queue.Dequeue(); if(-not $process.CreationDate){ continue }; $born=([DateTime]$process.CreationDate).ToUniversalTime().Ticks; $key=([string][uint32]$process.ProcessId)+':'+$born; if($seen.ContainsKey($key)){ continue }; $currentParent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction SilentlyContinue; if($null -eq $currentParent -or -not $currentParent.CreationDate -or ([DateTime]$currentParent.CreationDate).ToUniversalTime().Ticks -ne $born){ continue }; $children=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $process.ProcessId) -ErrorAction SilentlyContinue); $currentParent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction SilentlyContinue; if($null -eq $currentParent -or -not $currentParent.CreationDate -or ([DateTime]$currentParent.CreationDate).ToUniversalTime().Ticks -ne $born){ continue }; $seen[$key]=$true; $ordered+=,[pscustomobject]@{ ProcessId=[uint32]$process.ProcessId; CreationTicks=[long]$born }; $children | Where-Object { $_.CreationDate -and ([DateTime]$_.CreationDate).ToUniversalTime().Ticks -ge $born } | ForEach-Object { $queue.Enqueue($_) } }; [array]::Reverse($ordered); $stopped=0; foreach($candidate in $ordered){ $pidToStop=[uint32]$candidate.ProcessId; $current=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $candidate.ProcessId) -ErrorAction SilentlyContinue; if($null -eq $current -or -not $current.CreationDate){ continue }; $currentTicks=([DateTime]$current.CreationDate).ToUniversalTime().Ticks; if($currentTicks -ne $candidate.CreationTicks){ continue }; try { Stop-Process -Id $pidToStop -Force -ErrorAction Stop; $stopped++ } catch {} }; if($roots.Count -eq 0){ Write-Host 'Codex Remote is not running.' } else { Write-Host ('Stopped ' + $stopped + ' verified Codex Remote process(es).') }"

echo.
echo Before using anti-cheat games, also disable autostart and reboot Windows once.
pause
