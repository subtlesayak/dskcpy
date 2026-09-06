# Internet mode (experimental, VPN-backed)

Stream Windows to Android when the phone uses mobile data and the computer uses
a different internet connection. This first version uses **Tailscale** for the
encrypted network and its direct/relay routing. It is not a built-in WebRTC or
AnyDesk relay service. No public ADB port, router port-forward, or hosted GUI is
required. The desktop dashboard remains localhost-only.

## Setup

1. Install Tailscale on the computer and phone. Join the same private network
   and leave Tailscale connected. Account creation, enrollment, VPN permission,
   and network policies remain user-controlled. Tailscale is an external service
   with its own account and device-metadata policies; dskcpy does not
   automatically create accounts or upload project files or diagnostics.
2. Install the updated companion APK from
   `server/build/outputs/apk/debug/server-debug.apk`. A private file transfer
   such as Taildrop can deliver it; Android installation still requires user
   approval. Internet mode does not automatically install or launch Android apps.
3. On the phone, open dskcpy and tap **Start Internet session**. This
   requires an active VPN interface with a Tailscale-range IPv4 address.
   Choose **Passphrase** (12 words, 132 random bits), **Short passphrase**
   (3 words, 33 random bits, less secure), or **Alphanumeric key**
   (26 easy-to-distinguish characters, 130 random bits). The phone generates the
   secret offline and shows its private IP. Changing formats cancels any current
   session; tap Start again for a new secret. **Copy passphrase / Copy key** has
   visible feedback, marks the clipboard sensitive on supported Android versions,
   and attempts to clear only its own clipboard entry after 60 seconds or session
   closure. It never overwrites newer clipboard content. Android can restrict
   clipboard clearing after the app leaves foreground. Screenshots are blocked
   while the secret is displayed.
4. Refresh the desktop dashboard, choose **Internet**, and click **Check private
   network**. Select the online Android peer, enter the key, then start streaming.
   Do not put session keys in chat, screenshots, issue reports, or public URLs.
5. You can press Home or Back, use another app, and return to dskcpy. On Android
   6+, the same session resumes without a new secret. Windows pauses video capture
   while the phone is away and sends a fresh frame on return. A waiting secret
   also survives switching apps, but its original five-minute expiry still applies.
   Allow notifications for a persistent **dskcpy session** entry with **Stop session**.
   Stop in the phone toolbar, notification or desktop to disconnect.
   Removing dskcpy from Recents, force-stopping it, losing the VPN interface, or
   a broken network connection ends the session; those require a new key.
   Android process death is not silently reconnected. USB and Wireless debugging
   are not used by Internet mode. Update both the desktop sender and phone APK.

Tailscale network policy must allow the computer to reach the phone on TCP
`27182`. Do not expose this port through public forwarding. If a key expires or
is rejected, start a new phone session. If the phone is missing, check it is in
the same private network (or shared with the computer owner) and that dskcpy is
not excluded from its VPN.

## Different accounts and shared phones

dskcpy is not tied to one account. For your own devices, the same Tailscale login
is simplest. For different people, each keeps their own login; never share account
passwords. Open **Internet → Connect across accounts** in the dashboard, or
**Different Tailscale accounts?** in the Android app, for the setup guide.

To grant access to only a phone, its owner opens the Tailscale device admin page,
chooses that **Android phone → Share**, and sends a single-use invite to the
computer owner. The computer owner accepts using their own Tailscale account,
then clicks **Check shared phones** and selects the phone from the desktop list.
Use the address visible to that computer: shared-device addresses may be remapped.
The computer initiates the TCP connection to the phone, so sharing only the
computer in the opposite direction is not sufficient under default quarantine.

Alternatively, invite the other account into one tailnet and select that network
on both clients. Tailscale access policy must allow computer → phone on TCP 27182.
The dashboard labels **Same account** or **Different account** when reliable owner
IDs are present, without returning those IDs or account profiles. These are
informational labels, not permission checks. Missing owner metadata remains
unknown; it neither rejects an otherwise visible phone nor bypasses validation.

Both people must consent: the phone receives desktop video and can send touch
input. Prefer the **12-word passphrase** or **26-character key** for another
person. Start an active phone session and exchange its temporary secret privately.
An IP address or secret alone does not bypass Tailscale visibility, network policy
or application authentication. Stop the dskcpy session and revoke the Tailscale
share when access is no longer needed. Re-checking peer visibility before every
new connection blocks peers that are removed or offline; established transport
revocation also depends on Tailscale enforcing its policy updates.

No invitation, account enrollment or access-policy change is made automatically.
Automated tests cover different-owner peer selection, unknown identity, loss of
visibility, and a mutually authenticated bidirectional loopback proxy with
different-owner/shared-device metadata. A real two-account Tailscale connection
still needs both users to accept the invitation and perform a live test.

See [Tailscale device sharing](https://tailscale.com/docs/features/sharing) and
[inviting users](https://tailscale.com/docs/features/sharing/how-to/invite-any-user).
The app's name is dskcpy; its Android package ID and `DisplayBridge/1/` protocol
domains are unchanged to preserve update and connection compatibility.

## Security boundary and protocol

- WireGuard encryption and authenticated device routing are supplied by
  Tailscale. Application HMAC authentication is not a replacement for a VPN and
  does not itself encrypt the stream. The OS, VPN client, local desktop user,
  and phone are trusted. This experimental protocol has not had an independent
  security audit.
- The desktop checks the local Tailscale daemon for an online Android peer;
  arbitrary public, LAN, DNS, and caller-supplied ADB endpoints are rejected.
  Both IPv4 literal parsing and peer membership must pass before connecting.
- The Android listener binds only its VPN IPv4 address, never `0.0.0.0`. It is
  opt-in, owned by a visible foreground service, limited to five failed authentication attempts, and
  expires after five minutes. VPN loss is checked once per second.
- A randomly generated passphrase/key authorizes one session. Words are chosen
  independently from the bundled 2,048-word MIT-licensed BIP-39 English vocabulary;
  this is not a wallet recovery phrase. Passphrases are canonicalized to lowercase
  with single spaces, alphanumeric keys to uppercase. SHA-256 of
  `DisplayBridge/1/secret\0 || canonicalSecret` provides the HMAC key. The desktop
  also accepts the earlier APK's 32-hex-character keys for update compatibility.
  The desktop sends a random
  32-byte nonce. The phone returns a random 32-byte nonce followed by
  HMAC-SHA256 over `DisplayBridge/1/phone\0 || hostNonce || phoneNonce`. After
  verifying that proof, the desktop returns the equivalent proof with role
  `desktop`. The phone replies with byte `1` on success. Comparisons are
  constant-time; role separation and fresh nonces prevent proof reflection and
  reuse. Authentication has a bounded timeout. The key is never sent directly
  across the VPN transport.
- For three-word secrets, the phone initially sends only its nonce. The desktop
  must authenticate first; only then does the phone return its own proof and
  success byte. This prevents an unauthenticated caller from collecting a
  phone-side verifier for offline guessing. Three words are still much weaker
  than the long choices: this is not a PAKE and a malicious selected endpoint or
  captured authenticated transcript can permit offline guessing. Use short
  phrases only between your own trusted VPN devices; prefer 12 words or an
  alphanumeric key for stronger protection. Five failed attempts close the
  receiver and each new session generates a fresh secret.
- The key exists in the phone UI and desktop form/request memory only. It is
  omitted from configuration, commands, process arguments, URLs, logs and
  storage. The form clears it on submission or transport selection changes;
  the phone clears it after authentication/cancellation. Do not save it in a
  password manager or enable request-body logging in front of the local service.
- After authentication, the desktop creates a one-client, short-lived proxy
  on `127.0.0.1`. Native `--reverse-display --reverse-socket=<port>` connects to
  this proxy without starting ADB. Local processes running as the desktop user
  are within the trust boundary. The same full-duplex connection carries H.264
  video and negotiated Opus desktop audio out, and touch/video/audio
  acknowledgements back. Stream buffers are bounded.

## Performance and limitations

Direct private-network connections generally avoid the extra relay hop, but
mobile scheduling, signal strength, packet loss, and carrier routing still
matter. A ping is network RTT only; the app's frame-ACK figure is not physical
screen-to-screen latency. Zero latency is not possible. TCP packet loss can
stall video; no UDP/WebRTC transport or adaptive bitrate is implemented here.

At a sustained 12 Mbps, video alone is about 90 MB per minute before overhead.
Actual use depends on the encoder and changing screen content. Consider a lower
bitrate/frame rate for metered data. This mode still uses the Windows capture
backend; adding VPN support does not implement macOS capture.

Desktop audio adds approximately 128 kbps (about 0.96 MB/minute before protocol
overhead). The phone's Settings and live toolbar can mute audio independently
of Windows. Leaving the app pauses audio with video; returning resumes it.
See [desktop audio](reverse-display.md#desktop-audio) for capture limitations.

## Verification

Run `npm --prefix gui test`, `npm --prefix gui run build`, and
`gradlew :server:assembleDebug :server:testDebugUnitTest`, plus the native Meson
tests. These cover peer validation, secret exclusion, role-separated proof
vectors shared between Java/Node, wrong/replayed proofs, fragmented greetings,
cancellation, proxy byte transfer and CLI conflicts. They do not prove physical
Android decoding, cellular stability, or measured latency improvement.

For an opt-in **local** capture smoke test on Windows, set
`SCRCPY_NATIVE_INTERNET_TEST=1` and run
`node --test gui/server/native-internet.test.mjs`. It sends desktop frames only
to loopback, discards payloads, sends no touch/system actions, and verifies the
full-duplex native path with ADB deliberately unavailable. It is not a phone test.

References: [Tailscale setup](https://tailscale.com/docs/how-to/connect-to-devices),
[connection types](https://tailscale.com/docs/reference/connection-types),
[Android networking implementation](https://github.com/tailscale/tailscale-android/blob/main/libtailscale/tailscale.go).
