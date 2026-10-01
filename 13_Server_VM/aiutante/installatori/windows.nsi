; AIUTANTE MAM COMO TV - installatore per Windows (01/10/2026)
; Si costruisce sul Mac con:  makensis -DVERSIONE=x.y.z -DSORGENTI=<cartella> windows.nsi
; Dentro: node.exe, ffmpeg.exe, ffprobe.exe, aiutante.js. Si installa per l'utente
; (niente permessi da amministratore) in %LOCALAPPDATA%\ComoTV Aiutante e parte da
; solo a ogni accensione, nascosto. Chiede conferma prima di installare.
Unicode true
!ifndef VERSIONE
  !define VERSIONE "0.0.0"
!endif
Name "Aiutante MAM Como TV"
OutFile "ComoTV-Aiutante-Windows.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\ComoTV Aiutante"
SetCompressor /SOLID lzma
ShowInstDetails show
VIProductVersion "${VERSIONE}.0"
VIAddVersionKey "ProductName" "Aiutante MAM Como TV"
VIAddVersionKey "FileDescription" "Export e invii in regia del MAM Como TV sul tuo computer"
VIAddVersionKey "FileVersion" "${VERSIONE}"
VIAddVersionKey "CompanyName" "Como TV"
VIAddVersionKey "LegalCopyright" "Como TV"

!include "MUI2.nsh"
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_WELCOMEPAGE_TITLE "Aiutante MAM Como TV ${VERSIONE}"
!define MUI_WELCOMEPAGE_TEXT "Gli export e gli invii in regia del MAM li fara$\' questo computer, con la sua scheda video: molto piu$\' veloci.$\r$\n$\r$\nL$\'aiutante parte da solo a ogni accensione, ascolta solo su questo computer e risponde solo alle pagine del MAM. La NAS non serve.$\r$\n$\r$\nPremi Avanti per installarlo."
!define MUI_FINISHPAGE_TITLE "Aiutante installato"
!define MUI_FINISHPAGE_TEXT "L$\'aiutante e$\' acceso. Riapri (o ricarica) l$\'Editing del MAM: entro un minuto lo trova, e gli export partono da questo computer."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Italian"

Function .onInit
  MessageBox MB_YESNO|MB_ICONQUESTION "Installare l$\'Aiutante MAM Como TV su questo computer?" /SD IDYES IDYES +2
  Abort
FunctionEnd

Section "Aiutante"
  ; se era gia' acceso (una versione vecchia), si chiude prima di sostituirlo
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=$\'node.exe$\'\" | Where-Object { $$_.CommandLine -like $\'*ComoTV Aiutante*$\' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Sleep 800
  SetOutPath "$INSTDIR"
  File "${SORGENTI}\node.exe"
  File "${SORGENTI}\ffmpeg.exe"
  File "${SORGENTI}\ffprobe.exe"
  File "${SORGENTI}\aiutante.js"
  ; il lanciatore nascosto (niente finestra nera)
  FileOpen $0 "$INSTDIR\avvia.vbs" w
  FileWrite $0 'Set s = CreateObject("WScript.Shell")$\r$\n'
  FileWrite $0 's.Run """$INSTDIR\node.exe"" ""$INSTDIR\aiutante.js""", 0, False$\r$\n'
  FileClose $0
  CreateShortCut "$SMSTARTUP\ComoTV Aiutante.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\avvia.vbs"'
  WriteUninstaller "$INSTDIR\Disinstalla.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante" "DisplayName" "Aiutante MAM Como TV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante" "DisplayVersion" "${VERSIONE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante" "Publisher" "Como TV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante" "UninstallString" '"$INSTDIR\Disinstalla.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante" "NoModify" 1
  ; e si accende subito
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\avvia.vbs"'
  DetailPrint "Aiutante acceso: controlla su http://127.0.0.1:47800/salute"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=$\'node.exe$\'\" | Where-Object { $$_.CommandLine -like $\'*ComoTV Aiutante*$\' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Sleep 800
  Delete "$SMSTARTUP\ComoTV Aiutante.lnk"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffprobe.exe"
  Delete "$INSTDIR\aiutante.js"
  Delete "$INSTDIR\avvia.vbs"
  Delete "$INSTDIR\Disinstalla.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ComoTVAiutante"
SectionEnd
