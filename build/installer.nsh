; Included by electron-builder's NSIS installer (Windows only).
;
; electron-builder keeps a copy of the installer in %LOCALAPPDATA%\nota-updater
; for electron-updater's differential updates. Nøta has no auto-updater, so the
; copy is only 120 MB of clutter, and the uninstaller would leave it behind.

!macro removeInstallerCopy
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $0
  RMDir $0
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!macro customInstall
  !insertmacro removeInstallerCopy
!macroend

!macro customUnInstall
  !insertmacro removeInstallerCopy
!macroend
