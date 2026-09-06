package com.genymobile.scrcpy.control;

import android.view.MotionEvent;

public final class DeviceMessage {

    public static final int TYPE_CLIPBOARD = 0;
    public static final int TYPE_ACK_CLIPBOARD = 1;
    public static final int TYPE_UHID_OUTPUT = 2;
    public static final int TYPE_REVERSE_TOUCH = 3;
    public static final int TYPE_REVERSE_FRAME_ACK = 4;
    public static final int TYPE_REVERSE_SYSTEM_ACTION = 5;
    public static final int TYPE_REVERSE_AUDIO_ACK = 6;

    public static final int REVERSE_SYSTEM_ACTION_VOLUME_DOWN = 0;
    public static final int REVERSE_SYSTEM_ACTION_VOLUME_UP = 1;
    public static final int REVERSE_SYSTEM_ACTION_VOLUME_MUTE = 2;
    public static final int REVERSE_SYSTEM_ACTION_MINIMIZE = 3;
    public static final int REVERSE_SYSTEM_ACTION_MAXIMIZE_RESTORE = 4;
    public static final int REVERSE_SYSTEM_ACTION_CLOSE = 5;
    public static final int REVERSE_SYSTEM_ACTION_LOCK = 6;
    public static final int REVERSE_SYSTEM_ACTION_PAUSE_VIDEO = 7;
    public static final int REVERSE_SYSTEM_ACTION_RESUME_VIDEO = 8;
    public static final int REVERSE_SYSTEM_ACTION_STOP_SESSION = 9;
    public static final int REVERSE_SYSTEM_ACTION_AUDIO_ENABLE = 10;
    public static final int REVERSE_SYSTEM_ACTION_AUDIO_DISABLE = 11;

    private int type;
    private String text;
    private long sequence;
    private int id;
    private byte[] data;
    private int action;
    private long pointerId;
    private int x;
    private int y;
    private int screenWidth;
    private int screenHeight;
    private float pressure;
    private int actionButton;
    private int buttons;
    private long framePts;
    private int systemAction;

    static final class ReverseTouchData {
        private int action;
        private long pointerId;
        private int x;
        private int y;
        private int screenWidth;
        private int screenHeight;
        private float pressure;
        private int actionButton;
        private int buttons;

        void setAction(int action) {
            this.action = action;
        }

        void setPointerId(long pointerId) {
            this.pointerId = pointerId;
        }

        void setX(int x) {
            this.x = x;
        }

        void setY(int y) {
            this.y = y;
        }

        void setScreenWidth(int screenWidth) {
            this.screenWidth = screenWidth;
        }

        void setScreenHeight(int screenHeight) {
            this.screenHeight = screenHeight;
        }

        void setPressure(float pressure) {
            this.pressure = pressure;
        }

        void setActionButton(int actionButton) {
            this.actionButton = actionButton;
        }

        void setButtons(int buttons) {
            this.buttons = buttons;
        }
    }

    private DeviceMessage() {
    }

    public static DeviceMessage createClipboard(String text) {
        DeviceMessage event = new DeviceMessage();
        event.type = TYPE_CLIPBOARD;
        event.text = text;
        return event;
    }

    public static DeviceMessage createAckClipboard(long sequence) {
        DeviceMessage event = new DeviceMessage();
        event.type = TYPE_ACK_CLIPBOARD;
        event.sequence = sequence;
        return event;
    }

    public static DeviceMessage createUhidOutput(int id, byte[] data) {
        DeviceMessage event = new DeviceMessage();
        event.type = TYPE_UHID_OUTPUT;
        event.id = id;
        event.data = data;
        return event;
    }

    public static DeviceMessage createReverseTouch(MotionEvent motionEvent, int pointerIndex,
            int action, int screenWidth, int screenHeight) {
        ReverseTouchData data = new ReverseTouchData();
        data.setAction(action);
        data.setPointerId(motionEvent.getPointerId(pointerIndex));
        data.setX(Math.round(motionEvent.getX(pointerIndex)));
        data.setY(Math.round(motionEvent.getY(pointerIndex)));
        data.setScreenWidth(screenWidth);
        data.setScreenHeight(screenHeight);
        data.setPressure(motionEvent.getPressure(pointerIndex));
        // ACTION_BUTTON is not available before Android 6 and is not needed
        // for the touch-only reverse-display path.
        data.setActionButton(0);
        data.setButtons(motionEvent.getButtonState());
        return createReverseTouch(data);
    }

    static DeviceMessage createReverseTouch(ReverseTouchData data) {
        DeviceMessage message = new DeviceMessage();
        message.type = TYPE_REVERSE_TOUCH;
        message.action = data.action;
        message.pointerId = data.pointerId;
        message.x = data.x;
        message.y = data.y;
        message.screenWidth = data.screenWidth;
        message.screenHeight = data.screenHeight;
        message.pressure = data.pressure;
        message.actionButton = data.actionButton;
        message.buttons = data.buttons;
        return message;
    }

    public static DeviceMessage createReverseFrameAck(long framePts) {
        DeviceMessage message = new DeviceMessage();
        message.type = TYPE_REVERSE_FRAME_ACK;
        message.framePts = framePts;
        return message;
    }

    public static DeviceMessage createReverseAudioAck(long pts) {
        DeviceMessage message = createReverseFrameAck(pts);
        message.type = TYPE_REVERSE_AUDIO_ACK;
        return message;
    }

    public static DeviceMessage createReverseSystemAction(int systemAction) {
        DeviceMessage message = new DeviceMessage();
        message.type = TYPE_REVERSE_SYSTEM_ACTION;
        message.systemAction = systemAction;
        return message;
    }

    public int getType() {
        return type;
    }

    public String getText() {
        return text;
    }

    public long getSequence() {
        return sequence;
    }

    public int getId() {
        return id;
    }

    public byte[] getData() {
        return data;
    }

    public int getAction() {
        return action;
    }

    public long getPointerId() {
        return pointerId;
    }

    public int getX() {
        return x;
    }

    public int getY() {
        return y;
    }

    public int getScreenWidth() {
        return screenWidth;
    }

    public int getScreenHeight() {
        return screenHeight;
    }

    public float getPressure() {
        return pressure;
    }

    public int getActionButton() {
        return actionButton;
    }

    public int getButtons() {
        return buttons;
    }

    public long getFramePts() {
        return framePts;
    }

    public int getSystemAction() {
        return systemAction;
    }
}
