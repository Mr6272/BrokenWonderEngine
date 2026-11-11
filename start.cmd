@echo off
REM ============================================================================
REM  BWE Studio one-click launcher (Windows)
REM
REM  ASCII-only on purpose: cmd.exe parses a .cmd file with the active console
REM  codepage, so Chinese text inside a batch file breaks on non-936 code pages
REM  (and switching chcp mid-file corrupts the remaining lines). All prose lives
REM  in README.md; this file only prints short English status lines.
REM
REM  Usage:
REM    start.cmd                     launch the desktop editor
REM    start.cmd --shot=out.png      forward args to desktop/main.mjs
REM
REM  Every step is idempotent: finished work is skipped on the next run.
REM ============================================================================
setlocal
cd /d "%~dp0"

echo.
echo  BWE Studio  -  launcher
echo  ------------------------------------------------------------

REM ---- 1. Node.js --------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js not found in PATH.
  echo      Install Node 20.11 or newer: https://nodejs.org/
  echo      ^(20.11 is the floor because web/tools/check-java8.mjs uses import.meta.dirname^)
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo  [1/5] Node.js %NODE_VER%

REM ---- 2. npm dependencies ----------------------------------------------
if exist "node_modules\esbuild" (
  echo  [2/5] npm dependencies: already installed
) else (
  echo  [2/5] npm dependencies: installing ^(first run, needs network^)
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [X] npm install failed. Check network / proxy and retry.
    exit /b 1
  )
)

REM ---- 3. Electron runtime ----------------------------------------------
if exist "desktop\vendor\electron\electron.exe" (
  echo  [3/5] Electron runtime: already vendored
) else (
  echo  [3/5] Electron runtime: rebuilding from local cache ^(offline^)
  node desktop\tools\fetch-electron.mjs
  if errorlevel 1 (
    echo  [X] Could not rebuild Electron. fetch-electron.mjs printed the remedies:
    echo      set BWE_ELECTRON_ZIP, or drop the zip into desktop\vendor\, or download it.
    exit /b 1
  )
)

REM ---- 4. Front-end bundle ----------------------------------------------
echo  [4/5] Building front-end bundle ^(web/dist/studio.js^)
call npm run build
if errorlevel 1 (
  echo  [X] esbuild failed. See the error above.
  exit /b 1
)

REM ---- 5. Launch --------------------------------------------------------
echo  [5/5] Starting BWE Studio...
echo  ------------------------------------------------------------
echo.
REM    desktop/main.mjs re-launches itself with the vendored electron.exe when
REM    it detects it is running under plain Node, so `node` is the right entry.
node desktop\main.mjs %*

endlocal
