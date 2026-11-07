#!/bin/bash
# Builds the Windows desktop app + installer from a suite file.
#   ./build-windows.sh suites/root-cellar.json  out/
# Needs (Linux): node, makensis (apt install nsis), python3 + Pillow, unzip, and the Electron Windows zip
#   (ELECTRON_ZIP, from https://github.com/electron/electron/releases : electron-vXX-win32-x64.zip).
set -e
cd "$(dirname "$0")"; HERE=$(pwd)
SUITE_FILE=$(readlink -f "$1"); OUT=$(readlink -f "${2:-out}"); mkdir -p "$OUT"
ELECTRON_ZIP=${ELECTRON_ZIP:-$HERE/dl/electron-win.zip}
J() { node -e "const s=require('$SUITE_FILE');console.log($1)"; }
NAME=$(J "s.name"); EXE=$(J "s.exe"); VERSION=$(J "s.version"); PUBLISHER=$(J "s.publisher||s.name")
W=$(mktemp -d); D="$W/dist/$EXE"; mkdir -p "$D"
unzip -q "$ELECTRON_ZIP" -d "$D"
( cd "$D"; mv electron.exe "$EXE.exe"; rm -f resources/default_app.asar; find locales -type f ! -name 'en-US.pak' -delete )
R="$D/resources/app"; mkdir -p "$R/icons" "$R/apps"
cp windows-shell/{main.js,preload.js,launcher.html,setup.html,shell.css} "$R/"
node -e "const s=require('$SUITE_FILE');const o={name:s.name,appId:s.appId,bg:s.bg,apps:s.apps.map(a=>({id:a.id,name:a.name,kind:a.kind,host:a.host,bg:a.bg}))};require('fs').writeFileSync('$R/suite.json',JSON.stringify(o,null,1))"
printf '{ "name": "%s", "productName": "%s", "version": "%s", "main": "main.js", "private": true }\n' "$(echo "$EXE" | tr 'A-Z ' 'a-z-')" "$NAME" "$VERSION" > "$R/package.json"

# icons: suite + one per app (rounded corners if the source is a full square)
python3 - "$SUITE_FILE" "$R/icons" <<'PY'
import sys, json, os
from PIL import Image, ImageDraw
s = json.load(open(sys.argv[1])); base = os.path.dirname(sys.argv[1]); out = sys.argv[2]
def rounded(p):
    im = Image.open(p if os.path.isabs(p) else os.path.join(base, p)).convert('RGBA').resize((512, 512), Image.LANCZOS)
    if im.getpixel((2, 2))[3] == 255:
        m = Image.new('L', (2048, 2048), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, 2047, 2047), radius=448, fill=255)
        im.putalpha(m.resize((512, 512), Image.LANCZOS))
    return im
for key, path in [('suite', s['icon'])] + [(a['id'], a['icon']) for a in s['apps']]:
    im = rounded(path); im.save(f'{out}/{key}.png')
    im.save(f'{out}/{key}.ico', sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(128,128),(256,256)])
PY

# offline apps: bundle their screens, pointing at no server until the person types one in
for id in $(J "s.apps.filter(a=>a.kind==='offline').map(a=>a.id).join(' ')"); do
  SRC=$(J "require('path').resolve(require('path').dirname('$SUITE_FILE'), s.apps.find(a=>a.id==='$id').ui)")
  VAR=$(J "s.apps.find(a=>a.id==='$id').nativeVar")
  mkdir -p "$R/apps/$id"; cp -r "$SRC"/. "$R/apps/$id/"
  rm -rf "$R/apps/$id"/{data,downloads,sw.js,server.js,node_modules,docker-compose.yml,README.txt}
  printf "window.%s = { platform: 'windows', version: '%s', defaultServer: '' };\n" "$VAR" "$VERSION" > "$R/apps/$id/native-config.js"
done

COMPANY="$PUBLISHER" node setexe.mjs "$D/$EXE.exe" "$R/icons/suite.ico" "$VERSION" "$NAME" "$EXE"
cp -r "$R/icons" "$W/icons"
# Start menu + desktop shortcuts, one per app
{
  echo '!macro STARTMENU'
  echo "  CreateShortCut \"\$SMPROGRAMS\\\${SUITE}\\\${SUITE}.lnk\" \"\$INSTDIR\\\${EXE}.exe\" \"\" \"\$INSTDIR\\resources\\app\\icons\\suite.ico\" 0"
  J "s.apps.map(a=>'  CreateShortCut \"\$SMPROGRAMS\\\\\${SUITE}\\\\'+a.name+'.lnk\" \"\$INSTDIR\\\\\${EXE}.exe\" \"--app='+a.id+'\" \"\$INSTDIR\\\\resources\\\\app\\\\icons\\\\'+a.id+'.ico\" 0').join('\n')"
  echo '!macroend'
  echo '!macro DESKTOP'
  J "s.apps.map(a=>'  CreateShortCut \"\$DESKTOP\\\\'+a.name+'.lnk\" \"\$INSTDIR\\\\\${EXE}.exe\" \"--app='+a.id+'\" \"\$INSTDIR\\\\resources\\\\app\\\\icons\\\\'+a.id+'.ico\" 0').join('\n')"
  echo '!macroend'
  echo '!macro UNDESKTOP'
  J "s.apps.map(a=>'  Delete \"\$DESKTOP\\\\'+a.name+'.lnk\"').join('\n')"
  echo '!macroend'
} > "$W/shortcuts.nsh"
cp installer.nsi "$W/"
sed -i '0,/^!include "MUI2.nsh"/s//!include "MUI2.nsh"\n!include "shortcuts.nsh"/' "$W/installer.nsi"
OUTFILE="$OUT/$NAME Setup $VERSION.exe"
(cd "$W" && makensis -V2 -DSUITE="$NAME" -DEXE="$EXE" -DVERSION="$VERSION" -DPUBLISHER="$PUBLISHER" -DOUTFILE="$OUTFILE" installer.nsi)
rm -rf "$W"
echo "Windows: $OUTFILE"
