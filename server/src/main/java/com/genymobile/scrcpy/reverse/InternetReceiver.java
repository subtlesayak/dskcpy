package com.genymobile.scrcpy.reverse;

import java.io.Closeable;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.security.GeneralSecurityException;
import java.util.Arrays;

/** Explicit, foreground-service-owned, single-use receiver bound to a VPN address. */
final class InternetReceiver implements Closeable {
    static final int PORT = 27182;

    interface Listener {
        void onReady(String key);
        void onConnected(Socket socket) throws IOException;
        void onError(String message);
    }

    private final InetAddress address;
    private final Listener listener;
    private final byte[] key;
    private String secret;
    private final boolean shortPassphrase;
    private volatile boolean closed;
    private ServerSocket server;
    private Socket socket;

    InternetReceiver(InetAddress address, String secret, Listener listener) throws GeneralSecurityException {
        if (!InternetSession.isOverlayAddress(address.getAddress())) {
            throw new IllegalArgumentException("A private VPN address is required");
        }
        this.address = address;
        this.listener = listener;
        this.secret = secret;
        shortPassphrase = secret.split(" ").length == 3;
        key = InternetSecret.deriveKey(secret);
    }

    void start() {
        new Thread(this::run, "internet-receive").start();
    }

    private void run() {
        try {
            synchronized (this) {
                if (closed) return;
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(address, PORT), 1);
                server.setSoTimeout(1000);
            }
            listener.onReady(secret);
            secret = null;
            long deadline = System.nanoTime() + 300_000_000_000L;
            int failures = 0;
            while (!closed && System.nanoTime() < deadline && failures < 5) {
                Socket candidate;
                try {
                    candidate = server.accept();
                } catch (SocketTimeoutException e) {
                    continue;
                }
                synchronized (this) {
                    if (closed) { candidate.close(); return; }
                    socket = candidate;
                }
                try {
                    if (!InternetSession.isOverlayAddress(candidate.getInetAddress().getAddress())) {
                        throw new IOException("Private-network peer required");
                    }
                    candidate.setTcpNoDelay(true);
                    candidate.setReceiveBufferSize(64 * 1024);
                    InternetSession.authenticate(candidate, key, shortPassphrase);
                } catch (IOException | GeneralSecurityException e) {
                    candidate.close();
                    failures++;
                    continue;
                }
                server.close(); // One authenticated desktop, no unattended listener.
                listener.onConnected(candidate);
                return;
            }
            if (!closed) listener.onError("Session expired or too many failed attempts. Tap Start Internet session for a new key.");
            close();
        } catch (IOException | RuntimeException e) {
            if (!closed) listener.onError("Internet receiver could not connect. Check Tailscale and start a new session.");
            close();
        } finally {
            secret = null;
            Arrays.fill(key, (byte) 0);
        }
    }

    @Override
    public synchronized void close() {
        closed = true;
        closeQuietly(socket);
        closeQuietly(server);
    }

    private static void closeQuietly(Closeable value) {
        if (value != null) {
            try { value.close(); } catch (IOException ignored) { }
        }
    }
}
