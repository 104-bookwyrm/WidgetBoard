!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WidgetBoard"
  StrCpy $1 $0 1
  StrCmp $1 '"' quotedTarget compareTarget
quotedTarget:
  StrCpy $0 $0 "" 1
  StrCpy $0 $0 -1
compareTarget:
  StrCmp $0 "$INSTDIR\${MAINBINARYNAME}.exe" 0 done
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WidgetBoard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "WidgetBoard"
done:
!macroend
