package com.genymobile.scrcpy.reverse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Surface;

import com.genymobile.scrcpy.control.DeviceMessage;

import java.io.Closeable;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;

/** Owns a user-started connection independently of the Activity and its Surface. */
public final class ReverseSessionService extends Service {
    private static final String CHANNEL = "dskcpy-session";
    private static final String STOP = "com.genymobile.scrcpy.reverse.STOP_SESSION";
    private static final int NOTIFICATION = 27182;
    final class LocalBinder extends Binder { ReverseSessionService service() { return ReverseSessionService.this; } }
    private final IBinder binder = new LocalBinder();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ReverseSessionState state = new ReverseSessionState();
    private final Object transportLock = new Object();
    private Closeable transport;
    private ReverseDisplay decoder;
    private Surface surface;
    private Runnable listener;
    private String secret = "";
    private String message = "Connect Tailscale, then start an Internet session.";
    private String scid;
    private InetAddress vpnAddress;
    private int width;
    private int height;
    private Boolean lastVideoVisible;
    private boolean foreground;
    private boolean touchEnabled = true;
    private boolean audioEnabled = true;
    private String audioStatus = "Phone audio starting";
    private boolean usePassphrase = true;
    private int passphraseWords = 12;
    @Override public void onCreate() {
        super.onCreate();
        android.content.SharedPreferences defaults = getSharedPreferences("receiver", MODE_PRIVATE);
        audioEnabled = defaults.getBoolean("audio", true);
        touchEnabled = defaults.getBoolean("touch", true);
    }
    private final Runnable checkVpn = new Runnable() {
        @Override public void run() {
            if (!state.isActive() || vpnAddress == null) return;
            if (!vpnAddress.equals(findVpnAddress())) {
                stopSession("Private network disconnected. Reconnect Tailscale and start a new session.");
            } else main.postDelayed(this, 1000);
        }
    };

    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) requestStop();
        return START_NOT_STICKY; // Never resurrect a secret or remote-control session after process death.
    }
    void observe(Runnable callback) { listener = callback; }
    void unobserve(Runnable callback) { if (listener == callback) listener = null; }
    boolean isActive() { return state.isActive(); }
    boolean showVideo() { return state.phase() == ReverseSessionState.Phase.CONNECTED || (state.isActive() && scid != null); }
    String secret() { return secret; }
    String message() { return message; }
    ReverseDisplay decoder() { return decoder; }
    int videoWidth() { return width; }
    int videoHeight() { return height; }
    boolean touchEnabled() { return touchEnabled; }
    boolean audioEnabled() { return audioEnabled; }
    String audioStatus() { return audioStatus; }
    void setAudioEnabled(boolean enabled) {
        audioEnabled = enabled;
        getSharedPreferences("receiver", MODE_PRIVATE).edit().putBoolean("audio", enabled).apply();
        updateVideoVisibility();
        changed();
    }
    void setTouchEnabled(boolean enabled) {
        touchEnabled = enabled;
        getSharedPreferences("receiver", MODE_PRIVATE).edit().putBoolean("touch", enabled).apply();
    }
    boolean usePassphrase() { return usePassphrase; }
    int passphraseWords() { return passphraseWords; }

    private void changed() {
        if (foreground) updateNotification();
        if (listener != null) listener.run();
    }

    void setVisible(boolean visible) {
        state.setVisible(visible);
        if (!visible && decoder != null && Build.VERSION.SDK_INT < 23) {
            stopSession("Background resume requires Android 6 or later. Start a new session.");
            return;
        }
        updateVideoVisibility();
    }

    void attachSurface(Surface next) {
        surface = next;
        if (decoder != null) {
            try { decoder.onSurfaceCreated(next); }
            catch (RuntimeException e) { stopSession("Could not restore the video surface. Start a new session."); return; }
        }
        updateVideoVisibility();
    }

    void detachSurface(Surface old) {
        if (surface != old) return;
        surface = null;
        if (decoder != null) {
            try { decoder.onSurfaceDestroyed(old); }
            catch (RuntimeException e) { stopSession("Could not pause the video surface. Start a new session."); return; }
        }
        updateVideoVisibility();
    }

    private void updateVideoVisibility() {
        boolean visible = state.isVisible() && surface != null;
        if (decoder != null) {
            decoder.setRenderingEnabled(visible);
            decoder.setAudioEnabled(visible && audioEnabled);
            if (lastVideoVisible == null || lastVideoVisible != visible) {
                decoder.getSender().send(DeviceMessage.createReverseSystemAction(visible
                        ? DeviceMessage.REVERSE_SYSTEM_ACTION_RESUME_VIDEO : DeviceMessage.REVERSE_SYSTEM_ACTION_PAUSE_VIDEO));
                lastVideoVisible = visible;
            }
        }
        if (foreground) updateNotification();
    }

    private boolean startProtectedSession() {
        try {
            // Called only by the bound, visible Activity after a user start action.
            startService(new Intent(this, ReverseSessionService.class));
            Notification notification = notification();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(NOTIFICATION, notification);
            foreground = true;
            return true;
        } catch (RuntimeException e) {
            stopSession("Android could not keep this session active. Reopen dskcpy and try again.");
            return false;
        }
    }

    void startInternet(boolean passphrase, int words) {
        stopSession("Opening private-network receiver…");
        usePassphrase = passphrase;
        passphraseWords = words;
        vpnAddress = findVpnAddress();
        if (vpnAddress == null) {
            message = "No private VPN address found. Connect Tailscale and include dskcpy in the VPN.";
            changed();
            return;
        }
        final long token = state.begin();
        if (!startProtectedSession()) return;
        try {
            secret = passphrase ? InternetSecret.generatePassphrase(getAssets().open("internet-words.txt"), words) : InternetSecret.generateKey();
            InternetReceiver receiver = new InternetReceiver(vpnAddress, secret, new InternetReceiver.Listener() {
                @Override public void onReady(String unused) {
                    main.post(() -> {
                        if (!state.isCurrent(token)) return;
                        message = "Phone IP: " + vpnAddress.getHostAddress() + "\nEnter this secret on the computer. It expires in 5 minutes and works once. "
                                + "You may switch apps and return; the notification can stop this session.";
                        changed();
                    });
                }
                @Override public void onConnected(java.net.Socket socket) {
                    main.post(() -> {
                        if (!state.isCurrent(token)) { closeQuietly(socket); return; }
                        try { connected(token, socket.getInputStream(), socket.getOutputStream()); }
                        catch (IOException e) { stopSession("Phone connection closed. Start a new session."); }
                    });
                }
                @Override public void onError(String error) { main.post(() -> { if (state.isCurrent(token)) stopSession(error); }); }
            });
            synchronized (transportLock) { transport = receiver; }
            receiver.start();
            main.postDelayed(checkVpn, 1000);
        } catch (IOException | GeneralSecurityException e) {
            stopSession("Could not create the session secret. Try a different format or reinstall the app.");
        }
        changed();
    }

    void startUsb(String nextScid) {
        if (!nextScid.matches("[0-9a-fA-F]{8}")) return;
        if (state.isActive() && nextScid.equals(scid)) return;
        stopSession("Waiting for the computer…");
        scid = nextScid;
        final long token = state.begin();
        if (!startProtectedSession()) return;
        new Thread(() -> {
            try {
                UsbTransport usb;
                synchronized (transportLock) {
                    if (!state.isCurrent(token)) return;
                    usb = new UsbTransport("scrcpy_" + nextScid);
                    transport = usb;
                }
                usb.accept();
                main.post(() -> {
                    if (!state.isCurrent(token)) { closeQuietly(usb); return; }
                    try { connected(token, usb.video.getInputStream(), usb.control.getOutputStream()); }
                    catch (IOException e) { stopSession("Computer connection closed. Start a new stream."); }
                });
            } catch (IOException | RuntimeException e) {
                main.post(() -> { if (state.isCurrent(token)) stopSession("Could not connect to the computer. Start a new stream."); });
            }
        }, "reverse-connect").start();
        changed();
    }

    private void connected(long token, java.io.InputStream input, java.io.OutputStream output) {
        if (!state.connected(token)) return;
        if (!state.isVisible() && Build.VERSION.SDK_INT < 23) {
            stopSession("Background resume requires Android 6 or later. Start a new session.");
            return;
        }
        secret = "";
        message = "Desktop connected. Video pauses when you leave and resumes when you return.";
        decoder = new ReverseDisplay(input, output, transport, (w, h) -> main.post(() -> {
            if (!state.isCurrent(token)) return;
            width = w; height = h; changed();
        }), Build.VERSION.SDK_INT >= 23);
        audioStatus = "Phone audio starting";
        decoder.prepareAudio(this, status -> {
            if (!state.isCurrent(token)) return;
            audioStatus = status;
            changed();
        });
        if (surface != null) decoder.onSurfaceCreated(surface);
        decoder.start(fatal -> main.post(() -> {
            if (state.isCurrent(token)) stopSession(fatal ? "The stream ended. Start a new session to reconnect." : "Computer disconnected.");
        }));
        updateVideoVisibility();
        changed();
    }

    void requestStop() {
        ReverseDisplay current = decoder;
        if (current == null) {
            stopSession("Session stopped.");
            return;
        }
        current.getSender().send(DeviceMessage.createReverseSystemAction(DeviceMessage.REVERSE_SYSTEM_ACTION_STOP_SESSION));
        // Let the tiny control message leave before closing its transport. Never
        // block the UI, and never let this delayed close affect a new session.
        main.postDelayed(() -> { if (decoder == current) stopSession("Session stopped."); }, 150);
    }

    void stopSession(String reason) {
        state.stop();
        main.removeCallbacks(checkVpn);
        secret = ""; scid = null; vpnAddress = null; width = 0; height = 0;
        lastVideoVisible = null;
        ReverseDisplay old = decoder;
        decoder = null;
        if (old != null) old.stop();
        synchronized (transportLock) { closeQuietly(transport); transport = null; }
        if (old != null) new Thread(() -> { try { old.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }, "reverse-cleanup").start();
        if (foreground) { stopForeground(true); foreground = false; }
        stopSelf();
        message = reason;
        changed();
    }

    private InetAddress findVpnAddress() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return null;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            LinkProperties properties = manager.getLinkProperties(network);
            if (caps == null || properties == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            for (LinkAddress link : properties.getLinkAddresses()) {
                if (InternetSession.isOverlayAddress(link.getAddress().getAddress())) return link.getAddress();
            }
        }
        return null;
    }

    private Notification notification() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Active dskcpy session", NotificationManager.IMPORTANCE_LOW));
            builder = new Notification.Builder(this, CHANNEL);
        } else builder = new Notification.Builder(this);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, ReverseDisplayActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ReverseSessionService.class).setAction(STOP), flags);
        String text = decoder == null ? "Waiting for computer · temporary session"
                : Boolean.TRUE.equals(lastVideoVisible) ? "Desktop connected" : "Video paused · tap to return";
        return builder.setSmallIcon(android.R.drawable.ic_menu_view).setContentTitle("dskcpy session")
                .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE).setVisibility(Notification.VISIBILITY_PRIVATE)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop session", stop).build();
    }
    private void updateNotification() { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION, notification()); }
    @Override public void onTaskRemoved(Intent rootIntent) { stopSession("Session closed."); }
    @Override public void onDestroy() { listener = null; stopSession("Session closed."); main.removeCallbacksAndMessages(null); super.onDestroy(); }
    private static void closeQuietly(Closeable value) { if (value != null) try { value.close(); } catch (IOException ignored) { } }

    private static final class UsbTransport implements Closeable {
        final LocalServerSocket server;
        LocalSocket video;
        LocalSocket control;
        boolean closed;
        UsbTransport(String socketName) throws IOException { server = new LocalServerSocket(socketName); }
        void accept() throws IOException {
            LocalSocket first = server.accept();
            synchronized (this) { if (closed) { first.close(); throw new IOException("Closed"); } video = first; }
            video.setReceiveBufferSize(64 * 1024);
            byte[] metadata = new byte[65]; // Scrcpy dummy byte + 64-byte device name.
            byte[] model = Build.MODEL.getBytes(StandardCharsets.UTF_8);
            System.arraycopy(model, 0, metadata, 1, Math.min(model.length, 63));
            video.getOutputStream().write(metadata);
            video.getOutputStream().flush();
            LocalSocket second = server.accept();
            synchronized (this) { if (closed) { second.close(); throw new IOException("Closed"); } control = second; }
        }
        @Override public synchronized void close() {
            closed = true; closeQuietly(control); closeQuietly(video); closeQuietly(server);
        }
    }
}
