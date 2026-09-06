package com.genymobile.scrcpy.reverse;

import com.genymobile.scrcpy.FakeContext;
import com.genymobile.scrcpy.control.DeviceMessage;
import com.genymobile.scrcpy.control.DeviceMessageSender;
import com.genymobile.scrcpy.util.Ln;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.PixelFormat;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;

/**
 * Full-screen surface used by reverse-display mode.
 *
 * <p>The scrcpy server is started by app_process rather than installed as a
 * normal application. On devices where the shell UID is not allowed to create
 * this window, addView() fails and the mode reports a clear error to the host.
 */
@SuppressLint("ClickableViewAccessibility")
@SuppressWarnings("deprecation")
public final class ReverseDisplayWindow implements SurfaceHolder.Callback {

    private final DeviceMessageSender sender;
    private final SurfaceListener surfaceListener;
    private final WindowManager windowManager;
    private final SurfaceView surfaceView;

    private boolean attached;

    public interface SurfaceListener {
        void onSurfaceCreated(Surface surface);

        void onSurfaceDestroyed(Surface surface);
    }

    public ReverseDisplayWindow(DeviceMessageSender sender, SurfaceListener surfaceListener) {
        this.sender = sender;
        this.surfaceListener = surfaceListener;
        windowManager = (WindowManager) FakeContext.get().getSystemService(Context.WINDOW_SERVICE);
        if (windowManager == null) {
            throw new IllegalStateException("Window manager is unavailable");
        }

        surfaceView = new SurfaceView(FakeContext.get());
        surfaceView.getHolder().addCallback(this);
        surfaceView.setFocusable(false);
        surfaceView.setOnTouchListener(this::onTouch);
        surfaceView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    public void show() {
        if (attached) {
            return;
        }

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;
        int flags = WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                flags,
                PixelFormat.OPAQUE);
        params.gravity = Gravity.TOP | Gravity.START;
        params.setTitle("scrcpy reverse display");

        try {
            windowManager.addView(surfaceView, params);
            attached = true;
        } catch (RuntimeException e) {
            Ln.e("Could not create the Android reverse-display window. "
                    + "The shell UID may not be allowed to create overlays.", e);
            throw e;
        }
    }

    public void close() {
        if (!attached) {
            return;
        }
        try {
            windowManager.removeViewImmediate(surfaceView);
        } catch (RuntimeException e) {
            Ln.w("Could not remove the reverse-display window", e);
        } finally {
            attached = false;
        }
    }

    private boolean onTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        int firstPointer;
        int lastPointer;
        int actionIndex = event.getActionIndex();
        if (action == MotionEvent.ACTION_MOVE) {
            firstPointer = 0;
            lastPointer = event.getPointerCount();
        } else if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_UP) {
            firstPointer = actionIndex;
            lastPointer = actionIndex + 1;
        } else if (action == MotionEvent.ACTION_POINTER_DOWN
                || action == MotionEvent.ACTION_POINTER_UP) {
            // InjectTouchInput requires every active contact in the frame.
            // Send the unchanged contacts as MOVE messages, then the changed
            // contact as DOWN/UP so the host can build a complete frame.
            firstPointer = 0;
            lastPointer = event.getPointerCount();
        } else if (action == MotionEvent.ACTION_CANCEL) {
            firstPointer = 0;
            lastPointer = Math.min(1, event.getPointerCount());
        } else {
            return true;
        }

        int width = Math.max(1, view.getWidth());
        int height = Math.max(1, view.getHeight());

        for (int i = firstPointer; i < lastPointer; ++i) {
            int pointerAction = action;
            if ((action == MotionEvent.ACTION_POINTER_DOWN
                    || action == MotionEvent.ACTION_POINTER_UP)
                    && i != actionIndex) {
                pointerAction = MotionEvent.ACTION_MOVE;
            }

            DeviceMessage msg = DeviceMessage.createReverseTouch(event, i, pointerAction,
                    width, height);
            sender.send(msg);
        }

        return true;
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceListener.onSurfaceCreated(holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        // The decoder renders to the same surface; the window is stretched to
        // the physical display for predictable touch coordinates.
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceListener.onSurfaceDestroyed(holder.getSurface());
    }
}
