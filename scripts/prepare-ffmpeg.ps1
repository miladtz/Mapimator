param()

$ErrorActionPreference = 'Stop'
$url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip'
$sha256 = 'b3a6a580b961bd7aa175cdfc4bfcf010f033943968e9e1f5f4cf4d7f03164713'
$root = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $root 'src-tauri/resources/ffmpeg'
$archive = Join-Path ([System.IO.Path]::GetTempPath()) 'mapmotion-ffmpeg.zip'
$extract = Join-Path ([System.IO.Path]::GetTempPath()) 'mapmotion-ffmpeg-extract'

Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
Invoke-WebRequest -Uri $url -OutFile $archive
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $sha256) { throw "FFmpeg checksum verification failed. Expected $sha256, received $actual." }
Expand-Archive -Path $archive -DestinationPath $extract -Force
$bin = Get-ChildItem $extract -Directory -Recurse -Filter bin | Select-Object -First 1
if (-not $bin -or -not (Test-Path (Join-Path $bin.FullName 'ffmpeg.exe'))) { throw 'Approved FFmpeg archive does not contain bin/ffmpeg.exe.' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item (Join-Path $bin.FullName '*') $destination -Force
Write-Host "Prepared bundled FFmpeg at $destination"
