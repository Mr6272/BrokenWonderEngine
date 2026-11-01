@echo off
rem Launcher for the packaged build. Always passes --console so startup errors are visible.
rem Usage (from any directory): desktop\tools\run-exe.cmd [extra args]
rem   run-exe.cmd --shot=D:/tmp/shot.png --size=1600x1000
rem   run-exe.cmd --shot=D:/tmp/ai.png --tap="[data-panel-tab=ai]"
set "EXE=%~dp0..\dist\win-unpacked\BWE Studio.exe"
if not exist "%EXE%" goto missing
rem Some environments set ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain Node.
rem main.mjs fixes this itself; clearing it here is a second safety net.
set ELECTRON_RUN_AS_NODE=
"%EXE%" --console %*
set CODE=%ERRORLEVEL%
echo [run-exe] exit code %CODE%
exit /b %CODE%
:missing
echo [run-exe] BWE Studio.exe not found. Run: node desktop/tools/package.mjs
exit /b 1
