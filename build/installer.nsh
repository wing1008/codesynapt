; CodeSynapt — NSIS installer hooks
; Adds: bundled Node component (auto-detected default) + PATH registration.
;
; electron-builder hook points used:
;   customInit     — installer start (right after .onInit defaults)
;   customInstall  — after main file copy, before "finished" page
;   customUnInstall — after main file delete
;
; PATH ops delegated to PowerShell scripts (add-to-path.ps1 / remove-from-path.ps1)
; to avoid NSIS StrFunc declaration headaches.

; ---- Optional components ----
SectionGroup /e "Optional"
  Section "Bundled Node.js 22 (76 MB)" SecBundleNode
    SectionIn 1
  SectionEnd

  Section "Add cs command to PATH" SecAddToPath
    SectionIn 1
  SectionEnd
SectionGroupEnd

; ---- customInit: detect system Node, set Bundle Node section default ----
!macro customInit
  nsExec::ExecToStack 'where node'
  Pop $0   ; exit code
  Pop $1   ; stdout (discard, we only need the exit code)
  ${If} $0 == 0
    !insertmacro UnselectSection ${SecBundleNode}
    DetailPrint "System Node detected — bundled Node deselected by default. Re-check the box if you want both installed."
  ${Else}
    DetailPrint "System Node not found — bundled Node will be installed."
  ${EndIf}
!macroend

; ---- customInstall: move bin/runtime + register PATH ----
!macro customInstall
  ; Read section states into general-purpose registers
  SectionGetFlags ${SecBundleNode} $R0
  IntOp $R0 $R0 & ${SF_SELECTED}

  SectionGetFlags ${SecAddToPath} $R1
  IntOp $R1 $R1 & ${SF_SELECTED}

  ; --- 1) Move installer-bin → $INSTDIR\bin (always) ---
  CreateDirectory "$INSTDIR\bin"
  CopyFiles /SILENT "$INSTDIR\resources\installer-bin\*.*" "$INSTDIR\bin"
  RMDir /r "$INSTDIR\resources\installer-bin"

  ; --- 2) Bundled node: keep, or delete ---
  ${If} $R0 == ${SF_SELECTED}
    CreateDirectory "$INSTDIR\runtime"
    CopyFiles /SILENT "$INSTDIR\resources\bundled-node\node.exe" "$INSTDIR\runtime"
    DetailPrint "Bundled Node installed to $INSTDIR\runtime\node.exe"
  ${EndIf}
  RMDir /r "$INSTDIR\resources\bundled-node"

  ; --- 3) PATH registration via PowerShell script ---
  ${If} $R1 == ${SF_SELECTED}
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\bin\add-to-path.ps1" -Path "$INSTDIR\bin"'
    Pop $0
    DetailPrint "PATH registration exit code: $0"
  ${EndIf}
!macroend

; ---- customUnInstall: remove PATH entry ----
!macro customUnInstall
  ; remove-from-path.ps1 was installed to $INSTDIR\bin; if it's already gone
  ; (user deleted it manually), inline a one-liner as fallback.
  ${If} ${FileExists} "$INSTDIR\bin\remove-from-path.ps1"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\bin\remove-from-path.ps1" -Path "$INSTDIR\bin"'
  ${Else}
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$c=[Environment]::GetEnvironmentVariable(`Path`,`User`); if($$c){$$n=($$c -split `;` ^| Where-Object { $$_ -ne `` -and $$_ -ne `$INSTDIR\bin` }) -join `;`; [Environment]::SetEnvironmentVariable(`Path`,$$n,`User`)}"'
  ${EndIf}
!macroend
