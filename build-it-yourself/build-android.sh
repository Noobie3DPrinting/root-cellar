#!/bin/bash
# Builds one signed Android app (.apk) per app in a suite file.
#   KS_PASS=yourpassword ./build-android.sh suites/root-cellar.json out/
# Needs (Linux): apt install android-sdk android-sdk-platform-23 (for aapt, dx, zipalign, apksigner), a JDK,
#   python3 + Pillow, node, and an Android 14 platform jar at dl/android-34.jar.
# Signing key: keys/release.keystore is created the first time. KEEP IT. Phones only accept updates signed with the same key.
set -e
cd "$(dirname "$0")"; HERE=$(pwd)
SUITE_FILE=$(readlink -f "$1"); OUT=$(readlink -f "${2:-out}"); mkdir -p "$OUT"
JAR=${ANDROID_JAR:-$HERE/dl/android-34.jar}; BT=/usr/lib/android-sdk/build-tools/debian
KEYSTORE=${KEYSTORE:-$HERE/keys/release.keystore}; : "${KS_PASS:?Set KS_PASS to the signing key password}"
J() { node -e "const s=require('$SUITE_FILE');const a=s.apps.find(x=>x.id==='$ID')||{};console.log($1)"; }
mkdir -p "$(dirname "$KEYSTORE")"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -alias release -keyalg RSA -keysize 3072 -validity 36500 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" -dname "CN=$(ID=x J "s.name"), O=Self-hosted" 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
fi
for ID in $(node -e "console.log(require('$SUITE_FILE').apps.map(a=>a.id).join(' '))"); do
  KIND=$(J "a.kind"); TITLE=$(J "a.name"); PKG=$(J "a.pkg"); HOST=$(J "a.host||''"); VERSION=$(J "s.version"); VCODE=$(J "s.versionCode||1")
  BAR=$(J "a.bar||'#5b4330'"); BAR_DARK=$(J "a.barDark||'#1b1814'"); BG=$(J "a.bg||'#ffffff'"); SUITE=$(J "s.name"); FILE=$(J "a.apk")
  ICON=$(J "require('path').resolve(require('path').dirname('$SUITE_FILE'), a.icon)")
  A=$(mktemp -d); SRC="$A/src/$(echo "$PKG" | tr . /)"; mkdir -p "$A/gen" "$A/obj" "$A/assets/www" "$A/res/values" "$SRC"
  fill() { local T="${TITLE//&/\\&}"; sed -e "s|__PKG__|$PKG|g" -e "s|__HOST__|$HOST|g" -e "s|__START__|/|g" -e "s|__ROOT_FILE__|/index.html|g" -e "s|__TITLE__|$T|g" -e "s|__LABEL__|$T|g" \
    -e "s|__BAR_DARK__|$BAR_DARK|g" -e "s|__BAR__|$BAR|g" -e "s|__BG__|$BG|g" -e "s|__VERSION__|$VERSION|g" -e "s|__VCODE__|$VCODE|g" -e "s|__SUITE__|$SUITE|g" "$1"; }
  if [ "$KIND" = offline ]; then
    fill android/offline-AndroidManifest.xml.tmpl | sed "s#@string/app_name#${TITLE//&/\\&amp;}#" > "$A/AndroidManifest.xml"
    fill android/offline-MainActivity.java.tmpl > "$SRC/MainActivity.java"
    UI=$(J "require('path').resolve(require('path').dirname('$SUITE_FILE'), a.ui)")
    cp -r "$UI"/. "$A/assets/www/"; rm -rf "$A/assets/www"/{data,downloads,sw.js,server.js,node_modules,docker-compose.yml,README.txt}
    printf "window.%s = { platform: 'android', version: '%s', defaultServer: '' };\n" "$(J "a.nativeVar")" "$VERSION" > "$A/assets/www/native-config.js"
  else
    fill android/server-AndroidManifest.xml.tmpl > "$A/AndroidManifest.xml"
    fill android/server-MainActivity.java.tmpl > "$SRC/MainActivity.java"
    fill android/server-setup.html.tmpl > "$A/assets/setup.html"; rmdir "$A/assets/www"
  fi
  python3 - "$ICON" "$A/res" <<'PY'
import sys, os
from PIL import Image, ImageDraw
im = Image.open(sys.argv[1]).convert('RGBA').resize((512, 512), Image.LANCZOS)
if im.getpixel((2, 2))[3] == 255:
    m = Image.new('L', (2048, 2048), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, 2047, 2047), radius=448, fill=255); im.putalpha(m.resize((512, 512), Image.LANCZOS))
for d, sz in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    os.makedirs(f'{sys.argv[2]}/mipmap-{d}', exist_ok=True); im.resize((sz, sz), Image.LANCZOS).save(f'{sys.argv[2]}/mipmap-{d}/ic_launcher.png')
PY
  aapt package -f -m -J "$A/gen" -M "$A/AndroidManifest.xml" -S "$A/res" -I "$JAR"
  javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -classpath "$JAR" -d "$A/obj" $(find "$A/src" "$A/gen" -name '*.java') 2>&1 | grep -v "JAVA_TOOL_OPTIONS\|^Note:" || true
  test -f "$A/obj/$(echo "$PKG" | tr . /)/MainActivity.class"
  $BT/dx --dex --min-sdk-version=24 --output="$A/classes.dex" "$A/obj"
  aapt package -f -M "$A/AndroidManifest.xml" -S "$A/res" -A "$A/assets" -I "$JAR" -F "$A/unsigned.apk"
  (cd "$A" && aapt add -f unsigned.apk classes.dex >/dev/null)
  zipalign -f -p 4 "$A/unsigned.apk" "$A/aligned.apk"
  KS_PASS="$KS_PASS" apksigner sign --ks "$KEYSTORE" --ks-key-alias release --ks-pass env:KS_PASS --key-pass env:KS_PASS --min-sdk-version 24 --out "$OUT/$FILE" "$A/aligned.apk"
  apksigner verify --min-sdk-version 24 "$OUT/$FILE" && echo "Android: $OUT/$FILE ($(stat -c%s "$OUT/$FILE") bytes)"
  rm -rf "$A"
done
