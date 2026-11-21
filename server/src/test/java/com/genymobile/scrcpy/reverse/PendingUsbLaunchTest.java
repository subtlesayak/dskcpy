package com.genymobile.scrcpy.reverse;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class PendingUsbLaunchTest {
    @Test
    public void launchWaitsForBothVisibleActivityAndBoundServiceAndIsConsumedOnce() {
        PendingUsbLaunch pending = new PendingUsbLaunch();
        pending.offer("0012abcd");
        assertNull(pending.takeIfReady(true, false));
        assertNull(pending.takeIfReady(false, true));
        assertEquals("0012abcd", pending.takeIfReady(true, true));
        assertNull(pending.takeIfReady(true, true));
    }

    @Test
    public void ordinaryLaunchAndMalformedExtrasCannotReplacePendingAdbLaunch() {
        PendingUsbLaunch pending = new PendingUsbLaunch();
        pending.offer("0012abcd");
        pending.offer(null);
        pending.offer("too-long0000");
        pending.offer("01234xyz");
        assertEquals("0012abcd", pending.takeIfReady(true, true));
    }

    @Test
    public void newerAdbLaunchSupersedesPendingLaunch() {
        PendingUsbLaunch pending = new PendingUsbLaunch();
        pending.offer("0012abcd");
        pending.offer("0013ABCD");
        assertEquals("0013ABCD", pending.takeIfReady(true, true));
        assertNull(pending.takeIfReady(true, true));
    }
}
