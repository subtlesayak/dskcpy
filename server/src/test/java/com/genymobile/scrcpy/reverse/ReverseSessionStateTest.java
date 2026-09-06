package com.genymobile.scrcpy.reverse;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReverseSessionStateTest {
    @Test public void waitingSessionSurvivesLeavingAndReturning() {
        ReverseSessionState state = new ReverseSessionState();
        state.setVisible(true);
        long token = state.begin();
        state.setVisible(false);
        assertTrue(state.isCurrent(token));
        assertEquals(ReverseSessionState.Phase.WAITING, state.phase());
        state.setVisible(true);
        assertTrue(state.isCurrent(token));
    }

    @Test public void desktopMayConnectWhilePhoneIsAway() {
        ReverseSessionState state = new ReverseSessionState();
        long token = state.begin();
        assertTrue(state.connected(token));
        assertFalse(state.isVisible());
        state.setVisible(true);
        assertEquals(ReverseSessionState.Phase.CONNECTED, state.phase());
        assertTrue(state.isCurrent(token));
    }

    @Test public void stoppedSessionCannotBeRevivedByLateCallbacks() {
        ReverseSessionState state = new ReverseSessionState();
        long token = state.begin();
        state.stop();
        state.setVisible(true);
        assertFalse(state.isActive());
        assertFalse(state.connected(token));
        assertFalse(state.isCurrent(token));
    }

    @Test public void replacementRejectsOldConnectionAndFailureCallbacks() {
        ReverseSessionState state = new ReverseSessionState();
        long old = state.begin();
        state.stop();
        long current = state.begin();
        assertNotEquals(old, current);
        assertFalse(state.isCurrent(old));
        assertFalse(state.connected(old));
        assertTrue(state.connected(current));
    }

    @Test public void repeatedBackgroundCyclesKeepConnectedSession() {
        ReverseSessionState state = new ReverseSessionState();
        long token = state.begin();
        state.connected(token);
        for (int i = 0; i < 20; i++) {
            state.setVisible(false);
            assertTrue(state.isCurrent(token));
            state.setVisible(true);
            assertEquals(ReverseSessionState.Phase.CONNECTED, state.phase());
        }
    }
}
