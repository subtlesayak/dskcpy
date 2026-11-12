# Remember a browser and reconnect

This source candidate adds opt-in remembered access alongside temporary invitations. It is not installed on the existing office host and has not been physically qualified in Android Edge.

## First connection

1. Start the host with its existing private HTTPS/VPN setup. Connect using a normal temporary invitation.
2. In the receiving browser, open **Options → Remember this browser**. Enter a readable name and select **Ask Mac to remember**. Use only your own browser profile.
3. On the Mac dashboard or desktop app, review **Remembered devices** and select **Allow remembered access**. Approval permits full desktop viewing, audio and mouse/keyboard control for 90 days while the host is running.
4. Bookmark the same private receiver address. Return in the same browser/profile with the private VPN connected. The receiver first tries the short session resume, then requests a fresh connection using its saved credential. **Reconnect to my Mac** allows a deliberate retry after Disconnect.

A remembered device never displaces another active receiver or temporary invitation. A single-window, view-only session cannot enroll a browser for full-desktop access. HTTP/USB/local preview cannot create remembered access.

## Stop and revoke

- **Stop sharing** ends the current stream and pauses remembered access. On the Mac, select **Enable remembered access** when ready to allow approved devices to return.
- **Pause remembered access** prevents remembered reconnection and ends the current browser session.
- **Revoke** removes one saved browser and terminates its associated session or pending ticket. Other devices and unrelated temporary invitations are preserved.
- Receiver **Disconnect** ends that session and suppresses automatic retries in that tab. It preserves approval; select **Reconnect to my Mac** to connect again.
- Clearing site cookies, changing browser/profile/address, expiry, or revocation requires pairing again.

The Mac must be awake, online and running the host. Stored approval survives restarting this host service; its private receiver listens without creating an invitation or capturing until an approved browser connects. This does not start a stopped application, wake a powered-off computer, unlock FileVault, or configure unattended pre-login VPN access. The desktop app's separately opt-in login startup applies after user sign-in.

## Credential and consent boundaries

The browser receives a random 256-bit credential in a host-only `Secure; HttpOnly; SameSite=Strict` cookie scoped to `/stream`. It never enters JavaScript storage, a URL, QR code or diagnostics. A provisional credential grants nothing until local owner approval. The host persists only SHA-256 hashes, readable names, exact HTTPS origins, grant times and bounded streaming preferences. No reusable plaintext credential is written by the host.

Remote mutations require the exact configured HTTPS Origin and reject cross-site requests. Owner approval, pause and revoke stay on the existing guarded loopback control surface or validated desktop IPC. Tickets are one-use and expire after 15 seconds; granting a ticket alone does not start capture. Approval, expiry, pause and revocation are checked again before consuming a ticket. Registry writes are serialized, atomic and fail closed; corrupt/unwritable storage blocks remembered access. There are at most 20 grants, one current enrollment request and one connecting preparation. The existing authenticated media/input wire remains unchanged.

The source library defaults to no persistent registry. Real launcher entry points explicitly use the user's dskcpy data directory; Electron uses its own application data directory. Tests supply disposable directories and fake capture only.

## PiP and validation limits

Playback now treats the receiver video being in standard Picture-in-Picture (or reported WebKit presentation mode) as visible even if its original page is hidden. Closing PiP while the page remains hidden restores the normal bounded away timeout. This addresses a reproducible lifecycle logic gap; it does not prove the cause of previously reported drops or guarantee that Android Edge reports every OS PiP transition. Browser termination, mobile background restrictions and VPN loss still need device testing.

Automated checks cover saved approval after receiver restart, token hashing/origin binding/expiry, persistent pause/revoke, revoked or pending requests, view-only and CSRF denial, concurrent invitations, revocation during awaited preparation, receiver automatic reconnect, explicit Disconnect, and PiP playback state. Synthetic desktop UI tests cover owner approval/pause/resume/revoke at 320 and 620 pixels. No real device has been enrolled by these tests; no live host has been switched.
