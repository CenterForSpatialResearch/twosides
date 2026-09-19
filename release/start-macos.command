#!/bin/bash
# Starts a local web server for this folder and opens the piece in a browser.
# Double-click to run. First time on macOS: see README.txt.
# Close this window to stop the server.

cd "$(dirname "$0")" || exit 1

# True if something is already listening on the given port.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Use 8000 unless another server (e.g. an earlier launch that is still
# running) already has it, in which case take the next free port.
PORT=8000
while port_in_use "$PORT"; do
  PORT=$((PORT + 1))
  if [ "$PORT" -gt 8020 ]; then
    echo "Ports 8000-8020 are all in use. Close other servers and try again."
    read -r -p "Press Enter to close."
    exit 1
  fi
done

# Wait until the server answers before opening the browser.
open_browser() {
  for _ in $(seq 1 50); do
    port_in_use "$PORT" && break
    sleep 0.2
  done
  open "http://localhost:$PORT/"
}

echo "Serving on http://localhost:$PORT/ — close this window to stop."

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
