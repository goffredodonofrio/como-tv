@echo off
rem AIUTANTE MAM COMO TV - installazione su Windows (01/10/2026)
rem Copia l'aiutante in %LOCALAPPDATA%\ComoTV Aiutante e lo fa partire da solo
rem a ogni accensione (Esecuzione automatica), nascosto. Doppio clic e basta.
setlocal
echo == Aiutante MAM Como TV: installazione ==
where node >nul 2>nul
if errorlevel 1 (
  echo Manca Node.js. Installalo da https://nodejs.org ^(versione LTS^) oppure: winget install OpenJS.NodeJS.LTS
  echo e rilancia questo file.
  pause & exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Manca ffmpeg. Installalo con: winget install Gyan.FFmpeg
  echo poi chiudi e riapri questa finestra e rilancia questo file.
  pause & exit /b 1
)
for /f "delims=" %%N in ('where node') do (set "NODE=%%N" & goto :trovato)
:trovato
set "DEST=%LOCALAPPDATA%\ComoTV Aiutante"
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0aiutante.js" "%DEST%\aiutante.js" >nul
rem si avvia nascosto (niente finestra nera) con un piccolo script
> "%DEST%\avvia.vbs" echo Set s = CreateObject("WScript.Shell")
>> "%DEST%\avvia.vbs" echo s.Run """%NODE%"" ""%DEST%\aiutante.js""", 0, False
copy /Y "%DEST%\avvia.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ComoTV Aiutante.vbs" >nul
rem se era gia' acceso (una versione vecchia), si chiude prima di ripartire
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ComoTV Aiutante*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
wscript "%DEST%\avvia.vbs"
timeout /t 4 >nul
"%NODE%" "%DEST%\aiutante.js" --prova
echo.
curl -s http://127.0.0.1:47800/salute | findstr /C:"Aiutante MAM" >nul
if errorlevel 1 (
  echo L'aiutante non risponde: prova a riavviare il computer.
) else (
  echo FATTO: l'aiutante e' acceso. Riapri l'Editing del MAM: gli export partono da questo computer.
)
echo La NAS non serve: i pezzi li manda il MAM.
pause
