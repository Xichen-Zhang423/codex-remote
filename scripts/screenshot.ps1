param([int]$pw = 0, [int]$ph = 0, [string]$out = "")
if ([string]::IsNullOrWhiteSpace($out)) { throw "Output path is required" }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($pw -le 0 -or $ph -le 0) {
  $pw = $bounds.Width
  $ph = $bounds.Height
}
if ($pw -le 0 -or $ph -le 0 -or $pw -gt 100000 -or $ph -gt 100000) {
  throw "Invalid screen size"
}

$bitmap = $null
$graphics = $null
$thumb = $null
$thumbGraphics = $null
$parameters = $null
try {
  $bitmap = New-Object System.Drawing.Bitmap $pw, $ph
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)

  $scale = [Math]::Min(1.0, 1280.0 / $pw)
  $width = [Math]::Max(1, [int][Math]::Round($pw * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($ph * $scale))
  $thumb = New-Object System.Drawing.Bitmap $width, $height
  $thumbGraphics = [System.Drawing.Graphics]::FromImage($thumb)
  $thumbGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $thumbGraphics.DrawImage($bitmap, 0, 0, $width, $height)

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq "image/jpeg" } |
    Select-Object -First 1
  if (-not $codec) { throw "JPEG encoder is unavailable" }
  $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter `
    ([System.Drawing.Imaging.Encoder]::Quality), ([long]72)
  $thumb.Save($out, $codec, $parameters)
} finally {
  if ($parameters) { $parameters.Dispose() }
  if ($thumbGraphics) { $thumbGraphics.Dispose() }
  if ($thumb) { $thumb.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
