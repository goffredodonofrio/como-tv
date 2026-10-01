@echo off
rem AIUTANTE MAM COMO TV - lo toglie da Windows (gli export tornano alla VM)
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ComoTV Aiutante.vbs" >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ComoTV Aiutante*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
rmdir /S /Q "%LOCALAPPDATA%\ComoTV Aiutante" >nul 2>nul
echo Aiutante tolto. La configurazione e i file in Download\MAM Export restano.
pause
