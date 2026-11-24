<a id="remember-a-browser-and-reconnect"></a>

# Paired computers and per-stream approval

Pair a browser once, then ask the host to approve each new stream. Temporary
invitations and account-free USB/LAN flows remain available. Automated and
candidate-specific physical results are recorded in
[project status](project-status.md); they do not qualify every browser or transport.

## First connection

1. Start the host with its existing private HTTPS setup. Connect using a temporary invitation over **Same Wi-Fi**, **Direct IP** or **Internet / VPN**.
2. In the receiving browser, open **Options → Remember this browser**. Enter a readable name and select **Request pairing**. Use only your own browser profile.
3. On the host dashboard or desktop app, review **Remembered devices** and select **Allow remembered access**. Pairing lets this browser request streams for 90 days.
4. Return to the same private HTTPS address in the same browser profile. A brief transport interruption can resume the same stream. For a new stream, select **Request to connect** and wait for someone at the computer to choose **Allow** or **Deny**. Select **Cancel request** to withdraw it. Requests expire after one minute.

A remembered device never displaces another active receiver or temporary invitation. A single-window, view-only session cannot enroll a browser for full-desktop access. HTTP/USB/local preview cannot create remembered access.

## Stop and revoke

- **Stop sharing** ends the current stream and pauses remembered access. On the Mac, select **Enable remembered access** when ready to allow approved devices to return.
- **Pause remembered access** prevents remembered reconnection and ends the current browser session.
- **Revoke** removes one saved browser and terminates its associated session or pending ticket. Other devices and unrelated temporary invitations are preserved.
- Receiver **Disconnect** ends that session and preserves the pairing. Select **Request to connect** for another stream, which needs a fresh host decision.
- On the receiver's **Paired computers** card, **Check status** checks whether the saved host is reachable, busy, paused or needs pairing. **Manage pairing** lets you give it a name in this browser. **Forget computer** revokes this browser's pairing and clears its cookie when the host is reachable.
- Clearing site cookies, changing browser/profile/address, expiry, or revocation requires pairing again. A local display name is separate from the browser name shown to the host.

The Mac must be awake, online and running the host. Stored pairing survives
restarting the host service; its private receiver listens without creating an
invitation or capturing. Each new paired stream still needs the host to Allow
its request. This does not start a stopped application, wake a powered-off
computer, unlock FileVault, or configure unattended pre-login VPN access. The
desktop app's separately opt-in login startup applies after user sign-in.

A pending request can survive a receiver-tab reload within its original
one-minute deadline. The paired list re-establishes the same handoff; it does
not approve a new stream. Cancellation waits for the host response. If the host
cannot confirm it, the browser says the request was cancelled locally and that
the pending host request will expire. An unresponsive receiver tab releases the
list controls after ten seconds. These actions never stop an established stream.
An interrupted bootstrap after Allow can resume only the same already approved
capture. If no valid session remains, a new paired stream needs another host
decision. A lost authentication reply does not silently grant another capture.

## Credential and consent boundaries

The browser receives a random 256-bit credential in a host-only `Secure; HttpOnly; SameSite=Strict` cookie scoped to `/stream`. It never enters JavaScript storage, a URL, QR code or diagnostics. A provisional credential grants nothing until local owner approval. The host persists SHA-256 hashes, readable names, exact HTTPS origins, grant times and bounded streaming preferences. The registry also holds an installation signing key. It identifies the installation and carries no stream permission.

Remote mutations require the exact configured HTTPS origin and reject cross-site requests. Pairing and stream approval stay on the existing guarded loopback control surface or validated desktop IPC. After the host allows a request, the requesting browser can claim a short-lived, one-use ticket. Capture starts only when that browser authenticates the stream with its ticket and paired cookie. Cancellation, expiry, pause and revocation are checked again before consuming a ticket. Registry writes are serialized, atomic and fail closed. The host accepts one live stream request at a time and reports busy to another requester. Pending stream requests are held in memory and expire on host restart. The media and input wire remains unchanged.

The receiver saves the public host identity only after approved pairing. An existing pairing gains an identity on its first approved status check after updating. A separate endpoint on the configured HTTPS route signs a fresh challenge bound to that address. It exposes public identity and proof without cookies or connection status. The same installation keeps its key through service restart and address changes. Pairing cookies stay scoped to their original HTTPS origin.

## Save multiple computers

Choose **Open paired computers** on a private HTTPS receiver. Keep this list as the starting page for this browser. Paste a receiver address or invitation link into **Add computer**. In the receiver tab, connect and get pairing approved if needed, then choose **Save to paired computers**. For a new stream, select **Request to connect** on a saved computer. The receiver tab sends the request, and either tab can cancel while the host decision is pending. Keep the receiver tab active when the host approves so it can start the stream before the request expires.

**Check reachability** checks the pinned HTTPS identity without sending a credential. **Check status** opens a computer’s receiver briefly to read its current pairing, busy or paused status. Browser cookies stay on each computer’s address. A browser-generated token lets the saved list send a request through its receiver tab after you save the computer. It carries no ability to start capture without host approval.

Use **Change address** to verify the new HTTPS address with the original computer’s signing key. Select **Pair again**, connect with a fresh code from that host, and save the approved pairing. The list checks the saved identity again and keeps the computer’s name. **Forget** revokes pairing if the saved computer is reachable and provides local removal when the computer is unreachable. A browser that supports service workers can reopen the previously visited list while the computer that served it is offline. The list is tied to that starting address and this browser profile. Keep the existing QR or manual receiver flow for first connections and for browsers that block the tab handoff.

The one-minute request deadline limits admission, not the duration of an
approved stream. Once accepted, a session is bounded by the earlier of its
configured lifetime (twelve hours by default) and the pairing's absolute
ninety-day expiry. Starting shortly before pairing expires does not grant
another full session. Transport resume, media recovery and controller pairing
retain the original deadline. Expiry uses the normal
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
