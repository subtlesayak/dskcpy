package com.genymobile.scrcpy.reverse;

import org.junit.Test;

import java.io.DataInputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Arrays;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class InternetSessionTest {
    private static byte[] key() {
        byte[] result = new byte[16];
        for (int i = 0; i < result.length; i++) result[i] = (byte) (i * 17);
        return result;
    }

    @Test
    public void matchesDesktopProofVectorAndSeparatesRoles() throws Exception {
        byte[] host = new byte[32];
        byte[] phone = new byte[32];
        Arrays.fill(host, (byte) 1);
        Arrays.fill(phone, (byte) 2);
        byte[] proof = InternetSession.proof(key(), "phone", host, phone);
        StringBuilder hex = new StringBuilder();
        for (byte value : proof) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        assertEquals("4aa7825897513740bd3a948ad4dd3a3b7a2c2de1e00840dc6aabe79dc6cbff63", hex.toString());
        assertFalse(Arrays.equals(proof, InternetSession.proof(key(), "desktop", host, phone)));
        assertFalse(Arrays.equals(proof, InternetSession.proof(key(), "phone", phone, host)));
    }

    @Test
    public void acceptsOnlyOverlayIpv4() throws Exception {
        for (String ip : new String[] {"100.64.0.1", "100.127.255.255"}) {
            assertTrue(InternetSession.isOverlayAddress(InetAddress.getByName(ip).getAddress()));
        }
        for (String ip : new String[] {"127.0.0.1", "192.168.1.1", "100.63.0.1", "100.128.0.1", "::1"}) {
            assertFalse(InternetSession.isOverlayAddress(InetAddress.getByName(ip).getAddress()));
        }
    }

    @Test(timeout = 5000)
    public void acceptsValidClientAndRejectsWrongOrReplayedProof() throws Exception {
        byte[] previousProof = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
                FutureTask<Boolean> authenticated = new FutureTask<>(() -> {
                    try (Socket accepted = server.accept()) {
                        InternetSession.authenticate(accepted, key());
                        return true;
                    } catch (java.io.IOException e) { return false; }
                });
                Thread worker = new Thread(authenticated);
                worker.start();
                try (Socket client = new Socket(InetAddress.getLoopbackAddress(), server.getLocalPort())) {
                    client.setSoTimeout(2000);
                    byte[] host = new byte[32];
                    Arrays.fill(host, (byte) 1);
                    client.getOutputStream().write(host, 0, 3);
                    client.getOutputStream().write(host, 3, 29);
                    DataInputStream input = new DataInputStream(client.getInputStream());
                    byte[] phone = new byte[32];
                    byte[] proof = new byte[32];
                    input.readFully(phone);
                    input.readFully(proof);
                    assertArrayEquals(InternetSession.proof(key(), "phone", host, phone), proof);
                    byte[] response = InternetSession.proof(key(), "desktop", host, phone);
                    if (attempt == 0) previousProof = response;
                    if (attempt == 1) response = new byte[32];
                    if (attempt == 2) response = previousProof;
                    client.getOutputStream().write(response);
                    assertEquals(attempt == 0 ? 1 : -1, input.read());
                    assertEquals(attempt == 0, authenticated.get(2, TimeUnit.SECONDS));
                }
                worker.join(1000);
                assertFalse(worker.isAlive());
            }
        }
    }

    @Test(timeout = 5000)
    public void shortPhraseWithholdsPhoneVerifierUntilClientAuthenticates() throws Exception {
        for (boolean valid : new boolean[] {true, false}) {
            try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
                FutureTask<Boolean> authenticated = new FutureTask<>(() -> {
                    try (Socket accepted = server.accept()) {
                        InternetSession.authenticate(accepted, key(), true);
                        return true;
                    } catch (java.io.IOException e) { return false; }
                });
                Thread worker = new Thread(authenticated);
                worker.start();
                try (Socket client = new Socket(InetAddress.getLoopbackAddress(), server.getLocalPort())) {
                    client.setSoTimeout(1000);
                    byte[] host = new byte[32];
                    client.getOutputStream().write(host);
                    DataInputStream input = new DataInputStream(client.getInputStream());
                    byte[] phone = new byte[32];
                    input.readFully(phone);
                    client.setSoTimeout(100);
                    try { input.readByte(); fail("Unauthenticated clients must not receive a short-phrase verifier"); }
                    catch (java.net.SocketTimeoutException expected) { }
                    client.setSoTimeout(1000);
                    client.getOutputStream().write(valid ? InternetSession.proof(key(), "desktop", host, phone) : new byte[32]);
                    if (valid) {
                        byte[] proof = new byte[32];
                        input.readFully(proof);
                        assertArrayEquals(InternetSession.proof(key(), "phone", host, phone), proof);
                        assertEquals(1, input.read());
                    } else assertEquals(-1, input.read());
                    assertEquals(valid, authenticated.get(1, TimeUnit.SECONDS));
                }
                worker.join(1000);
                assertFalse(worker.isAlive());
            }
        }
    }
}
