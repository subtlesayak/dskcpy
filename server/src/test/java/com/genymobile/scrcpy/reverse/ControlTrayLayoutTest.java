package com.genymobile.scrcpy.reverse;

import org.junit.Test;
import static org.junit.Assert.*;

public class ControlTrayLayoutTest {
    private ControlBarLayout main(int w, int h, boolean rtl) {
        return new ControlBarLayout(w, h, w * 3 / 4, h, 12, 24, 12, 24, 48, 4, 6, 6, 7, rtl);
    }
    private ControlTrayLayout tray(ControlBarLayout main, int w, int h, boolean rtl) {
        return new ControlTrayLayout(main, w, h, 12, 24, 12, 24, 48, 4, 6, 6, 6, rtl);
    }
    @Test public void landscapeOpensBesideTheRail() {
        ControlBarLayout main = main(896, 500, false);
        ControlTrayLayout tray = tray(main, 896, 500, false);
        assertFalse(tray.replacesMain); assertTrue(tray.left + tray.width < main.left);
    }
    @Test public void shortLandscapeSlidesAboveTheBottomBar() {
        ControlBarLayout main = main(740, 280, false);
        ControlTrayLayout tray = tray(main, 740, 280, false);
        assertFalse(tray.replacesMain); assertTrue(tray.top + tray.height < main.top);
    }
    @Test public void tinyWindowReplacesInsteadOfCoveringControls() {
        assertTrue(tray(main(240, 240, false), 240, 240, false).replacesMain);
    }
    @Test public void rtlRailExpandsInward() {
        ControlBarLayout main = main(896, 500, true);
        ControlTrayLayout tray = tray(main, 896, 500, true);
        assertFalse(tray.replacesMain); assertTrue(tray.left > main.left + main.width);
    }
    @Test public void allButtonsFitAcrossTheWindowMatrix() {
        for (int w : new int[] {240, 280, 320, 360, 414, 600, 896, 1280}) {
            for (int h : new int[] {240, 280, 320, 360, 414, 600, 896}) {
                for (boolean rtl : new boolean[] {false, true}) {
                    ControlBarLayout main = main(w, h, rtl);
                    ControlTrayLayout t = tray(main, w, h, rtl);
                    assertEquals(t.contentHeight, t.height);
                    assertTrue(t.left >= 18 && t.top >= 30);
                    assertTrue(t.left + t.width <= w - 18 && t.top + t.height <= h - 30);
                    if (!t.replacesMain) assertTrue(t.left + t.width <= main.left || main.left + main.width <= t.left
                            || t.top + t.height <= main.top || main.top + main.height <= t.top);
                }
            }
        }
    }
}
