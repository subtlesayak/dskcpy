# Archived Mac source-bundle update instructions

These instructions describe earlier transferred test bundles. For a current Git
checkout or complete bundle, use the [Mac host setup guide](../../macos-host.md).
They are retained as history, not as current setup or hardware qualification.

## Historical telemetry update: video works but Performance stays on Connecting

The previous Mac host buffered INFO/DEBUG output when launched by the dashboard.
The dashboard therefore received encoder and latency updates late, even though
the video connection was already working. Log records are now flushed
immediately; the waiting message also recognizes an already-started stream.
The wireless connection and pairing implementation are unchanged.

1. Stop streaming, then stop the old Mac dashboard with Control-C in its Terminal.
2. Extract the telemetry-fix source ZIP into a **new folder**, separate from the
   old copy. Open Terminal inside its `dskcpy-macos-source` folder.
3. Rebuild and launch the corrected native host and dashboard:

   ```sh
   bash tools/macos-build.sh
   bash tools/macos-start.sh
   ```

4. Reload the Mac dashboard and start the same wireless connection. Previously
   installed build dependencies and Android pairing can be reused.
5. Open Performance while video is playing. After the first decode acknowledgement,
   it should show **Live**, **Apple VideoToolbox (experimental)** and a latency
   value. Stopping retains the last measurement; a new stream clears it while
   waiting for a fresh acknowledgement. A browser refresh alone cannot update
   the old native binary: the rebuild above is required.

If it still stays on Connecting, share the relevant new Activity lines with
private details removed. The automated test uses synthetic telemetry, not a
measurement of your Mac or network. The displayed Mac latency excludes capture
wait and physical display scan-out.

## Historical update after the thread-name startup crash

If Activity shows `Assertion failed: (strlen(name) <= 15)` in `sc_thread_create`,
wireless pairing is not the cause of that crash. The previous Mac worker name
was 17 bytes; the corrected name is 13 bytes. Keep debug assertions enabled.

1. Stop the old Mac dashboard with Control-C in its Terminal.
2. Extract the corrected source ZIP into a **new folder**, separate from the old
   copy. Do not merge folders or reuse the old compiled binary.
3. Open Terminal in the new extracted folder and run:

   ```sh
   bash tools/macos-build.sh
   bash tools/macos-start.sh
   ```

4. Reload the Mac dashboard and retry the same wireless device. Dependencies
   already installed do not need reinstalling, and Android pairing is unchanged.
   If another error appears, share the new Activity error with private details
   removed. The tester subsequently reported that wireless streaming works;
   the remaining platform checks are still listed below.

