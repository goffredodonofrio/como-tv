# AIUTANTE MAM COMO TV - installazione su Windows con una riga di PowerShell (01/10/2026)
#   irm https://projects-cloud.it/como-tv/aiutante/pacchetto/installa-windows.ps1 | iex
# Il .bat scaricato col browser fa scattare "Windows ha protetto il PC"; cosi' no.
# Fa le stesse cose di "Installa (Windows).bat".
$ErrorActionPreference = "Stop"
$base = if ($env:COMOTV_AIUTANTE_BASE) { $env:COMOTV_AIUTANTE_BASE } else { "https://projects-cloud.it/como-tv/aiutante/pacchetto" }
Write-Host "== Aiutante MAM Como TV: installazione =="
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Manca Node.js: winget install OpenJS.NodeJS.LTS (oppure https://nodejs.org), poi riapri PowerShell e rilancia."; return }
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ff) { Write-Host "Manca ffmpeg: winget install Gyan.FFmpeg, poi riapri PowerShell e rilancia."; return }
$dest = Join-Path $env:LOCALAPPDATA "ComoTV Aiutante"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest -UseBasicParsing "$base/aiutante.js" -OutFile (Join-Path $dest "aiutante.nuovo.js")
& $node --check (Join-Path $dest "aiutante.nuovo.js")
if ($LASTEXITCODE -ne 0) { Write-Host "Il file scaricato non e' valido: riprova."; return }
Move-Item -Force (Join-Path $dest "aiutante.nuovo.js") (Join-Path $dest "aiutante.js")
# si avvia nascosto (niente finestra nera), a ogni accensione
$vbs = Join-Path $dest "avvia.vbs"
@"
Set s = CreateObject("WScript.Shell")
s.Run """$node"" ""$dest\aiutante.js""", 0, False
"@ | Set-Content -Encoding ASCII $vbs
Copy-Item -Force $vbs (Join-Path ([Environment]::GetFolderPath("Startup")) "ComoTV Aiutante.vbs")
# se era gia' acceso (una versione vecchia), si chiude prima di ripartire
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*ComoTV Aiutante*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 4
& $node (Join-Path $dest "aiutante.js") --prova
try {
  $s = Invoke-RestMethod "http://127.0.0.1:47800/salute" -TimeoutSec 5
  if ($s.ok) { Write-Host "FATTO: l'aiutante e' acceso ($($s.codificatore)). Riapri l'Editing del MAM: gli export partono da questo computer." }
} catch { Write-Host "L'aiutante non risponde: prova a riavviare il computer." }
Write-Host "La NAS non serve: i pezzi li manda il MAM."
