package com.genymobile.scrcpy.control;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import static org.junit.Assert.*;

public class DeviceMessageSenderSessionTest {
    @Test public void audioAndVideoAcknowledgementsCannotReplaceEachOther() throws Exception {
        DeviceMessageSender sender = sender();
        sender.send(DeviceMessage.createReverseFrameAck(1));
        sender.send(DeviceMessage.createReverseAudioAck(10));
        sender.send(DeviceMessage.createReverseAudioAck(20));
        assertEquals(DeviceMessage.TYPE_REVERSE_AUDIO_ACK, take(sender).getType());
        assertEquals(DeviceMessage.TYPE_REVERSE_FRAME_ACK, take(sender).getType());
    }
    @Test public void newestAudioToggleSurvivesAFullQueue() throws Exception {
        DeviceMessageSender sender = sender();
        for (int i = 0; i < 32; i++) action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_VOLUME_DOWN);
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_ENABLE);
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE);
        for (int i = 0; i < 32; i++) take(sender);
        assertEquals(DeviceMessage.REVERSE_SYSTEM_ACTION_AUDIO_DISABLE, take(sender).getSystemAction());
    }
    private DeviceMessageSender sender() {
        return new DeviceMessageSender(new ControlChannel(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream()));
    }
    private DeviceMessage take(DeviceMessageSender sender) throws Exception {
        Method method = DeviceMessageSender.class.getDeclaredMethod("take");
        method.setAccessible(true);
        return (DeviceMessage) method.invoke(sender);
    }
    private void action(DeviceMessageSender sender, int action) { sender.send(DeviceMessage.createReverseSystemAction(action)); }

    @Test public void pauseCannotBeDroppedByFullQueue() throws Exception {
        DeviceMessageSender sender = sender();
        for (int i = 0; i < 32; i++) action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_VOLUME_DOWN);
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);
        assertEquals(DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO, take(sender).getSystemAction());
    }
    @Test public void quickReturnStillCancelsHeldContactsBeforeResuming() throws Exception {
        DeviceMessageSender sender = sender();
        DeviceMessage.ReverseTouchData touch = new DeviceMessage.ReverseTouchData();
        touch.setAction(0);
        sender.send(DeviceMessage.createReverseTouch(touch));
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO);
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO);
        assertEquals(DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO, take(sender).getSystemAction());
        assertEquals(DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO, take(sender).getSystemAction());
    }
    @Test public void explicitStopCannotBeSupersededByLateVisibilityEvents() throws Exception {
        DeviceMessageSender sender = sender();
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_STOP_SESSION);
        action(sender, DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO);
        assertEquals(DeviceMessage.REVERSE_SYSTEM_ACTION_STOP_SESSION, take(sender).getSystemAction());
    }
}
