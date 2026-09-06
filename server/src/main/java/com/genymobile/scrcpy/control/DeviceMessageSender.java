package com.genymobile.scrcpy.control;

import com.genymobile.scrcpy.util.Ln;

import android.view.MotionEvent;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Iterator;

public final class DeviceMessageSender {

    private static final int QUEUE_CAPACITY = 32;

    private final ControlChannel controlChannel;
    private final ArrayDeque<DeviceMessage> queue = new ArrayDeque<>(QUEUE_CAPACITY);

    private Thread thread;
    private boolean stopped;

    public DeviceMessageSender(ControlChannel controlChannel) {
        this.controlChannel = controlChannel;
    }

    public void send(DeviceMessage msg) {
        synchronized (queue) {
            if (stopped) {
                return;
            }

            if (isSessionAction(msg)) {
                // Lifecycle changes must survive a full touch queue. Drop stale input
                // and coalesce visibility, retaining PAUSE before RESUME so contacts
                // are released even during a rapid Home-return cycle.
                DeviceMessage pause = null;
                Iterator<DeviceMessage> pending = queue.iterator();
                while (pending.hasNext()) {
                    DeviceMessage item = pending.next();
                    if (isSessionAction(item)) {
                        if (item.getSystemAction() == DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO) pause = item;
                        if (item.getSystemAction() == DeviceMessage.REVERSE_SYSTEM_ACTION_STOP_SESSION) return;
                        pending.remove();
                    } else if (item.getType() == DeviceMessage.TYPE_REVERSE_TOUCH) pending.remove();
                }
                queue.addFirst(msg);
                if (pause != null && msg.getSystemAction() == DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO) queue.addFirst(pause);
                queue.notifyAll();
                return;
            }

            if (msg.getType() == DeviceMessage.TYPE_REVERSE_FRAME_ACK
                    || msg.getType() == DeviceMessage.TYPE_REVERSE_AUDIO_ACK) {
                // Frame acknowledgements are cumulative. Keep only the newest
                // pending one so video flow control never delays touch input.
                Iterator<DeviceMessage> iterator = queue.iterator();
                while (iterator.hasNext()) {
                    if (iterator.next().getType()
                            == msg.getType()) {
                        iterator.remove();
                    }
                }
                // The acknowledgement is only nine bytes and immediately
                // unblocks the next captured frame. Put it ahead of any touch
                // burst; this avoids video stalls while a finger is moving.
                queue.addFirst(msg);
                queue.notifyAll();
                return;
            }

            if (isAudioToggle(msg)) {
                // Preserve only the newest desired audio state, independently
                // of video pause/stop ordering, and never drop a mute request.
                Iterator<DeviceMessage> audioIterator = queue.iterator();
                while (audioIterator.hasNext()) if (isAudioToggle(audioIterator.next())) audioIterator.remove();
                queue.addLast(msg);
                queue.notifyAll();
                return;
            }

            if (isMotionMove(msg)) {
                // Only the latest unsent location for a pointer is useful.
                // Coalescing avoids replaying an old gesture trail after the
                // user's finger has already moved on.
                Iterator<DeviceMessage> iterator = queue.iterator();
                while (iterator.hasNext()) {
                    DeviceMessage pending = iterator.next();
                    if (isMotionMove(pending)
                            && pending.getPointerId() == msg.getPointerId()) {
                        iterator.remove();
                    }
                }
            }

            if (queue.size() >= QUEUE_CAPACITY) {
                // Preserve DOWN/UP/CANCEL whenever possible by evicting the
                // oldest pending MOVE event first.
                boolean evicted = false;
                Iterator<DeviceMessage> iterator = queue.iterator();
                while (iterator.hasNext()) {
                    if (isMotionMove(iterator.next())) {
                        iterator.remove();
                        evicted = true;
                        break;
                    }
                }
                if (!evicted) {
                    Ln.w("Device message dropped: " + msg.getType());
                    return;
                }
            }
            queue.addLast(msg);
            queue.notifyAll();
        }
    }

    private static boolean isMotionMove(DeviceMessage msg) {
        return msg.getType() == DeviceMessage.TYPE_REVERSE_TOUCH
                && msg.getAction() == MotionEvent.ACTION_MOVE;
    }

    private static boolean isSessionAction(DeviceMessage msg) {
        if (msg.getType() != DeviceMessage.TYPE_REVERSE_SYSTEM_ACTION) return false;
        int action = msg.getSystemAction();
        return action == DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO
                || action == DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO
                || action == DeviceMessage.REVERSE_SYSTEM_ACTION_STOP_SESSION;
    }

    private static boolean isAudioToggle(DeviceMessage msg) {
        return msg.getType() == DeviceMessage.TYPE_REVERSE_SYSTEM_ACTION
                && (msg.getSystemAction() == DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_ENABLE
                || msg.getSystemAction() == DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);
    }

    private DeviceMessage take() throws InterruptedException {
        synchronized (queue) {
            while (queue.isEmpty() && !stopped) {
                queue.wait();
            }
            return stopped ? null : queue.removeFirst();
        }
    }

    private void loop() throws IOException, InterruptedException {
        for (;;) {
            DeviceMessage msg = take();
            if (msg == null) {
                return;
            }
            controlChannel.send(msg);
        }
    }

    public void start() {
        synchronized (queue) {
            stopped = false;
        }
        thread = new Thread(() -> {
            try {
                loop();
            } catch (IOException | InterruptedException e) {
                // this is expected on close
            } finally {
                Ln.d("Device message sender stopped");
            }
        }, "control-send");
        thread.start();
    }

    public void stop() {
        synchronized (queue) {
            stopped = true;
            queue.clear();
            queue.notifyAll();
        }
        if (thread != null) {
            thread.interrupt();
        }
    }

    public void join() throws InterruptedException {
        if (thread != null) {
            thread.join();
        }
    }
}
