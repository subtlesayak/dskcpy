# Private receiver check before sharing

The desktop app previously treated a matching Tailscale Serve configuration as
proof that the receiver page worked. **Start sharing** now prepares only its own
receiver listener, then checks the configured HTTPS endpoint before creating
or showing an invitation. The receiver does not start native capture or grant
browser access during this check. USB skips private-route preparation/probing.

The UI shows **Checking your private link** with a keyboard-reachable Cancel
action. Name-resolution, certificate, unexpected-response and connection failures
receive fixed guidance. Retry repeats the check; a failed check creates no
invitation. Cancelling or quitting aborts it and invalidates delayed results.
An approved receiver connecting during preparation, or winning the final
invitation race, is preserved rather than stopped by a failed new Start.
An already-pending connection has a waiting message instead of an empty QR.

## Ownership and bounds

- The app's owned utility process requests `/api/browser/prepare` on its own
  ephemeral loopback controller. Existing origin/POST guards apply. No discovered
  controller is attached to or stopped.
- Preparation only binds the existing receiver listener and returns its
  configured origin and a fresh per-process marker. It refuses an existing
  invitation/session. The `/health` response contains only a fixed service tag
  and this launch marker, with no-store/host/security headers. It reveals no
  device, session, invitation, permission, capture or connection state. The
  marker grants no access and is not persisted, logged or shown in the renderer.
- The desktop probe requires that descriptor to match the configured private
  Tailscale HTTPS origin. It sends one GET to `/health`, no query credentials,
  cookies or authorization. It requires the owned marker and exact response
  schema, at most256 body bytes and4096 header bytes, within a four-second
  wall-clock bound. Redirects, compressed bodies and arbitrary origins fail.
- TLS validation stays enabled with a minimum TLS1.2. No CA override or custom
  identity verifier is supplied by this module. It does not change routes,
  certificates, DNS, accounts, system trust or expose a public service.
- Stop/quit aborts the pending request. No raw TLS, DNS, address, path or network
  exception is forwarded to the renderer. A remembered receiver winning the
  connection race remains visible and stoppable; failure cleanup does not end it.

The check is made **from the host**, not from the receiving phone. A successful
result does not establish phone VPN access, DNS, browser compatibility, media,
input or end-to-end performance. Host self-access and certificate behavior need
real macOS/Windows/Tailscale qualification before promoting this candidate.
This uses node-specific Serve, not Tailscale Services/VIP, Funnel or a new relay.
Account-free LAN onboarding remains separate work; account-free USB is preserved.

## Verification

Pure fixtures cover exact ownership, bounds, TLS request options, redirects,
schema, name/certificate errors, timeout and cancellation. A disposable loopback
HTTPS fixture verifies real Node TLS rejection of an untrusted certificate and
acceptance with a CA supplied only by its injected test transport; no OS trust
changes occur. Controller fixtures exercise no-invitation failures, USB isolation,
Stop/quit and remembered-connection races. Owned loopback receiver/controller
tests verify preparation has no authentication or native-launch side effect.

`desktop/test/link-check-ui.mjs` drives the built UI and real HostController with
an injected fake backend and probe. It verifies keyboard Cancel while pending,
fixed failure guidance without QR, retry and invitation only after success at
normal/narrow/RTL/CSS200% zoom. These are not real Tailscale, phone, certificate
deployment, capture, permission or physical lifecycle tests. The installed
service remains unmodified and the candidate is not activated.

Primary references: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[Node HTTPS request options](https://nodejs.org/api/https.html#httpsrequesturl-options-callback).
