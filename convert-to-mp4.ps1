param(
  [Parameter(Mandatory=$true)]
  [string]$InputFile,

  [string]$Preset = "balanced",

  [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputFile)) {
  Write-Error "Input file not found: $InputFile"
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  Write-Error "ffmpeg not found in PATH. Install ffmpeg and retry."
}

$resolvedInput = (Resolve-Path -LiteralPath $InputFile).Path
$inputDir = Split-Path -Path $resolvedInput -Parent
$inputNameNoExt = [System.IO.Path]::GetFileNameWithoutExtension($resolvedInput)

if ([string]::IsNullOrWhiteSpace($OutputFile)) {
  $OutputFile = Join-Path $inputDir ("$inputNameNoExt.mp4")
}

$presetKey = $Preset.ToLowerInvariant()

switch ($presetKey) {
  "small" {
    $scale = "1280:-2"
    $crf = "26"
    $encPreset = "veryfast"
    $audioBitrate = "96k"
  }
  "balanced" {
    $scale = "1920:-2"
    $crf = "23"
    $encPreset = "veryfast"
    $audioBitrate = "128k"
  }
  "high" {
    $scale = "2560:-2"
    $crf = "20"
    $encPreset = "faster"
    $audioBitrate = "160k"
  }
  "4k" {
    $scale = "3840:-2"
    $crf = "20"
    $encPreset = "faster"
    $audioBitrate = "192k"
  }
  default {
    Write-Error "Invalid preset: $Preset. Use one of: small, balanced, high, 4k"
  }
}

$videoArgs = @(
  "-y",
  "-i", $resolvedInput,
  "-vf", "scale='min($scale,iw)':-2",
  "-c:v", "libx264",
  "-profile:v", "high",
  "-pix_fmt", "yuv420p",
  "-preset", $encPreset,
  "-crf", $crf,
  "-movflags", "+faststart"
)

# If input has audio, encode AAC; otherwise emit video-only MP4.
$probe = & ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=nw=1:nk=1 -- "$resolvedInput" 2>$null
if ($LASTEXITCODE -eq 0 -and $probe -match "audio") {
  $audioArgs = @("-c:a", "aac", "-b:a", $audioBitrate)
} else {
  $audioArgs = @("-an")
}

$allArgs = $videoArgs + $audioArgs + @($OutputFile)

Write-Host "Converting to MP4..."
Write-Host "Input : $resolvedInput"
Write-Host "Output: $OutputFile"
Write-Host "Preset: $presetKey"

& ffmpeg @allArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error "ffmpeg conversion failed."
}

Write-Host "Done: $OutputFile"
