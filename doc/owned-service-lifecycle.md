# Owned service setup and Quit

The desktop app serializes the entire setup operation: waiting for any earlier
setup, checking an existing child, retiring an idle child and starting its
replacement. A waiter checks again after its predecessor completes, so two
concurrent calls cannot both create a replacement. Quit marks the backend closed
before waiting for setup, and pending setup checks that veto before any fork.
Repeated Quit requests share one shutdown promise.

Only child handles created by this app are retired. There is no process-name or
port discovery, existing-controller takeover or kill of another app's service.
The parent status check still refuses connection changes for a running,
waiting or connected owned session. Before an idle reconfiguration retires the
child, the service now checks its current state again. The idle check and
shutdown admission veto run without an intervening await. An incoming receiver,
native startup, queued reconnection or stopping cleanup therefore prevents
retirement even if the parent's earlier idle snapshot is stale. A refused or
uncertain reply preserves the child; explicit Quit still uses normal shutdown.
This private IPC action adds no HTTP endpoint. This change does not add an automatic
restart or alter consent, routes, OS permissions or the stream protocol.

Two deterministic regressions reproduce the original races against the actual
OwnedBackend with asynchronous child exit:

- Concurrent idle reconfiguration creates three children (initial plus two
  replacements), where only two are allowed.
- Quit during reconfiguration creates a second child after shutdown, where only
  the original child is allowed.

An additional regression reproduces a session arriving after the idle snapshot:
the original path retires its owner; the service-side veto now preserves it.
Service tests also cover waiting invitations, active native cleanup and startup
before a child exists. An uncertain retirement reply must preserve the child.

The corrected tests require counts two and one for the first races, one retained
owner for incoming activity, no handle after explicit Quit, and one retirement
for repeated Quit. The full Node suite passes 464 of 471 tests
with seven optional skips, and both UI builds pass on the merged-master baseline.

The hidden Electron check additionally runs the actual class through real
utility-process IPC with fixed fake workers. It verifies creation counts two,
one and one and waits for every test-owned worker to exit. The normal real service
entry also completes the idle-retirement IPC with a fake native host. Electron documents
[utility-process termination and exit](https://www.electronjs.org/docs/latest/api/utility-process)
separately; a synchronous fake exit had hidden these races. The normal hidden
preload/service check remains in place with a fake `--help`-only native program.
No real screen capture, invitation, device enrollment, desktop input or permission
API is exercised. This source-resources check is not an assembled package check.

These reproductions establish source lifecycle defects. They do not establish
the cause of every historical setup hiccup or the old Android display-socket
startup failure. That Android failure, a final packaged cross-platform check and
physical startup/Quit/upgrade qualification remain separate gates. The installed
Mac app and pending landscape-typing candidate are unchanged by this work.
