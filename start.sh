#!/bin/sh
# Stick Note (source checkout) - run this file to open the app on Linux or macOS.
# If the server is not running yet it is started in the background, then the app window opens.
# Installed copies (.deb, AppImage) have their own launcher; this file is for people running from the source.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and run ./start.sh again." >&2
  exit 1
fi
exec node server.js --open
