#!/bin/bash
# Starts a local web server for this folder and opens the piece in a browser.
# Double-click to run. First time on macOS: right-click > Open.
# Close this window to stop the server.

cd "$(dirname "$0")" || exit 1
PORT=8000

open_browser() {
  sleep 1
  open "http://localhost:$PORT/"
}

if command -v python3 >/dev/null 2>&1; then
  open_browser &
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  open_browser &
  exec npx --yes serve -l "$PORT" .
else
  echo "This launcher needs Python 3 or Node.js installed."
  echo "Install one (https://www.python.org or https://nodejs.org) and run this again."
  read -r -p "Press Enter to close."
  exit 1
fi
