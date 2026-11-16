# Owned service setup and Quit

The desktop app serializes the entire setup operation: waiting for any earlier
setup, checking an existing child, retiring an idle child and starting its
replacement. A waiter checks again after its predecessor completes, so two
concurrent calls cannot both create a replacement. Quit marks the backend closed
before waiting for setup, and pending setup checks that veto before any fork.
Repeated Quit requests share one shutdown promise.

Only child handles created by this app are retired. There is no process-name or
port discovery, existing-controller takeover or kill of another app's service.
The existing status check still refuses connection changes for a running,
waiting or connected owned session. This change does not add an automatic
restart or alter consent, routes, OS permissions or the stream protocol.

Two deterministic regressions reproduce the original races against the actual
OwnedBackend with asynchronous child exit:

- Concurrent idle reconfiguration creates three children (initial plus two
  replacements), where only two are allowed.
- Quit during reconfiguration creates a second child after shutdown, where only
  the original child is allowed.

The corrected tests require those counts to be two and one, no remaining handle,
and one retirement for repeated Quit. The full Node suite passes 459 of 466 tests
with seven optional skips, and both UI builds pass on the merged-master baseline.

The hidden Electron check additionally runs the actual class through real
utility-process IPC with fixed fake workers. It verifies the same two creation
counts and waits for every test-owned worker to exit. Electron documents
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
