#!/usr/bin/env bash
# Root Cellar installer for Linux servers (Ubuntu, Debian, Raspberry Pi OS, Proxmox VMs and most others).
#
#   sudo bash install.sh            # asks a few questions
#   sudo bash install.sh --yes      # installs everything with the defaults
#
# Run it again any time to update: your data is kept.
# Options: --yes  --apps checkbook,notes,movies,labels  --dir /opt/root-cellar  --tz America/New_York  --no-https
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=/opt/root-cellar; APPS=""; YES=0; TZV=""; HTTPS=ask
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --apps) APPS="$2"; shift ;;
    --dir) DIR="$2"; shift ;;
    --tz) TZV="$2"; shift ;;
    --no-https) HTTPS=no ;;
    --https) HTTPS=yes ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac; shift
done

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[31m!\033[0m %s\n' "$*"; }
ask()  { # ask "Question" default  -> echoes answer
  local q="$1" d="$2" a
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$d"; return; fi
  read -r -p "    $q [$d]: " a </dev/tty || true; echo "${a:-$d}"
}
yesno() { local a; a=$(ask "$1 (y/n)" "$2"); [[ "$a" =~ ^[Yy] ]]; }

[ "$(id -u)" = 0 ] || { echo "Please run with sudo:  sudo bash install.sh"; exit 1; }
[ -d "$HERE/server/checkbook" ] || { echo "Run this from inside the Root Cellar folder (the one with the 'server' folder)."; exit 1; }

cat <<'EOF'

   ╔══════════════════════════════════════════════╗
   ║   Root Cellar — your household apps, at home  ║
   ╚══════════════════════════════════════════════╝
EOF

# ---------- 1. Docker ----------
say "Checking for Docker"
if ! command -v docker >/dev/null 2>&1; then
  if yesno "Docker isn't installed. Install it now from docker.com?" y; then
    curl -fsSL https://get.docker.com | sh
    ok "Docker installed"
  else echo "Root Cellar needs Docker. See the guide, then run this again."; exit 1; fi
else ok "Docker is installed"; fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || { warn "Docker Compose is missing. Install it (apt install docker-compose-plugin) and run this again."; exit 1; }

# ---------- 2. Choices ----------
say "Choosing apps"
if [ -z "$APPS" ]; then
  APPS=""
  for a in checkbook notes movies labels; do
    case $a in
      checkbook) d="Checkbook (shared check register + bills)";; notes) d="Notes (private & shared notes)";;
      movies) d="Movies (disc collection + wishlist, barcode scanning)";; labels) d="Labels (design & print labels; DYMO printers)";;
    esac
    if yesno "Install $d?" y; then APPS="$APPS,$a"; fi
  done
  APPS="${APPS#,}"
fi
[ -n "$APPS" ] || { echo "No apps picked. Nothing to do."; exit 0; }
ok "Apps: ${APPS//,/, }"
if [ -z "$TZV" ]; then
  DEF_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
  TZV=$(ask "Time zone (used for paydays, reminders and backups)" "${DEF_TZ:-UTC}")
fi
ok "Time zone: $TZV"
DIR=$(ask "Install folder" "$DIR")
ok "Folder: $DIR"

# ---------- 3. Copy the apps ----------
say "Copying the apps to $DIR"
mkdir -p "$DIR/server" "$DIR/data"
IFS=, read -ra LIST <<< "$APPS"
for a in "${LIST[@]}"; do
  [ -d "$HERE/server/$a" ] || { warn "Unknown app: $a"; continue; }
  mkdir -p "$DIR/server/$a" "$DIR/data/$a"
  # replace the program files, keep node_modules (Checkbook) so updates start fast; data lives elsewhere
  find "$DIR/server/$a" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -r "$HERE/server/$a/." "$DIR/server/$a/"
  ok "$a"
done
cp "$HERE/install.sh" "$DIR/install.sh" 2>/dev/null || true

# ---------- 4. Write the stack and start it ----------
say "Starting the apps"
python_filter() { # keep only the chosen services from docker-compose.yml
  awk -v keep=",$APPS," '
    /^services:/ {print; insvc=1; next}
    insvc && /^  [a-z]+:/ {name=$1; sub(":","",name); on=(index(keep, ","name",")>0)}
    insvc && /^[^ #]/ && !/^services:/ {insvc=0}
    !insvc || on || /^services:/ {print}
  ' "$HERE/docker-compose.yml"
}
python_filter > "$DIR/docker-compose.yml"
printf 'RC_DIR=%s\nTZ=%s\n' "$DIR" "$TZV" > "$DIR/.env"
(cd "$DIR" && docker compose pull -q && docker compose up -d --remove-orphans && docker compose restart)
ok "Running"

# ---------- 5. Wait for them to answer ----------
declare -A PORT=( [checkbook]=5080 [notes]=8085 [movies]=8093 [labels]=8095 )
declare -A HPORT=( [checkbook]=8443 [notes]=8444 [movies]=8445 [labels]=8446 )
declare -A NAME=( [checkbook]=Checkbook [notes]=Notes [movies]=Movies [labels]=Labels )
say "Waiting for the apps to start (Checkbook and Labels take a minute the first time)"
for a in "${LIST[@]}"; do
  p=${PORT[$a]}; path=/healthz; [ "$a" = checkbook ] && path=/api/status
  for i in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$p$path" >/dev/null 2>&1; then ok "${NAME[$a]} is up"; break; fi
    sleep 2; [ "$i" = 90 ] && warn "${NAME[$a]} hasn't answered yet. Check:  sudo docker logs root-cellar-$a"
  done
done

# ---------- 6. HTTPS with Tailscale (optional) ----------
TSNAME=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  if [ "$HTTPS" = yes ] || { [ "$HTTPS" = ask ] && yesno "Tailscale is running here. Turn on HTTPS addresses for the apps (needed for phone installs, camera scanning and alerts)?" y; }; then
    say "Turning on HTTPS with Tailscale"
    for a in "${LIST[@]}"; do
      if tailscale serve --bg --https="${HPORT[$a]}" "http://127.0.0.1:${PORT[$a]}" >/dev/null 2>&1; then ok "${NAME[$a]} → port ${HPORT[$a]}";
      else warn "Couldn't turn on HTTPS for ${NAME[$a]}. Make sure HTTPS is enabled in the Tailscale admin console (DNS page), then run this again."; fi
    done
    TSNAME=$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | sed 's/.*"DNSName": *"\([^"]*\)\.".*/\1/')
  fi
else
  [ "$HTTPS" = yes ] && warn "Tailscale isn't installed or signed in here, so HTTPS was skipped. See the guide."
fi

# ---------- 7. Done ----------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say "All done! Open these on any computer or phone:"
printf '\n    %-11s %-30s %s\n' "App" "At home" "Anywhere (Tailscale, HTTPS)"
for a in "${LIST[@]}"; do
  printf '    %-11s %-30s %s\n' "${NAME[$a]}" "http://$IP:${PORT[$a]}" "${TSNAME:+https://$TSNAME:${HPORT[$a]}}"
done
cat <<EOF

    The first person to open each app creates the admin account.
    Your data:   $DIR/data      (back up this folder)
    Update:      put the new Root Cellar folder on the server and run  sudo bash install.sh  again.
    Stop/start:  cd $DIR && sudo docker compose stop   /   sudo docker compose up -d
EOF
