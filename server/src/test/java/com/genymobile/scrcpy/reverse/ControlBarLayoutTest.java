package com.genymobile.scrcpy.reverse;

import org.junit.Test;
import static org.junit.Assert.*;

public class ControlBarLayoutTest {
    private ControlBarLayout layout(int w, int h, int sw, int sh, int left, int top, int right, int bottom, boolean rtl) {
        return new ControlBarLayout(w, h, sw, sh, left, top, right, bottom, 48, 4, 6, 6, 7, rtl);
    }
    private void fits(ControlBarLayout l, int w, int h, int il, int it, int ir, int ib) {
        assertTrue(l.left >= il + 6); assertTrue(l.top >= it + 6);
        assertTrue(l.left + l.width <= w - ir - 6); assertTrue(l.top + l.height <= h - ib - 6);
        assertEquals(l.contentHeight, l.height);
        assertTrue(l.showLeft >= il + 6); assertTrue(l.showTop >= it + 6);
        assertTrue(l.showLeft + 48 <= w - ir - 6); assertTrue(l.showTop + 48 <= h - ib - 6);
    }
    @Test public void normalLandscapeKeepsAllSevenControlsOnSide() {
        ControlBarLayout l = layout(896, 414, 736, 414, 0, 0, 0, 0, false);
        assertTrue(l.side); assertEquals(1, l.columns); fits(l, 896, 414, 0, 0, 0, 0);
    }
    @Test public void shortLandscapeUsesBottomRowInsteadOfClipping() {
        ControlBarLayout l = layout(740, 280, 498, 280, 0, 0, 0, 0, false);
        assertEquals(7, l.columns); fits(l, 740, 280, 0, 0, 0, 0);
    }
    @Test public void smallSquareUsesGridWithoutShrinkingTargets() {
        ControlBarLayout l = layout(320, 320, 320, 180, 0, 0, 0, 0, false);
        assertTrue(l.columns > 1 && l.columns < 7); fits(l, 320, 320, 0, 0, 0, 0);
    }
    @Test public void notchesAndSystemBarsProtectToolbarAndRestoreButton() {
        ControlBarLayout l = layout(896, 414, 736, 414, 36, 24, 44, 24, false);
        fits(l, 896, 414, 36, 24, 44, 24);
    }
    @Test public void rtlSideBarUsesSafeLeadingLetterbox() {
        ControlBarLayout l = layout(896, 414, 736, 414, 24, 0, 0, 0, true);
        assertTrue(l.left < 100); fits(l, 896, 414, 24, 0, 0, 0);
    }
    @Test public void phoneAndSmallWindowMatrixNeverClipsButtons() {
        for (int w : new int[] {240, 280, 320, 360, 414, 600, 896, 1280}) {
            for (int h : new int[] {240, 280, 320, 360, 414, 600, 896}) {
                ControlBarLayout l = layout(w, h, w, h, 12, 24, 12, 24, false);
                fits(l, w, h, 12, 24, 12, 24);
            }
        }
    }
}
