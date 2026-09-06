package com.genymobile.scrcpy.reverse;

/** Positions an extra control tray beside/above the main rail, never offscreen. */
final class ControlTrayLayout {
    final int columns, rows, width, height, contentHeight, left, top;
    final boolean replacesMain;

    ControlTrayLayout(ControlBarLayout main, int areaWidth, int areaHeight,
            int insetLeft, int insetTop, int insetRight, int insetBottom,
            int button, int gap, int padding, int edge, int count, boolean rtl) {
        int minX = insetLeft + edge, minY = insetTop + edge;
        int maxX = areaWidth - insetRight - edge, maxY = areaHeight - insetBottom - edge;
        // A side rail expands sideways; a bottom bar expands upwards. If a tiny
        // window cannot fit both, replace the main palette with a Back control.
        ControlBarLayout palette = new ControlBarLayout(areaWidth, areaHeight,
                areaWidth, main.side ? areaHeight : 0,
                insetLeft, insetTop, insetRight, insetBottom,
                button, gap, padding, edge, count, rtl);
        columns = palette.columns; rows = palette.rows;
        width = palette.width; height = palette.height; contentHeight = palette.contentHeight;
        int x = main.side ? (rtl ? main.left + main.width + gap : main.left - width - gap)
                : main.left + (main.width - width) / 2;
        int y = main.side ? main.top + main.height - height : main.top - height - gap;
        boolean adjacent = x >= minX && y >= minY && x + width <= maxX && y + height <= maxY;
        replacesMain = !adjacent;
        left = adjacent ? x : palette.left;
        top = adjacent ? y : palette.top;
    }
}
