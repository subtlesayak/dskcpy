package com.genymobile.scrcpy.reverse;

import android.content.Context;
import android.view.KeyEvent;
import android.view.MotionEvent;
import com.google.android.material.button.MaterialButton;

/** A native accessible click plus bounded long-press repeat for volume only. */
final class RepeatMaterialButton extends MaterialButton {
    private final HoldRepeat repeat = new HoldRepeat(new HoldRepeat.Scheduler() {
        @Override public void post(Runnable callback, long delay) { postDelayed(callback, delay); }
        @Override public void remove(Runnable callback) { removeCallbacks(callback); }
    }, () -> { if (isEnabled() && isShown() && hasWindowFocus()) performClick(); else cancelRepeat(); }, this::showHoldHint);
    private boolean pointerActive;
    private Runnable holdHint;

    RepeatMaterialButton(Context context) { super(context); }
    void setHoldHint(Runnable hint) { holdHint = hint; }
    private void showHoldHint() {
        if (holdHint != null && isEnabled() && isShown() && hasWindowFocus()) holdHint.run();
    }
    @Override public boolean performClick() { return super.performClick(); }
    void cancelRepeat() {
        repeat.cancel();
        pointerActive = false;
        setPressed(false);
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (!isEnabled()) { cancelRepeat(); return super.onTouchEvent(event); }
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                pointerActive = true;
                repeat.press();
                break;
            case MotionEvent.ACTION_MOVE:
                if (event.getX() < 0 || event.getY() < 0 || event.getX() >= getWidth() || event.getY() >= getHeight()) {
                    cancelRepeat();
                }
                break;
            case MotionEvent.ACTION_UP:
                boolean click = pointerActive && repeat.release();
                pointerActive = false;
                if (!click) {
                    cancelRepeat();
                    MotionEvent cancel = MotionEvent.obtain(event);
                    cancel.setAction(MotionEvent.ACTION_CANCEL);
                    super.onTouchEvent(cancel);
                    cancel.recycle();
                    return true;
                }
                break;
            case MotionEvent.ACTION_CANCEL:
            case MotionEvent.ACTION_POINTER_DOWN:
                cancelRepeat();
                break;
            default:
                break;
        }
        return super.onTouchEvent(event);
    }
    private boolean activateKey(int key) {
        return key == KeyEvent.KEYCODE_ENTER || key == KeyEvent.KEYCODE_DPAD_CENTER || key == KeyEvent.KEYCODE_SPACE;
    }
    @Override public boolean onKeyDown(int key, KeyEvent event) {
        if (activateKey(key) && isEnabled()) {
            if (event.getRepeatCount() == 0) { setPressed(true); repeat.press(); }
            return true;
        }
        return super.onKeyDown(key, event);
    }
    @Override public boolean onKeyUp(int key, KeyEvent event) {
        if (activateKey(key)) {
            boolean click = repeat.release();
            setPressed(false);
            if (click && !event.isCanceled() && isEnabled()) performClick();
            return true;
        }
        return super.onKeyUp(key, event);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        if (!focused) cancelRepeat();
        super.onWindowFocusChanged(focused);
    }
    @Override protected void onDetachedFromWindow() { cancelRepeat(); super.onDetachedFromWindow(); }
    @Override public void setEnabled(boolean enabled) {
        if (!enabled && repeat != null) cancelRepeat();
        super.setEnabled(enabled);
    }
}
