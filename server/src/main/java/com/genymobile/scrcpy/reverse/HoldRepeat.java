package com.genymobile.scrcpy.reverse;

/** Single UI-thread repeat policy; release/cancel always invalidates pending work. */
final class HoldRepeat {
    interface Scheduler {
        void post(Runnable callback, long delayMillis);
        void remove(Runnable callback);
    }
    static final long INITIAL_DELAY_MS = 450;
    static final long INTERVAL_MS = 100;
    private final Scheduler scheduler;
    private final Runnable action;
    private final Runnable onHoldStart;
    private boolean held;
    private boolean repeated;
    private final Runnable tick = this::repeat;

    HoldRepeat(Scheduler scheduler, Runnable action) {
        this(scheduler, action, () -> { });
    }
    HoldRepeat(Scheduler scheduler, Runnable action, Runnable onHoldStart) {
        this.scheduler = scheduler;
        this.action = action;
        this.onHoldStart = onHoldStart;
    }
    void press() {
        cancel();
        held = true;
        repeated = false;
        scheduler.post(tick, INITIAL_DELAY_MS);
    }
    private void repeat() {
        if (!held) return;
        if (!repeated) {
            repeated = true;
            onHoldStart.run();
        }
        if (!held) return;
        action.run();
        if (held) scheduler.post(tick, INTERVAL_MS);
    }
    /** True means a normal short click should be dispatched by the native button. */
    boolean release() {
        boolean click = held && !repeated;
        cancel();
        return click;
    }
    void cancel() {
        held = false;
        scheduler.remove(tick);
    }
}
