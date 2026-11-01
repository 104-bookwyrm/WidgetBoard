Var WidgetBoardSavedRunValue
Var WidgetBoardRunOwned

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $WidgetBoardSavedRunValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WidgetBoard"
  StrCpy $WidgetBoardRunOwned 0
  StrCpy $0 $WidgetBoardSavedRunValue 1
  StrCmp $0 '"' widgetboardQuotedRun widgetboardUnquotedRun
widgetboardQuotedRun:
  StrCpy $0 $WidgetBoardSavedRunValue "" 1
  StrCpy $1 0
widgetboardFindRunQuote:
  StrCpy $2 $0 1 $1
  StrCmp $2 "" widgetboardUninstallHookDone
  StrCmp $2 '"' widgetboardFoundRunQuote
  IntOp $1 $1 + 1
  Goto widgetboardFindRunQuote
widgetboardFoundRunQuote:
  StrCpy $0 $0 $1
  Goto widgetboardCompareRunTarget
widgetboardUnquotedRun:
  StrCpy $0 $WidgetBoardSavedRunValue
widgetboardCompareRunTarget:
  StrCmp $0 "$INSTDIR\${MAINBINARYNAME}.exe" 0 widgetboardUninstallHookDone
  StrCpy $WidgetBoardRunOwned 1
widgetboardUninstallHookDone:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} $WidgetBoardRunOwned = 1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "WidgetBoard"
    ${ElseIf} $WidgetBoardSavedRunValue != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WidgetBoard" "$WidgetBoardSavedRunValue"
    ${EndIf}
  ${EndIf}
!macroend
