!include nsDialogs.nsh

!ifdef BUILD_UNINSTALLER

Var cachetteDeleteUserData
Var cachetteDeleteUserDataCheckbox

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.cachetteUserDataPage un.cachetteUserDataPageLeave
!macroend

Function un.cachetteUserDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "Choose whether to remove your local vault data.$\r$\n$\r$\nCachette Vault stores encrypted vault data, attachments, and app settings in your Windows user profile. Leave this unchecked if you may reinstall later."
  Pop $1

  ${NSD_CreateCheckbox} 0 52u 100% 12u "Delete local vault database, attachments, and app profile data"
  Pop $cachetteDeleteUserDataCheckbox
  ${NSD_Uncheck} $cachetteDeleteUserDataCheckbox

  nsDialogs::Show
FunctionEnd

Function un.cachetteUserDataPageLeave
  ${NSD_GetState} $cachetteDeleteUserDataCheckbox $cachetteDeleteUserData
FunctionEnd

!macro customUnInstall
  ${If} $cachetteDeleteUserData == ${BST_CHECKED}
    DetailPrint "Deleting Cachette Vault user data..."
    DetailPrint "Deleting Cachette Vault Windows Credential Locker entry..."
    nsExec::ExecToLog '"$SYSDIR\cmdkey.exe" /delete:"Cachette Vault/vault-derived-key"'
    Pop $0

    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend

!endif
