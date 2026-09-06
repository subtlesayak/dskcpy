package com.genymobile.scrcpy.reverse;

/** Pixel geometry independent of Android, so narrow windows and cutouts are testable. */
final class ControlBarLayout {
    final int columns;
    final int rows;
    final int width;
    final int height;
    final int contentHeight;
    final int left;
    final int top;
    final int showLeft;
    final int showTop;
    final boolean side;

    ControlBarLayout(int areaWidth, int areaHeight, int surfaceWidth, int surfaceHeight,
            int insetLeft, int insetTop, int insetRight, int insetBottom,
            int button, int gap, int padding, int edge, int count, boolean rtl) {
        int minX = insetLeft + edge;
        int minY = insetTop + edge;
        int maxX = areaWidth - insetRight - edge;
        int maxY = areaHeight - insetBottom - edge;
        int availableWidth = Math.max(1, maxX - minX);
        int availableHeight = Math.max(1, maxY - minY);
        int longSize = count * button + (count - 1) * gap + 2 * padding;
        int shortSize = button + 2 * padding;
        int letterboxX = Math.max(0, (areaWidth - surfaceWidth) / 2);
        int letterboxY = Math.max(0, (areaHeight - surfaceHeight) / 2);
        boolean preferSide = letterboxX >= shortSize || letterboxY < shortSize;
        if (preferSide && availableHeight >= longSize && availableWidth >= shortSize) columns = 1;
        else if (availableWidth >= longSize && availableHeight >= shortSize) columns = count;
        else if (availableHeight >= longSize && availableWidth >= shortSize) columns = 1;
        else {
            int fittingRows = Math.max(1, (availableHeight - 2 * padding + gap) / (button + gap));
            int fittingColumns = Math.max(1, (availableWidth - 2 * padding + gap) / (button + gap));
            columns = Math.min(fittingColumns, (count + fittingRows - 1) / fittingRows);
        }
        rows = (count + columns - 1) / columns;
        width = Math.min(availableWidth, columns * button + (columns - 1) * gap + 2 * padding);
        contentHeight = rows * button + (rows - 1) * gap + 2 * padding;
        height = Math.min(availableHeight, contentHeight);
        side = columns == 1;
        int centerX = side ? (rtl ? letterboxX / 2 : areaWidth - letterboxX / 2) : areaWidth / 2;
        int centerY = side ? areaHeight / 2 : areaHeight - letterboxY / 2;
        left = clamp(centerX - width / 2, minX, maxX - width);
        top = clamp(centerY - height / 2, minY, maxY - height);
        showLeft = clamp(centerX - button / 2, minX, maxX - button);
        showTop = clamp(centerY - button / 2, minY, maxY - button);
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
    }
}
