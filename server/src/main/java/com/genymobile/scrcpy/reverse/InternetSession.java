package com.genymobile.scrcpy.reverse;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Session authentication only. Encryption is provided by the required VPN. */
final class InternetSession {
    private InternetSession() {
    }

    static byte[] proof(byte[] key, String role, byte[] hostNonce, byte[] phoneNonce) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        mac.update(("DisplayBridge/1/" + role + "\0").getBytes(StandardCharsets.UTF_8));
        mac.update(hostNonce);
        mac.update(phoneNonce);
        return mac.doFinal();
    }

    static void authenticate(Socket socket, byte[] key) throws IOException, GeneralSecurityException {
        authenticate(socket, key, false);
    }

    static void authenticate(Socket socket, byte[] key, boolean clientFirst) throws IOException, GeneralSecurityException {
        // SO_TIMEOUT alone is per-read: a peer could otherwise keep a handshake
        // alive by sending one byte at a time. Enforce a total wall-clock limit.
        java.util.Timer deadline = new java.util.Timer("internet-auth-deadline", true);
        deadline.schedule(new java.util.TimerTask() {
            @Override
            public void run() {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }, 5000);
        try {
            authenticateWithinDeadline(socket, key, clientFirst);
        } finally {
            deadline.cancel();
        }
    }

    private static void authenticateWithinDeadline(Socket socket, byte[] key, boolean clientFirst) throws IOException, GeneralSecurityException {
        socket.setSoTimeout(5000);
        DataInputStream input = new DataInputStream(socket.getInputStream());
        OutputStream output = socket.getOutputStream();
        byte[] hostNonce = new byte[32];
        input.readFully(hostNonce);
        byte[] phoneNonce = new byte[32];
        new SecureRandom().nextBytes(phoneNonce);
        output.write(phoneNonce);
        // Short phrases have only 33 random bits. Do not hand an unauthenticated
        // caller a verifier it could use to search the word list offline.
        if (!clientFirst) output.write(proof(key, "phone", hostNonce, phoneNonce));
        output.flush();
        byte[] response = new byte[32];
        input.readFully(response);
        if (!MessageDigest.isEqual(response, proof(key, "desktop", hostNonce, phoneNonce))) {
            throw new IOException("Session authentication failed");
        }
        if (clientFirst) output.write(proof(key, "phone", hostNonce, phoneNonce));
        output.write(1);
        output.flush();
        socket.setSoTimeout(0);
    }

    static boolean isOverlayAddress(byte[] address) {
        return address.length == 4 && (address[0] & 0xff) == 100
                && (address[1] & 0xff) >= 64 && (address[1] & 0xff) <= 127;
    }
}
