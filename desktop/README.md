# dskcpy Host desktop app — development prototype

The product target is a beginner completing setup without Terminal commands,
port numbers, installing Node, choosing native artifacts, or asking another
person to restart the host after every connection.

The everyday flow is **Open dskcpy → Start sharing → Send the link or scan QR**.
First launch walks through the next required screen/control permission and the
existing private connection setup. Each step explains what it allows and has
one primary action. Closing the window keeps the app in the menu bar or system
tray; Stop remains available there. Quit confirms ending an owned session.

## Implemented slice

- Electron shell for macOS menu-bar / Windows tray, with embedded Node and a
  bundled native host. No user Node installation or Terminal launcher.
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

This first app slice guides private browser connections. The existing account-
free USB/LAN launchers and dashboard are preserved unchanged in the project.
They are not yet integrated into this simplified shell. The optional Startup
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
node desktop/stage.mjs PATH_TO_NATIVE_HOST NATIVE_LICENSES_DIRECTORY
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
These checks do not establish minimum-OS or physical media compatibility.

The optional native-license input is for development staging; a missing input
is recorded as incomplete. Public distribution remains blocked on a reviewed
complete notice/source-offer set. Electron and npm notices must also ship.

Windows CI collects the transitive x64 DLL closure using build-time objdump,
rejects missing/conflicting libraries, and probes the copied executable with
no external MSYS directory in PATH. Native Windows CI assembles/verifies the
development app without launching capture or uploading an installer.

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
```

Service integration uses a fake no-capture executable and a new ephemeral
controller. Headless UI checks use synthetic state and an owned static server;
they never create a real invitation, read the screen, change permissions, or
contact a running host. `node desktop/test/run-electron-smoke.mjs` checks the
assembled app’s real Electron renderer/preload and utility IPC in a hidden
window with a fake --help-only native. The main host shell, OS permission and
startup APIs, clipboard writes and Tailscale are not invoked. This is distinct
from desktop media/TCC qualification. Screenshots are test fixtures, not hardware proof.

## Beginner release gates still open

1. Signed/notarized Mac app and signed Windows installer, reviewed dependency
   notices, reproducible artifact verification and clean install/upgrade tests.
2. Fresh-account permission walkthrough, responsible-app identity and regrant
   recovery on real hardware, including Mac audio and Windows native input.
3. Qualify the implemented opt-in launch-at-login setting on installed/signed
   builds and across upgrades. Source reads never enroll it; user toggles use
   fixed app identity and verify OS approval. Login opens the tray only and
   leaves screen sharing stopped. Awake/restart guidance remains.
4. Explicit remembered-device enrollment, readable names and revocation so a
   previously approved personal device can reconnect without someone in the
   office creating another five-minute invitation. Temporary invite access is
   not silently promoted to permanent trust.
5. Integrate account-free USB/LAN into the same guided flow, automatic Android
   USB opening, and actionable peer/reachability checks for private networks.
6. Complete Windows keyboard/IME, relevant browser/device matrix, failure and
   recovery tests; collect observed beginner completion time/error rates.

Initial package targets are Apple-silicon macOS and Windows x64. Intel Mac,
Windows ARM, Linux hosting and Safari/iOS receiving are separate qualification
gates. Do not label this prototype universal or beginner-release-ready.
