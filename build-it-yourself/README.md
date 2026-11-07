# Building the phone and PC apps yourself

You only need this if you changed the apps or want your own signing key. The ready-made apps are already in `apps-for-phones-and-pcs`.

Everything builds on **Linux** (Ubuntu/Debian), without Android Studio or a Windows PC.

## One-time setup

```
sudo apt install -y openjdk-17-jdk-headless android-sdk android-sdk-platform-23 dalvik-exchange nsis python3-pil nodejs npm unzip
```

```
cd build-it-yourself && npm install && mkdir -p dl
```

Download two files into the `dl` folder:

- **Android 14 platform library** → save as `dl/android-34.jar` (from an Android SDK: `platforms/android-34/android.jar`).
- **Electron for Windows** → save as `dl/electron-win.zip` (from [github.com/electron/electron/releases](https://github.com/electron/electron/releases), the `electron-vXX.X.X-win32-x64.zip` file).

## Build

Android (makes `keys/release.keystore` the first time — **keep it and its password safe**; phones only accept updates signed with the same key):

```
KS_PASS='choose-a-long-password' ./build-android.sh suites/root-cellar.json out
```

Windows installer:

```
./build-windows.sh suites/root-cellar.json out
```

## How it fits together

- `suites/*.json` lists the apps: their names, icons, Android package names, and whether each is
  - **offline** — the app's screens are bundled inside the phone/PC app and keep a full copy of the data (Checkbook, Notes), or
  - **server** — the app opens your server's address, which it asks for the first time (Movies, Labels, Our Dynamic).
- `android/` holds the Android templates (`offline-…` and `server-…`).
- `windows-shell/` is the small Electron program that gives every app its own window, taskbar icon and Start menu shortcut.
- To change an app's look or features, change its files in the `server` folder, then rebuild.
