#!/usr/bin/env bash
# ============================================================================
#  BWE Studio one-click launcher (Linux / macOS / Git Bash on Windows)
#
#  Usage:
#    ./start.sh                      launch BWE Studio
#    ./start.sh --shot=out.png       forward args to desktop/main.mjs
#
#  IMPORTANT: this repo vendors the Electron runtime for *win32-x64 only*
#  (desktop/vendor/electron/electron.exe, rebuilt by desktop/tools/fetch-electron.mjs
#  from the Windows electron zip). So:
#    - On Windows (Git Bash / MSYS / Cygwin) this script behaves like start.cmd.
#    - On Linux / macOS the desktop shell cannot start. This script says so and
#      falls back to the web editor (npm run dev), which needs no Electron.
#
#  Every step is idempotent: finished work is skipped on the next run.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

echo
echo " BWE Studio  -  launcher"
echo " ------------------------------------------------------------"

# ---- 0. Which platform are we on? ---------------------------------------
# OSTYPE is set by bash; msys/cygwin/mingw mean we are on Windows.
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*) ON_WINDOWS=1 ;;
  *) ON_WINDOWS=0 ;;
esac
# The vendored binary is the real evidence: if it exists and we are on Windows,
# the desktop path will work.
DESKTOP_USABLE=0
if [ "$ON_WINDOWS" = "1" ] && [ -f "desktop/vendor/electron/electron.exe" ]; then
  DESKTOP_USABLE=1
fi

# ---- 1. Node.js ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo " [X] Node.js not found in PATH."
  echo "     Install Node 20.11 or newer: https://nodejs.org/"
  echo "     (20.11 is the floor because web/tools/check-java8.mjs uses import.meta.dirname)"
  exit 1
fi
echo " [1/5] Node.js $(node -v)"

# ---- 2. npm dependencies -------------------------------------------------
if [ -d node_modules/esbuild ]; then
  echo " [2/5] npm dependencies: already installed"
else
  echo " [2/5] npm dependencies: installing (first run, needs network)"
  npm install --no-audit --no-fund
fi

# ---- 3. Electron runtime -------------------------------------------------
if [ "$DESKTOP_USABLE" = "1" ]; then
  echo " [3/5] Electron runtime: win32-x64 vendored"
elif [ -f "desktop/vendor/electron/electron.exe" ]; then
  echo " [3/5] Electron runtime: vendored binary is win32-x64 only"
  echo "       This platform cannot run the desktop shell."
  echo "       Falling back to the web editor, which needs no Electron."
else
  echo " [3/5] Electron runtime: missing"
  echo "       Rebuilding is pointless here: fetch-electron.mjs unpacks the win32-x64"
  echo "       zip. On this platform, skip the desktop shell and use the web editor."
fi

# ---- 4. Front-end bundle -------------------------------------------------
echo " [4/5] Building front-end bundle (web/dist/studio.js)"
npm run build

# ---- 5. Launch -----------------------------------------------------------
if [ "$DESKTOP_USABLE" = "1" ]; then
  echo " [5/5] Starting BWE Studio (desktop)..."
  echo " ------------------------------------------------------------"
  echo
  # desktop/main.mjs re-launches itself with the vendored electron.exe when it
  # detects it is running under plain Node, so `node` is the right entry point.
  exec node desktop/main.mjs "$@"
fi

echo " [5/5] Starting BWE Studio (web)..."
echo " ------------------------------------------------------------"
echo "       http://localhost:5273  (Ctrl+C to stop)"
echo
# serve.mjs serves the bundle we just built; open the URL printed above.
exec node web/tools/serve.mjs 5273
