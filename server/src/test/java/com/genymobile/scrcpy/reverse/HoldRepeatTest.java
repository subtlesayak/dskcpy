package com.genymobile.scrcpy.reverse;

import org.junit.Test;
import static org.junit.Assert.*;

public class HoldRepeatTest {
    private static final class Clock implements HoldRepeat.Scheduler {
        Runnable pending;
        long delay;
        @Override public void post(Runnable action, long millis) { pending = action; delay = millis; }
        @Override public void remove(Runnable action) { if (pending == action) pending = null; }
        void fire() { Runnable action = pending; pending = null; if (action != null) action.run(); }
    }
    @Test public void shortPressClicksOnceOnRelease() {
        Clock clock = new Clock(); int[] calls = {0};
        HoldRepeat repeat = new HoldRepeat(clock, () -> calls[0]++);
        repeat.press(); assertEquals(450, clock.delay);
        assertTrue(repeat.release()); clock.fire();
        assertEquals(0, calls[0]); assertFalse(repeat.release());
    }
    @Test public void longPressRepeatsWithoutExtraReleaseClick() {
        Clock clock = new Clock(); int[] calls = {0};
        HoldRepeat repeat = new HoldRepeat(clock, () -> calls[0]++);
        repeat.press(); clock.fire(); assertEquals(100, clock.delay); clock.fire();
        assertEquals(2, calls[0]); assertFalse(repeat.release()); clock.fire();
        assertEquals(2, calls[0]);
    }
    @Test public void cancelStopsStaleCallbacksAndReentryStartsFresh() {
        Clock clock = new Clock(); int[] calls = {0};
        HoldRepeat repeat = new HoldRepeat(clock, () -> calls[0]++);
        repeat.press(); Runnable stale = clock.pending; repeat.cancel(); stale.run();
        assertEquals(0, calls[0]); assertFalse(repeat.release());
        repeat.press(); clock.fire(); repeat.cancel(); clock.fire(); assertEquals(1, calls[0]);
    }
    @Test public void explanationAppearsOncePerHoldNotOncePerRepeat() {
        Clock clock = new Clock(); int[] calls = {0}, hints = {0};
        HoldRepeat repeat = new HoldRepeat(clock, () -> calls[0]++, () -> hints[0]++);
        repeat.press(); clock.fire(); clock.fire(); clock.fire();
        assertEquals(3, calls[0]); assertEquals(1, hints[0]);
        repeat.release(); repeat.press(); clock.fire();
        assertEquals(4, calls[0]); assertEquals(2, hints[0]);
    }
    @Test public void shortOrCancelledPressDoesNotExplainOrRepeat() {
        Clock clock = new Clock(); int[] calls = {0}, hints = {0};
        HoldRepeat repeat = new HoldRepeat(clock, () -> calls[0]++, () -> hints[0]++);
        repeat.press(); repeat.release(); clock.fire();
        repeat.press(); Runnable stale = clock.pending; repeat.cancel(); stale.run();
        assertEquals(0, calls[0]); assertEquals(0, hints[0]);
    }
    @Test public void cancellingFromHoldFeedbackPreventsTheAction() {
        Clock clock = new Clock(); int[] calls = {0}; HoldRepeat[] holder = {null};
        holder[0] = new HoldRepeat(clock, () -> calls[0]++, () -> holder[0].cancel());
        holder[0].press(); clock.fire();
        assertEquals(0, calls[0]); assertNull(clock.pending);
    }
}
