#!/bin/sh
# Stick Note (source checkout) - run this file to open the app on Linux or macOS.
# It builds the program the first time (needs Rust: https://rustup.rs), starts the server in the background if it is
# not running yet, then opens the app window.
# Installed copies (.deb, AppImage) have their own launcher; this file is for people running from the source.
# The notes are kept in the "data" folder of this checkout (set STICK_NOTE_DATA to use another one).
cd "$(dirname "$0")" || exit 1
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust was not found. Install it from https://rustup.rs and run ./start.sh again." >&2
  exit 1
fi
exec cargo run --release --locked --quiet -- --open
