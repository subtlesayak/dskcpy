package com.genymobile.scrcpy.reverse;

/** In-memory session ownership; leaving a screen must not invalidate a session. */
final class ReverseSessionState {
    enum Phase { IDLE, WAITING, CONNECTED }
    private long generation;
    private Phase phase = Phase.IDLE;
    private boolean visible;

    synchronized long begin() { phase = Phase.WAITING; return ++generation; }
    synchronized boolean isCurrent(long token) { return token == generation && phase != Phase.IDLE; }
    synchronized boolean connected(long token) {
        if (!isCurrent(token)) return false;
        phase = Phase.CONNECTED;
        return true;
    }
    synchronized void stop() { ++generation; phase = Phase.IDLE; }
    synchronized void setVisible(boolean value) { visible = value; }
    synchronized boolean isVisible() { return visible; }
    synchronized boolean isActive() { return phase != Phase.IDLE; }
    synchronized Phase phase() { return phase; }
}
