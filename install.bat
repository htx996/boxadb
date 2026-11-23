@echo off
REM ---------------------------------------------------------------------
REM BoxADB WiFi bridge installer (Windows 10/11 64-bit)
REM
REM Recommended usage: download boxadb-windows.zip from Releases, unzip,
REM then double-click this file. The zip already contains
REM boxadb-bridge.exe and AppIcon.ico, so files are copied locally with
REM no extra download. If this bat is saved alone, it fetches the zip
REM as a fallback.
REM
REM What it does:
REM   - Installs to %LOCALAPPDATA%\boxadb\
REM   - Runs Unblock-File on exe/launcher to remove Mark-of-the-Web,
REM     so SmartScreen no longer shows the blue "Windows protected
REM     your PC" dialog
REM   - Creates start-bridge.bat: double-click to start the bridge,
REM     close the window to stop it
REM   - Creates a desktop shortcut "BoxADB Bridge.lnk" with icon
REM
REM Uninstall: delete %LOCALAPPDATA%\boxadb\ and the desktop shortcut.
REM
REM NOTE: keep this file pure ASCII with CRLF endings. cmd on Chinese
REM       Windows parses UTF-8 Chinese as GBK and the script breaks.
REM       PowerShell commands containing parentheses must stay at top
REM       level (not inside if-blocks), or cmd misreads ")".
REM ---------------------------------------------------------------------
setlocal EnableExtensions

set "SRC_DIR=%~dp0"
set "APP_DIR=%LOCALAPPDATA%\boxadb"
set "BIN=%APP_DIR%\boxadb-bridge.exe"
set "LAUNCHER=%APP_DIR%\start-bridge.bat"
set "ICON=%APP_DIR%\AppIcon.ico"
set "DESKTOP_LNK=%USERPROFILE%\Desktop\BoxADB Bridge.lnk"

if not exist "%APP_DIR%" mkdir "%APP_DIR%"

REM 1) Get exe + ico: copy from this folder if present, else download the zip
if exist "%SRC_DIR%boxadb-bridge.exe" goto :copylocal

REM Pick the zip matching this machine's CPU architecture (default amd64)
set "WINARCH=amd64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "WINARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "WINARCH=arm64"
set "ZIPNAME=boxadb-windows-%WINARCH%.zip"

echo No bundled files next to install.bat, downloading %ZIPNAME%...
curl -fL -o "%TEMP%\%ZIPNAME%" "https://github.com/wukongdaily/boxadb/releases/latest/download/%ZIPNAME%"
if errorlevel 1 goto :dlfail
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=Join-Path $env:TEMP 'boxadb-win'; Expand-Archive -LiteralPath (Join-Path $env:TEMP '%ZIPNAME%') -DestinationPath $d -Force; Copy-Item -LiteralPath (Join-Path $d 'boxadb-bridge.exe') -Destination '%BIN%' -Force; Copy-Item -LiteralPath (Join-Path $d 'AppIcon.ico') -Destination '%ICON%' -Force"
if errorlevel 1 goto :unzfail
goto :setup

:copylocal
copy /y "%SRC_DIR%boxadb-bridge.exe" "%BIN%" >nul
copy /y "%SRC_DIR%AppIcon.ico"       "%ICON%" >nul
goto :setup

:setup
REM 2) Launcher: runs the exe in foreground, closing the window stops it
>  "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo echo Starting BoxADB bridge... Close this window to stop it.
>> "%LAUNCHER%" echo echo.
>> "%LAUNCHER%" echo "%BIN%"
>> "%LAUNCHER%" echo echo.
>> "%LAUNCHER%" echo echo Bridge exited. Port released.
>> "%LAUNCHER%" echo pause

REM 3) Key step: remove MOTW so SmartScreen stops blocking the exe
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%BIN%' -EA 0; Unblock-File -LiteralPath '%LAUNCHER%' -EA 0; if(Test-Path '%ICON%'){Unblock-File -LiteralPath '%ICON%' -EA 0}"

REM 4) Desktop shortcut pointing to the launcher, with icon
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%DESKTOP_LNK%'); $s.TargetPath='%LAUNCHER%'; $s.WorkingDirectory='%APP_DIR%'; $s.IconLocation='%ICON%,0'; $s.Description='BoxADB WiFi bridge'; $s.Save()"

echo.
echo [Done] Installed:
echo        binary:   %BIN%
echo        launcher: %LAUNCHER%
if exist "%DESKTOP_LNK%" echo        shortcut: %DESKTOP_LNK%
echo.
echo Usage:
echo    1) Double-click desktop shortcut "BoxADB Bridge" - bridge runs in a cmd window
echo    2) Open https://wukongdaily.github.io/boxadb/ , enter box IP, connect
echo    3) Close the cmd window when done - port is released
echo.
pause
exit /b 0

:dlfail
echo [Error] Failed to download boxadb-windows.zip. Check your network.
pause
exit /b 1

:unzfail
echo [Error] Failed to extract boxadb-windows.zip.
pause
exit /b 1
