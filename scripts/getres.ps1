$width = 0
$height = 0
try {
  $controller = Get-CimInstance Win32_VideoController -ErrorAction Stop |
    Where-Object { $_.CurrentHorizontalResolution -and $_.CurrentVerticalResolution } |
    Select-Object -First 1
  if ($controller) {
    $width = [int]$controller.CurrentHorizontalResolution
    $height = [int]$controller.CurrentVerticalResolution
  }
} catch {
  $width = 0
  $height = 0
}
"$width $height"
