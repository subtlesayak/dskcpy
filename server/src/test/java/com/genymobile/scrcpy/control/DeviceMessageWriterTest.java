package com.genymobile.scrcpy.control;

import org.junit.Assert;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class DeviceMessageWriterTest {
    @Test public void audioAcknowledgementHasIndependentWireType() throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        new DeviceMessageWriter(output).write(DeviceMessage.createReverseAudioAck(0x0102030405060708L));
        Assert.assertArrayEquals(new byte[] {6,1,2,3,4,5,6,7,8}, output.toByteArray());
    }

    @Test
    public void testSerializeClipboard() throws IOException {
        String text = "aéûoç";
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_CLIPBOARD);
        dos.writeInt(data.length);
        dos.write(data);
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);

        DeviceMessage msg = DeviceMessage.createClipboard(text);
        writer.write(msg);

        byte[] actual = bos.toByteArray();

        Assert.assertArrayEquals(expected, actual);
    }

    @Test
    public void testSerializeAckSetClipboard() throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_ACK_CLIPBOARD);
        dos.writeLong(0x0102030405060708L);
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);

        DeviceMessage msg = DeviceMessage.createAckClipboard(0x0102030405060708L);
        writer.write(msg);

        byte[] actual = bos.toByteArray();

        Assert.assertArrayEquals(expected, actual);
    }

    @Test
    public void testSerializeUhidOutput() throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_UHID_OUTPUT);
        dos.writeShort(42); // id
        byte[] data = {1, 2, 3, 4, 5};
        dos.writeShort(data.length);
        dos.write(data);
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);

        DeviceMessage msg = DeviceMessage.createUhidOutput(42, data);
        writer.write(msg);

        byte[] actual = bos.toByteArray();

        Assert.assertArrayEquals(expected, actual);
    }

    @Test
    public void testSerializeReverseTouch() throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_REVERSE_TOUCH);
        dos.writeByte(2); // ACTION_MOVE
        dos.writeLong(7);
        dos.writeInt(123);
        dos.writeInt(456);
        dos.writeShort(1080);
        dos.writeShort(2400);
        dos.writeShort(0x8000); // pressure 0.5
        dos.writeInt(0);
        dos.writeInt(1); // BUTTON_PRIMARY
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);
        DeviceMessage.ReverseTouchData data = new DeviceMessage.ReverseTouchData();
        data.setAction(2);
        data.setPointerId(7);
        data.setX(123);
        data.setY(456);
        data.setScreenWidth(1080);
        data.setScreenHeight(2400);
        data.setPressure(0.5f);
        data.setButtons(1);
        DeviceMessage msg = DeviceMessage.createReverseTouch(data);
        writer.write(msg);

        byte[] actual = bos.toByteArray();
        Assert.assertArrayEquals(expected, actual);
    }

    @Test
    public void testSerializeReverseFrameAck() throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_REVERSE_FRAME_ACK);
        dos.writeLong(0x0102030405060708L);
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);
        DeviceMessage msg = DeviceMessage.createReverseFrameAck(
                0x0102030405060708L);
        writer.write(msg);

        Assert.assertArrayEquals(expected, bos.toByteArray());
    }

    @Test
    public void testSerializeReverseSystemAction() throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(bos);
        dos.writeByte(DeviceMessage.TYPE_REVERSE_SYSTEM_ACTION);
        dos.writeByte(DeviceMessage.REVERSE_SYSTEM_ACTION_LOCK);
        byte[] expected = bos.toByteArray();

        bos = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(bos);
        DeviceMessage msg = DeviceMessage.createReverseSystemAction(
                DeviceMessage.REVERSE_SYSTEM_ACTION_LOCK);
        writer.write(msg);

        Assert.assertArrayEquals(expected, bos.toByteArray());
    }

    @Test
    public void testSerializeVideoPauseAndResume() throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        DeviceMessageWriter writer = new DeviceMessageWriter(output);
        writer.write(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO));
        writer.write(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO));
        Assert.assertArrayEquals(new byte[] {5, 7, 5, 8}, output.toByteArray());
    }
}
