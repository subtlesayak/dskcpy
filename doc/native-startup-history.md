# Native phone connection history

The retained Android-startup failure trace lost its earlier launch records when
socket retry output filled the controller's 160-line log ring. This candidate
keeps a separate bounded history in **Activity → Phone connection steps**. It
does not establish the cause of the intermittent startup stall or change
connection, socket, retry, capture, Android or input/media protocol behavior.

For native Android USB, Wi-Fi and direct ADB-IP starts, the controller records
one current attempt and at most three earlier automatic retries. An explicit
new start clears the earlier attempts. Browser and direct private-socket starts
do not acquire a phone history. Stop retains the last facts with a stopped
status; it does not restart anything. Histories are memory-only and disappear
when the controller exits.

Native `INFO: Reverse startup:` lines contain only fixed phase IDs. They report
app preparation, launch acknowledgment, first display socket and complete
transport metadata. The controller accepts known IDs only, suppresses duplicate
or backward steps, binds observations to the current child/attempt, and retains
only generated timestamps, phase/status enums and attempt numbers. Raw APK paths,
addresses, scids, names, errors and log lines never enter this separate history.
The ordinary owner log retains its existing behavior and is not a sanitized
export. There is no new viewer message or access permission.

Launch acknowledgment is not proof that the Android service or decoder is ready.
Transport readiness is not proof of readable frames, smooth audio or working
input. Timestamps are controller receipt times, not latency measurements. Only
observed steps are shown. Existing process-exit/output behavior is preserved;
the history cannot recover a line the controller never received. Older hosts
without these phase markers are shown as unreported rather than a fabricated
startup failure or a connection that is still pending. Until the current child
reports its first phase, the history makes no claim about connection progress.
Preflight failure and owner cancellation are separate outcomes.

Regression checks use pure histories and fake children/services. They reproduce
the diagnostic loss with more than 160 retry lines, verify retained initial
facts and a buffered final partial marker, retry isolation/history bounds,
preflight/Stop handling, and absence of arbitrary private strings in the history.
Chromium checks render synthetic Activity states at narrow, RTL and CSS-zoom
sizes with native keyboard disclosure. These are not physical phone tests.

The startup stall remains open. Its next physical investigation needs agreement
before interrupting a stream, a matching certificate-verified companion/native
pair, USB/Wi-Fi/direct-IP runs, and phone service/foreground/permission evidence
captured privately before restoration. A successful retry is not a fix. Share
only sanitized phase histories and artifact hashes in coordination notes.
