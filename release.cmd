@echo off
rem Build, sign and publish a WidgetBoard release on GitHub.
rem   release.cmd 0.12.1 "what changed"
rem Needs: version bumped in src-tauri\Cargo.toml and tauri.conf.json and committed, ~/.widgetboard/updater.key, gh logged in.
setlocal
cd /d "%~dp0"
set "VER=%~1"
set "NOTES=%~2"
if "%VER%"=="" (echo usage: release.cmd ^<version^> "notes" & exit /b 1)
findstr /b /c:"version = \"%VER%\"" src-tauri\Cargo.toml >nul || (echo src-tauri\Cargo.toml is not at %VER% & exit /b 1)
findstr /c:"\"version\": \"%VER%\"" src-tauri\tauri.conf.json >nul || (echo tauri.conf.json is not at %VER% & exit /b 1)
git diff --quiet HEAD || (echo commit your changes first: the tag must match the build & exit /b 1)

pushd src-tauri
cargo build --release || (popd & exit /b 1)
popd
if not exist dist mkdir dist
copy /y src-tauri\target\release\widgetboard.exe dist\WidgetBoard.exe >nul || exit /b 1
node tools\release.mjs sign dist\WidgetBoard.exe --version %VER% --notes "%NOTES%" --out dist\latest.json || exit /b 1
node tools\release.mjs verify dist\latest.json dist\WidgetBoard.exe || exit /b 1

set /p "OK=Publish v%VER% to GitHub? [y/N] "
if /i not "%OK%"=="y" (echo not published; files are in dist\ & exit /b 1)
git tag v%VER% || exit /b 1
git push origin v%VER% || exit /b 1
gh release create v%VER% dist\WidgetBoard.exe dist\latest.json --verify-tag --title "WidgetBoard %VER%" --notes "%NOTES%"
