package com.genymobile.scrcpy.reverse;

/** A launch waiting for both the foreground Activity and its bound service. Main thread only. */
final class PendingUsbLaunch {
    private String scid;

    void offer(String candidate) {
        if (candidate != null && candidate.matches("[0-9a-fA-F]{8}")) {
            scid = candidate;
        }
    }

    String takeIfReady(boolean visible, boolean serviceBound) {
        if (!visible || !serviceBound) {
            return null;
        }
        String start = scid;
        scid = null;
        return start;
    }
}
