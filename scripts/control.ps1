# DPI-aware desktop input for Codex Remote. Keep this file ASCII-only.
param(
  [string]$action = "ping",
  [double]$rx = 0,
  [double]$ry = 0,
  [string]$text = ""
)

if (@("ping", "click", "dblclick", "rclick", "move", "key", "type", "combo") -notcontains $action) {
  throw "Unsupported control action"
}
if ($text.Length -gt 4000) { throw "Control text is too long" }

$signature = @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$native = Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace CodexRemote -PassThru
[void]$native::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms

$rx = [Math]::Min(1.0, [Math]::Max(0.0, $rx))
$ry = [Math]::Min(1.0, [Math]::Max(0.0, $ry))
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$lastX = [Math]::Max(0, $bounds.Width - 1)
$lastY = [Math]::Max(0, $bounds.Height - 1)
$x = [int][Math]::Round($bounds.X + ($rx * $lastX))
$y = [int][Math]::Round($bounds.Y + ($ry * $lastY))

$leftDown = 0x0002
$leftUp = 0x0004
$rightDown = 0x0008
$rightUp = 0x0010
$keyUp = 0x0002
$zero = [UIntPtr]::Zero

function Move-To([int]$px, [int]$py) {
  [void]$native::SetCursorPos($px, $py)
  Start-Sleep -Milliseconds 18
}

function Click-Left {
  $native::mouse_event($leftDown, 0, 0, 0, $zero)
  Start-Sleep -Milliseconds 24
  $native::mouse_event($leftUp, 0, 0, 0, $zero)
}

function Click-Right {
  $native::mouse_event($rightDown, 0, 0, 0, $zero)
  Start-Sleep -Milliseconds 24
  $native::mouse_event($rightUp, 0, 0, 0, $zero)
}

function Key-Down([int]$vk) { $native::keybd_event([byte]$vk, 0, 0, $zero) }
function Key-Up([int]$vk) { $native::keybd_event([byte]$vk, 0, $keyUp, $zero) }

function Escape-SendKeys([string]$value) {
  $special = "+^%~(){}[]"
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $value.ToCharArray()) {
    if ($special.IndexOf($character) -ge 0) {
      [void]$builder.Append("{")
      [void]$builder.Append($character)
      [void]$builder.Append("}")
    } else {
      [void]$builder.Append($character)
    }
  }
  return $builder.ToString()
}

switch ($action) {
  "ping" { Write-Output "OK" }
  "click" { Move-To $x $y; Click-Left }
  "dblclick" {
    Move-To $x $y
    Click-Left
    Start-Sleep -Milliseconds 70
    Click-Left
  }
  "rclick" { Move-To $x $y; Click-Right }
  "move" { Move-To $x $y }
  "key" { [System.Windows.Forms.SendKeys]::SendWait($text) }
  "type" { [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $text)) }
  "combo" {
    switch ($text) {
      "alttab" {
        Key-Down 0x12
        Start-Sleep -Milliseconds 60
        Key-Down 0x09
        Key-Up 0x09
        Start-Sleep -Milliseconds 250
        Key-Up 0x12
      }
      "win" { Key-Down 0x5B; Key-Up 0x5B }
      "wind" { Key-Down 0x5B; Key-Down 0x44; Key-Up 0x44; Key-Up 0x5B }
      "wintab" { Key-Down 0x5B; Key-Down 0x09; Key-Up 0x09; Key-Up 0x5B }
      default { throw "Unsupported key combination" }
    }
  }
}
