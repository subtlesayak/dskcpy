# Remember a browser and reconnect

This source candidate adds opt-in remembered access alongside temporary invitations. It is not installed on the existing office host and has not been physically qualified in Android Edge.

## First connection

1. Start the host with its existing private HTTPS/VPN setup. Connect using a normal temporary invitation.
2. In the receiving browser, open **Options → Remember this browser**. Enter a readable name and select **Request pairing**. Use only your own browser profile.
3. On the host dashboard or desktop app, review **Remembered devices** and select **Allow remembered access**. Pairing lets this browser request streams for 90 days.
4. Return to the same private HTTPS address in the same browser profile. A brief transport interruption can resume the same stream. For a new stream, select **Request to connect** and wait for someone at the computer to choose **Allow** or **Deny**. Select **Cancel request** to withdraw it. Requests expire after one minute.

A remembered device never displaces another active receiver or temporary invitation. A single-window, view-only session cannot enroll a browser for full-desktop access. HTTP/USB/local preview cannot create remembered access.

## Stop and revoke

- **Stop sharing** ends the current stream and pauses remembered access. On the Mac, select **Enable remembered access** when ready to allow approved devices to return.
- **Pause remembered access** prevents remembered reconnection and ends the current browser session.
- **Revoke** removes one saved browser and terminates its associated session or pending ticket. Other devices and unrelated temporary invitations are preserved.
- Receiver **Disconnect** ends that session and preserves the pairing. Select **Request to connect** for another stream, which needs a fresh host decision.
- Clearing site cookies, changing browser/profile/address, expiry, or revocation requires pairing again.

The Mac must be awake, online and running the host. Stored approval survives restarting this host service; its private receiver listens without creating an invitation or capturing until an approved browser connects. This does not start a stopped application, wake a powered-off computer, unlock FileVault, or configure unattended pre-login VPN access. The desktop app's separately opt-in login startup applies after user sign-in.

## Credential and consent boundaries

The browser receives a random 256-bit credential in a host-only `Secure; HttpOnly; SameSite=Strict` cookie scoped to `/stream`. It never enters JavaScript storage, a URL, QR code or diagnostics. A provisional credential grants nothing until local owner approval. The host persists only SHA-256 hashes, readable names, exact HTTPS origins, grant times and bounded streaming preferences. No reusable plaintext credential is written by the host.

Remote mutations require the exact configured HTTPS origin and reject cross-site requests. Pairing and stream approval stay on the existing guarded loopback control surface or validated desktop IPC. After the host allows a request, the requesting browser can claim a short-lived, one-use ticket. Capture starts only when that browser authenticates the stream with its ticket and paired cookie. Cancellation, expiry, pause and revocation are checked again before consuming a ticket. Registry writes are serialized, atomic and fail closed. The host accepts one live stream request at a time and reports busy to another requester. Pending stream requests are held in memory and expire on host restart. The media and input wire remains unchanged.

This first approval flow uses one verified HTTPS receiver origin at a time. Cross-origin computer lists, renaming and forgetting from a shared client screen, and host identity across address changes require a separate client identity design.

A remembered connection is bounded by the earlier of the configured session
lifetime and its approval's absolute expiry. Starting shortly before approval
expires does not grant another full session. Transport resume, media recovery
and controller pairing retain the original deadline. Expiry uses the normal
session-close path to release held input and end all associated roles; a saved
cookie cannot start or resume an expired grant. Temporary invitations retain
their existing configured lifetime.

The source library defaults to no persistent registry. Real launcher entry points explicitly use the user's dskcpy data directory; Electron uses its own application data directory. Tests supply disposable directories and fake capture only.

## PiP and validation limits

Playback now treats the receiver video being in standard Picture-in-Picture (or reported WebKit presentation mode) as visible even if its original page is hidden. Closing PiP while the page remains hidden restores the normal bounded away timeout. This addresses a reproducible lifecycle logic gap; it does not prove the cause of previously reported drops or guarantee that Android Edge reports every OS PiP transition. Browser termination, mobile background restrictions and VPN loss still need device testing.

Automated checks cover saved approval after receiver restart, token hashing/origin binding/expiry, persistent pause/revoke, revoked or pending requests, view-only and CSRF denial, concurrent invitations, revocation during awaited preparation, receiver automatic reconnect, explicit Disconnect, and PiP playback state. Synthetic desktop UI tests cover owner approval/pause/resume/revoke at 320 and 620 pixels. No real device has been enrolled by these tests; no live host has been switched.


The Chromium cookie fixture additionally exercises the actual enrollment
Set-Cookie response, flags and HttpOnly isolation at `/stream`, closing and
reopening Chromium with its owned test profile, restarting the fixture host,
and revocation. It uses a fully intercepted HTTPS fixture origin and fake
native sessions, with no certificate-trust bypass, real device or actual media.
This strengthens storage/reconnect evidence without replacing real HTTPS/VPN
and Android Edge lifecycle qualification. The temporary-session bootstrap is
provided by the fixture, rather than a physical first pairing.

The additional `desktop/test/remembered-network.mjs` matrix exercises actual
network cookie and WSS behavior in Chromium and WebKit against an owned loopback
HTTPS proxy and real broker with synthetic native headers. No credentials are
injected: the browser receives the temporary resume and enrollment cookies from
the WSS and HTTP responses. It covers approval, HttpOnly/Secure/SameSite/path
properties, profile and host restart, ticket handoff, transport resume without a
new capture, pause/resume, denial from a separate unapproved context, revoke and
server-side expiry with the browser cookie still present. The `expiry` case uses
an injected registry clock to check reconnect denial. The `active-expiry` case
models an old approval ending shortly, then follows real elapsed time through
transport resume and automatic active-session closure. A loopback regression
also verifies held touch/key release at that deadline. No system/browser clock
is changed; this is software evidence, not physical-device expiry qualification.

The old intercepted-origin fixture did not expose cookies on its WebKit routed
requests. A separate network fixture avoids treating that interception behavior
as a production enrollment defect. Another initial replay assertion used a
second tab in the approved context, which legitimately had its resume cookie;
the negative test now uses a separate, unapproved context. Cookie, origin and
replay assertions remain enforced. Those fixture corrections preserve the
existing credential policy; the active-session fix changes only the lifetime
bound when a remembered ticket is consumed.

Only disposable browser contexts accept the owned self-signed TLS certificate,
with other origins blocked and same-origin WSS constrained by CSP. This is not
certificate-validation, Safari/iOS, physical media, VPN or mobile background
qualification. System trust and any running host remain untouched.
