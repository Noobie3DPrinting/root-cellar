#!/bin/sh
# Root Cellar Labels start-up.
# Works with the plain node:22-bookworm-slim image: the first start installs the print system (CUPS) and the
# DYMO LabelWriter drivers, which takes a minute or two and needs internet. Later starts are quick.
set -e
if ! command -v cupsd >/dev/null 2>&1; then
  echo "[labels] installing the print system (first start only)…"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends cups cups-client cups-filters printer-driver-dymo >/dev/null \
    && rm -rf /var/lib/apt/lists/* || echo "[labels] couldn't install the print system; Download PDF still works"
fi
if command -v cupsd >/dev/null 2>&1; then
  # Keep the printer setup in the data folder so it survives updates.
  mkdir -p /data/cups
  [ -d /etc/cups.default ] || cp -a /etc/cups /etc/cups.default
  [ -f /data/cups/cupsd.conf ] || cp -a /etc/cups.default/. /data/cups/
  if [ ! -L /etc/cups ]; then rm -rf /etc/cups && ln -s /data/cups /etc/cups; fi
  /usr/sbin/cupsd || echo "[labels] print system didn't start; Download PDF still works"
fi
cd "$(dirname "$0")"
exec node server.js
