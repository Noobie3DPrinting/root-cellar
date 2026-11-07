; Windows installer for a Root Cellar-style desktop app (per-user, no admin needed). Built on Linux with makensis.
; Defines passed in by build-windows.sh: SUITE, EXE, VERSION, OUTFILE, PUBLISHER, and SHORTCUTS.nsh (generated).
Unicode true
!include "MUI2.nsh"
Name "${SUITE}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${SUITE}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${SUITE} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${SUITE}"
VIAddVersionKey "FileDescription" "${SUITE} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT License"
!define MUI_ICON "icons\suite.ico"
!define MUI_UNICON "icons\suite.ico"
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${SUITE} now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${SUITE} (required)" SecMain
  SectionIn RO
  nsExec::Exec 'taskkill /IM "${EXE}.exe" /F'
  Sleep 800
  RMDir /r "$INSTDIR\resources"
  SetOutPath "$INSTDIR"
  File /r "dist\${EXE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall ${SUITE}.exe"
  CreateDirectory "$SMPROGRAMS\${SUITE}"
  !insertmacro STARTMENU
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "DisplayName" "${SUITE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "DisplayIcon" "$INSTDIR\${EXE}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "UninstallString" '"$INSTDIR\Uninstall ${SUITE}.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}" "NoRepair" 1
SectionEnd

Section "Desktop shortcuts" SecDesk
  !insertmacro DESKTOP
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}.exe" /F'
  Sleep 800
  RMDir /r "$SMPROGRAMS\${SUITE}"
  !insertmacro UNDESKTOP
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXE}"
  ; your offline copies and settings in %APPDATA%\${EXE} are left in place on purpose
SectionEnd
