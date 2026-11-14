# dskcpy Host desktop app — development prototype

The product target is a beginner completing setup without Terminal commands,
port numbers, installing Node, choosing native artifacts, or asking another
person to restart the host after every connection.

The everyday flow is **Open dskcpy → Choose USB cable or Private network → Start sharing**. USB opens the receiver on the authorized Android phone; private connections use a link or QR.
First launch walks through the next required screen/control permission and the
existing private connection setup. Each step explains what it allows and has
one primary action. Closing the window keeps the app in the menu bar or system
tray; Stop remains available there. Quit confirms ending an owned session.

## Implemented slice

- Electron shell for macOS menu-bar / Windows tray, with embedded Node and a
  bundled native host and pinned ADB platform-tools runtime. No user Node installation or Terminal launcher.
- Separate React setup entry, permission guidance, component readiness, private
  route detection, one Start sharing action, QR and Copy private link, cancel
  and Stop actions. Keyboard capability is reported by the native backend.
- Temporary invitations use the existing authenticated browser receiver. Keys
  remain in memory and disappear from the UI on connection/expiry. Copying a
  link is an explicit action; links are not written to settings or diagnostics.
- The app creates its own utility process and ephemeral loopback controller.
  It does not discover or stop an existing controller. A busy receiver port
  causes the new invitation to fail; it does not take over another stream.
- Private Tailscale Serve setup requires an in-app confirmation, refuses a
  conflicting handler, and never provisions Funnel or public infrastructure.
- Sandboxed renderer, context isolation, main-frame checked IPC and fixed
  commands. No arbitrary shell, URL, filesystem or IPC API is exposed.
- Separate, off-by-default text clipboard permission for each invitation.
  The receiver then opts in on its current connection and uses explicit read,
  copy or paste actions. Clipboard access is excluded from remembered grants.
  See [clipboard boundaries and protocol](../doc/browser-clipboard.md).

The shell now guides account-free Android USB browser connections alongside
private browser connections. Choose USB cable, connect and unlock an Android
phone with a data cable, enable USB debugging and accept its authorization
prompt. Check again; one authorized phone is selected automatically, while
multiple phones require an explicit choice. Start sharing creates the existing
owned, non-rebinding USB tunnel and opens the one-use invitation in the phone
browser. There is no QR step. If Android cannot open a browser, Copy USB link
provides a manual fallback on that same connected phone. The link alone does
not work on an unrelated device. Unlock/authorization, cable/port and Windows
phone-driver guidance is shown in the relevant state. USB setup does not call
Tailscale checks or configure a network route. Physical app/cable and fresh
Windows driver qualification remain open; fake fixtures are not hardware proof.

Device serials stay inside the utility process. The renderer receives temporary
selection handles and bounded model labels. Start rechecks authorization and
presence; removed handles expire. Emulators and wireless peers are excluded.
Connection changes are refused while the app owns an invitation or stream.
LAN still uses the existing dashboard/launchers and is not yet integrated into
this simplified shell. The existing account-free USB/LAN paths are preserved. The optional Startup
setting is unavailable in unpackaged builds and outside Applications on Mac;
OS registration and clean login behavior still require physical qualification. Tailscale is a separate
dependency and its first enrollment/access grant is still required. A ready
host route does not prove the receiving device has VPN access.

## Developer build

Run on the target platform, from the repository root, with Node 22.12+ and npm:

```sh
npm ci --prefix gui
npm ci --prefix desktop
npm run build --prefix gui
cd gui
node node_modules/vite/bin/vite.js build --config vite.desktop.config.ts
cd ..
node desktop/stage.mjs PATH_TO_NATIVE_HOST NATIVE_LICENSES_DIRECTORY PINNED_PLATFORM_TOOLS_DIRECTORY
npm run package:mac --prefix desktop
# Or, on Windows with scrcpy.exe and its complete DLL set together:
npm run package:windows --prefix desktop
# Verify the assembled Resources folder before considering the artifact built:
node desktop/verify-bundle.mjs PATH_TO_APP_RESOURCES
```

Staging refuses an existing `desktop/stage` directory. Review and remove only
that generated directory before restaging. It copies declared code/assets,
installs production dependencies from the GUI lockfile, checks native `--help`
from the staged location and writes a hashed inventory. The Mac check requires
arm64, deployment targets no newer than 13.0 and system-only dynamic linkage.
Windows checks staged DLL loading without relying on an external MSYS PATH.
ADB is required at staging: use the existing checksum-pinned `adb_macos.sh` or
`adb_windows.sh` input. Staging verifies Mac linkage/target or the bounded
Windows DLL closure, includes its NOTICE, and executes only `adb version` from
the bundled directory. Bundle verification hashes the USB runtime and notice
and repeats version-only loading; it does not enumerate devices or start ADB.
Use `-` for the native-license directory in a development Windows build when
notices are not yet assembled; the manifest records that release gate as open.
Before any bundled backend import or native `--help`, verification now compares
all shipped first-party files under `app/desktop` and `app/gui`, root application
metadata, and the entire native `host/bin` payload with the staged hashes. It
rejects missing, changed or unexpected files, directory links and malformed
manifest paths. The GUI lockfile is intentionally omitted from this comparison
because electron-builder prunes it. Third-party package metadata/pruning is a
separate packaging transform; this is not a signature or a complete third-party
supply-chain audit.

These checks do not establish minimum-OS or physical media compatibility.

The optional native-license input is for development staging; a missing input
is recorded as incomplete. Public distribution remains blocked on a reviewed
complete notice/source-offer set. Electron and npm notices must also ship.

Windows CI collects the transitive x64 DLL closure with the existing bounded PE
parser, including delay imports,
rejects missing/conflicting libraries, and probes the copied executable with
no external MSYS directory in PATH. Native Windows CI assembles/verifies the
development app without launching capture or uploading an installer.

The system-import allowlist additionally checks the actual System32 file. The
following Windows components were identified from the failed clean-build
closure and verified against Microsoft documentation; they must not be copied
from a developer's machine into the package:

| Component | Official reference |
| --- | --- |
| `dwrite.dll` | [DWriteCreateFactory](https://learn.microsoft.com/en-us/windows/win32/api/dwrite/nf-dwrite-dwritecreatefactory) |
| `gdiplus.dll` | [GdiplusStartup](https://learn.microsoft.com/en-us/windows/win32/api/gdiplusinit/nf-gdiplusinit-gdiplusstartup) |
| `ncrypt.dll` | [NCryptOpenStorageProvider](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptopenstorageprovider) |
| `usp10.dll` | [ScriptFreeCache](https://learn.microsoft.com/en-us/windows/win32/api/usp10/nf-usp10-scriptfreecache) |
| `wsock32.dll` | [Windows Sockets compatibility](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-compatibility-issues-2) |

Unknown dependencies still fail collection. The copied native executable must
also load with only its packaged directory and Windows system directories in
PATH; passing this CI check does not qualify physical capture or minimum OS.

Builder targets currently produce unsigned **development app directories**,
not public installers. No app is installed, launched, permission-granted,
signed, notarized, published or substituted for a running host by these steps.
Developer signing/notarization and Windows signing require separate approval.
The stable intended bundle identity is `com.dskcpy.host`; an unsigned prototype
does not prove permission continuity across upgrades.

## Checks

```sh
node --test --test-timeout=15000 desktop/test/*.test.mjs
cd gui
node node_modules/typescript/bin/tsc --noEmit
cd ..
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/node_modules/playwright/cli.js install chromium
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/beginner-ui.mjs
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/usb-ui.mjs
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/remembered-ui.mjs
PLAYWRIGHT_BROWSERS_PATH=desktop/.browsers node desktop/test/remembered-cookie.mjs
```

Service integration uses a fake no-capture executable and a new ephemeral
controller. Headless UI checks use synthetic state and an owned static server;
they never create a real invitation, read the screen, change permissions, or
contact a running host. `node desktop/test/run-electron-smoke.mjs` checks the
assembled app’s real Electron renderer/preload and utility IPC, including an empty temporary remembered-device registry and pause, in a hidden
window with a fake --help-only native. The main host shell, OS permission and
startup APIs, clipboard writes and Tailscale are not invoked. This is distinct
from desktop media/TCC qualification. Screenshots are test fixtures, not hardware proof. The remembered-cookie check
uses a fully intercepted synthetic HTTPS origin and temporary Chromium profile,
not a certificate bypass or a real VPN/TLS endpoint. It verifies cookie flags,
JavaScript isolation at the matching path, browser and fixture-host restarts,
and revocation with synthetic grants, then deletes the owned profile/registry.
The temporary-session bootstrap is supplied by the fixture; this test does not
claim a physical first-pairing, TLS, media, or Android browser result.

## Beginner release gates still open

1. Signed/notarized Mac app and signed Windows installer, reviewed dependency
   notices, reproducible artifact verification and clean install/upgrade tests.
2. Fresh-account permission walkthrough, responsible-app identity and regrant
   recovery on real hardware, including Mac audio and Windows native input.
3. Qualify the implemented opt-in launch-at-login setting on installed/signed
   builds and across upgrades. Source reads never enroll it; user toggles use
   fixed app identity and verify OS approval. Login opens the tray only and
   does not start capture by itself. Approved remembered browsers may reconnect when saved access is enabled. Awake/restart guidance remains.
4. Physically qualify the opt-in remembered-browser enrollment, names, pause,
   revocation and long reconnect implemented in this source candidate. See
   [remembered browsers](../doc/remembered-browsers.md). Temporary invitation
   access is never silently promoted to remembered access.
5. Physically qualify the implemented account-free USB app flow and automatic
   Android browser opening; integrate LAN and actionable peer/reachability
   checks for private networks.
6. Complete Windows keyboard/IME, relevant browser/device matrix, failure and
   recovery tests; collect observed beginner completion time/error rates.

Initial package targets are Apple-silicon macOS and Windows x64. Intel Mac,
Windows ARM, Linux hosting and Safari/iOS receiving are separate qualification
gates. Do not label this prototype universal or beginner-release-ready.

## Current remote recovery and power limits

The existing receiver can resume the same browser session after a brief drop or
background period, within about two minutes, while the host remains running.
Keep Tailscale connected, reopen the same receiver tab and let it retry; refresh
once if needed. Disconnect explicitly ends that session. An expired session or
restarted host needs either an explicitly approved remembered browser in this
source candidate or a new one-use invitation from the Mac. An old QR is not a
remembered-device credential. The running Terminal baseline has not been
updated by building this candidate.

Shutdown/restart ends the stream. The existing Terminal host has no verified
reboot recovery. The prototype’s optional login setting opens the tray after
user login; an approved browser can request capture only when remembered
access is enabled and the private route is available. It does not unlock the Mac, keep a
user-session VPN alive before login, or authorize a permanent receiver. Do not
promise phone-only recovery across cold boot. Qualify signed app startup,
private-route availability, explicit remembered-device authentication and owner
revocation/pause behavior before calling unattended reconnection complete.

USB authorization reference: [Android ADB setup](https://developer.android.com/tools/adb#Enabling). No driver, account, security-setting or permission changes are performed by the source/build checks.

The pinned Windows ADB files are x86 PE32 on the x64 host target. They are
validated independently of scrcpy’s x64 runtime; both AdbWinApi and the
runtime-loaded AdbWinUsbApi are required. Known x86 OS dependencies must exist
in SysWOW64, while API-set names remain virtual imports. No Windows system DLL
is copied. References: [WOW64 file redirection](https://learn.microsoft.com/en-us/windows/win32/winprog64/file-system-redirector),
[DbgHelp](https://learn.microsoft.com/en-us/windows/win32/debug/dbghelp-functions),
[WLAN](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlanopenhandle),
[WinUSB](https://learn.microsoft.com/en-us/windows/win32/api/winusb/nf-winusb-winusb_initialize).
