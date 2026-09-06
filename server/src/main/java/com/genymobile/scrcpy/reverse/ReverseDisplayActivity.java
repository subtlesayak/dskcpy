package com.genymobile.scrcpy.reverse;

import com.genymobile.scrcpy.control.DeviceMessage;
import com.genymobile.scrcpy.control.DeviceMessageSender;
import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.R;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.google.android.material.bottomnavigation.BottomNavigationView;
import com.google.android.material.navigation.NavigationBarView;
import com.google.android.material.navigationrail.NavigationRailView;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.radiobutton.MaterialRadioButton;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.ComponentName;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.RadioButton;
import android.widget.RadioGroup;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;

/**
 * Normal application window for reverse-display mode.
 *
 * <p>The scrcpy server is normally launched by app_process under the shell
 * UID. Recent Android versions reject WindowManager sessions from that
 * process, even when the shell has the overlay permission. A real Activity
 * owns the window and the surface, while the host still sends the stream over
 * the existing ADB tunnel.
 */
public final class ReverseDisplayActivity extends AppCompatActivity
        implements SurfaceHolder.Callback, ReverseDisplayWindow.SurfaceListener {

    private final Object lock = new Object();

    private SurfaceView surfaceView;
    private FrameLayout rootView;
    private GridLayout controlBar;
    private ScrollView controlScroller;
    private GridLayout moreControlBar;
    private ScrollView moreControlScroller;
    private TextView moreControlsButton;
    private boolean moreControlsVisible;
    private boolean moreReplacesMain;
    private Toast controlHintToast;
    private TextView showControlsButton;
    private TextView hideControlsButton;
    private TextView touchButton;
    private TextView audioButton;
    private TextView connectionAddressText;
    private TextView connectionHintText;
    private FeedbackButton copyAddressButton;
    private Surface surface;
    private ReverseDisplay reverseDisplay;
    private TextView internetStatusText;
    private TextView internetKeyText;
    private FeedbackButton internetStartButton;
    private FeedbackButton internetCopyButton;
    private boolean usePassphrase = true;
    private int passphraseWords = 12;
    private String ownedClipboardSecret;
    private final Runnable clearSecretClipboard = this::clearInternetClipboard;
    private final android.os.Handler internetHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private ReverseSessionService session;
    private boolean bound;
    private boolean activityVisible;
    private String pendingScid;
    private boolean stopping;
    private final Runnable sessionChanged = this::syncSession;
    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            session = ((ReverseSessionService.LocalBinder) binder).service();
            // A recreated landing screen must reflect the session's existing
            // secret format, not silently fall back to the 12-word default.
            if (!session.showVideo()) showConnectionInfo();
            session.setVisible(activityVisible);
            if (activityVisible) session.observe(sessionChanged);
            startPendingUsb();
            if (surface != null) session.attachSurface(surface);
            syncSession();
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            session = null;
            synchronized (lock) { reverseDisplay = null; }
            if (activityVisible) {
                showConnectionInfo();
                internetStatusText.setText("Session ended. Start a new connection.");
            }
        }
    };
    private int videoWidth;
    private int videoHeight;
    private boolean touchEnabled = true;
    private int selectedNavigation;
    private final java.util.List<RepeatMaterialButton> volumeButtons = new java.util.ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) selectedNavigation = Math.max(0, Math.min(3, savedInstanceState.getInt("connectionTab", 0)));
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        pendingScid = getIntent().getStringExtra("scid");
        getIntent().removeExtra("scid"); // Do not restart an old USB session on Activity recreation.
        showConnectionInfo();
        bound = bindService(new Intent(this, ReverseSessionService.class), serviceConnection, BIND_AUTO_CREATE);
    }

    private void startPendingUsb() {
        if (session != null && activityVisible && pendingScid != null) {
            String scid = pendingScid;
            pendingScid = null;
            session.startUsb(scid);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        pendingScid = intent.getStringExtra("scid");
        intent.removeExtra("scid");
        setIntent(intent);
        startPendingUsb();
    }

    @Override protected void onStart() {
        super.onStart();
        activityVisible = true;
        if (session != null) {
            session.observe(sessionChanged);
            syncSession();
            session.setVisible(true);
            startPendingUsb();
        }
    }

    @Override protected void onStop() {
        cancelVolumeRepeat();
        dismissControlHint();
        hideMoreDesktopControls(false);
        activityVisible = false;
        if (session != null) {
            session.unobserve(sessionChanged);
            session.setVisible(false);
        }
        super.onStop();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putInt("connectionTab", selectedNavigation); // No addresses, keys or secrets.
        super.onSaveInstanceState(state);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (surfaceView == null) { showConnectionInfo(); syncSession(); }
        else updateSurfaceLayout();
    }

    @Override public void onBackPressed() {
        if (moreControlsVisible) {
            hideMoreDesktopControls(true);
        } else if (session != null && session.isActive()) {
            Toast.makeText(this, "Session kept active. Use Stop session to disconnect.", Toast.LENGTH_SHORT).show();
            moveTaskToBack(true);
        } else super.onBackPressed();
    }

    private void syncSession() {
        if (session == null || !activityVisible || stopping) return;
        synchronized (lock) { reverseDisplay = session.decoder(); }
        touchEnabled = session.touchEnabled();
        if (session.showVideo()) {
            clearInternetClipboard();
            if (internetKeyText != null) internetKeyText.setText("");
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            if (surfaceView == null) showStreamSurface();
            updateAudioButton();
            if (session.videoWidth() > 0) onVideoSize(session.videoWidth(), session.videoHeight());
        } else {
            if (surfaceView != null) showConnectionInfo();
            String key = session.secret();
            internetKeyText.setText(key);
            internetCopyButton.setEnabled(!key.isEmpty());
            internetStartButton.setEnabled(true);
            internetStartButton.setLabel(session.isActive() ? "Cancel Internet session" : "Start Internet session");
            internetStatusText.setText(session.message());
            if (key.isEmpty()) {
                clearInternetClipboard();
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
        }
    }

    private void showStreamSurface() {
        hideSystemUi();
        surfaceView = new SurfaceView(this);
        surfaceView.setFocusable(false);
        surfaceView.getHolder().addCallback(this);
        surfaceView.setOnTouchListener(this::onTouch);

        rootView = new FrameLayout(this);
        rootView.setBackgroundColor(Color.BLACK);
        rootView.addView(surfaceView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        createControlBar();
        ViewCompat.setOnApplyWindowInsetsListener(rootView, (view, insets) -> {
            view.post(this::updateSurfaceLayout);
            return insets;
        });
        rootView.addOnLayoutChangeListener((view, left, top, right, bottom,
                oldLeft, oldTop, oldRight, oldBottom) -> updateSurfaceLayout());
        setContentView(rootView);

    }

    private void showConnectionInfo() {
        cancelVolumeRepeat();
        dismissControlHint();
        hideMoreDesktopControls(false);
        volumeButtons.clear();
        if (surface != null && session != null) session.detachSurface(surface);
        surface = null;
        surfaceView = null;
        rootView = null;
        videoWidth = videoHeight = 0;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        boolean wide = getResources().getConfiguration().screenWidthDp >= 600;
        LinearLayout infoRoot = new LinearLayout(this);
        infoRoot.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        infoRoot.setBackgroundColor(Color.rgb(16, 20, 22));
        ViewCompat.setOnApplyWindowInsetsListener(infoRoot, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return windowInsets;
        });

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setClipToPadding(false);
        scrollView.setScrollbarFadingEnabled(false);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.START);
        page.setPadding(dp(24), dp(24), dp(24), dp(24));
        scrollView.addView(page, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));

        TextView brand = createInfoText("dskcpy", 13,
                Color.rgb(86, 205, 247), Typeface.BOLD);
        brand.setLetterSpacing(0.06f);
        page.addView(brand);

        TextView title = createInfoText("USB connection", 28, Color.WHITE, Typeface.NORMAL);
        ViewCompat.setAccessibilityHeading(title, true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        titleParams.setMargins(0, dp(14), 0, dp(8));
        page.addView(title, titleParams);

        TextView subtitle = createInfoText(
                "Use Wi-Fi nearby, or Internet mode over your private VPN.",
                16, Color.rgb(178, 193, 204), Typeface.NORMAL);
        page.addView(subtitle);

        LinearLayout usbPanel = createConnectionPanel(page);
        LinearLayout wifiPanel = createConnectionPanel(page);
        LinearLayout internetCard = createConnectionPanel(page);
        LinearLayout settingsPanel = createConnectionPanel(page);
        buildUsbPanel(usbPanel);
        buildSettingsPanel(settingsPanel);
        internetCard.addView(createInfoText("Private-network session", 20, Color.WHITE, Typeface.NORMAL));
        TextView internetHelp = createInfoText("Connect Tailscale on both devices. Invited accounts and shared phones work too. "
                + "No USB or wireless debugging needed. Streaming uses mobile data when Wi-Fi is off.", 14, Color.LTGRAY, Typeface.NORMAL);
        internetHelp.setPadding(0, dp(8), 0, dp(16));
        internetCard.addView(internetHelp);
        internetStatusText = createInfoText("Connect Tailscale, then start an Internet session.", 14, Color.rgb(137, 209, 229), Typeface.NORMAL);
        internetStatusText.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        internetCard.addView(internetStatusText);
        RadioGroup secretOptions = new RadioGroup(this);
        secretOptions.setOrientation(LinearLayout.VERTICAL);
        RadioButton phraseOption = new MaterialRadioButton(this);
        phraseOption.setId(View.generateViewId());
        phraseOption.setText("Passphrase · 12 words");
        phraseOption.setTextColor(Color.WHITE);
        phraseOption.setMinHeight(dp(48));
        RadioButton shortPhraseOption = new MaterialRadioButton(this);
        shortPhraseOption.setId(View.generateViewId());
        shortPhraseOption.setText("Passphrase · 3 words (less secure)");
        shortPhraseOption.setTextColor(Color.WHITE);
        shortPhraseOption.setMinHeight(dp(48));
        RadioButton keyOption = new MaterialRadioButton(this);
        keyOption.setId(View.generateViewId());
        keyOption.setText("Alphanumeric key · 26 characters");
        keyOption.setTextColor(Color.WHITE);
        keyOption.setMinHeight(dp(48));
        secretOptions.addView(phraseOption);
        secretOptions.addView(shortPhraseOption);
        secretOptions.addView(keyOption);
        if (session != null) { usePassphrase = session.usePassphrase(); passphraseWords = session.passphraseWords(); }
        secretOptions.check(!usePassphrase ? keyOption.getId() : passphraseWords == 3 ? shortPhraseOption.getId() : phraseOption.getId());
        secretOptions.setOnCheckedChangeListener((group, checkedId) -> {
            closeInternetSession();
            usePassphrase = checkedId != keyOption.getId();
            passphraseWords = checkedId == shortPhraseOption.getId() ? 3 : 12;
            internetCopyButton.setLabel(usePassphrase ? "Copy passphrase" : "Copy key");
            if (usePassphrase && passphraseWords == 3) {
                internetStatusText.setText("Three words are easier to type but offer less protection. Use only your own trusted devices on Tailscale. "
                        + "For stronger protection choose 12 words or an alphanumeric key.");
            }
        });
        internetCard.addView(secretOptions);
        internetKeyText = createInfoText("", 18, Color.WHITE, Typeface.NORMAL);
        internetKeyText.setTypeface(Typeface.MONOSPACE);
        internetKeyText.setSaveEnabled(false); // Never persist a session secret in Activity state.
        internetKeyText.setTextIsSelectable(true);
        internetCard.addView(internetKeyText);
        internetCopyButton = createInfoButton(usePassphrase ? "Copy passphrase" : "Copy key", false);
        internetCopyButton.setEnabled(false);
        internetCopyButton.setOnClickListener(view -> copyInternetSecret());
        internetCard.addView(internetCopyButton);
        internetStartButton = createInfoButton("Start Internet session", true);
        internetStartButton.setEnabled(session != null);
        internetStartButton.setOnClickListener(view -> {
            if (session != null && session.isActive()) closeInternetSession();
            else startInternetSession();
        });
        internetCard.addView(internetStartButton);

        FeedbackButton accountHelpButton = createInfoButton("Different Tailscale accounts?", false);
        TextView accountHelpText = createInfoText(
                "Share this Android phone in Tailscale’s device admin page with the computer owner. They accept the invite using their own account, "
                + "then select this phone in dskcpy’s Internet tab. The shared address on their computer may differ from the phone IP shown here.\n\n"
                + "Alternatively, invite the other account into the same private network. Tailscale policy must allow computer → phone on TCP 27182. "
                + "Do not share account passwords or forward public ports.\n\n"
                + "For another person, use 12 words or an alphanumeric key. A connected phone can see the desktop and send touch input. "
                + "Both people must agree. Stop the session in dskcpy; revoke the share in Tailscale when access is no longer needed.",
                14, Color.LTGRAY, Typeface.NORMAL);
        accountHelpText.setVisibility(View.GONE);
        accountHelpButton.setOnClickListener(view -> {
            boolean show = accountHelpText.getVisibility() != View.VISIBLE;
            accountHelpText.setVisibility(show ? View.VISIBLE : View.GONE);
            accountHelpButton.setLabel(show ? "Hide account setup" : "Different Tailscale accounts?");
        });
        internetCard.addView(accountHelpButton);
        internetCard.addView(accountHelpText);

        LinearLayout card = wifiPanel;

        TextView addressLabel = createInfoText("WI-FI IP ADDRESS", 12,
                Color.rgb(139, 160, 174), Typeface.BOLD);
        addressLabel.setLetterSpacing(0.1f);
        card.addView(addressLabel);

        connectionAddressText = createInfoText("Finding Wi-Fi address…", 26,
                Color.WHITE, Typeface.BOLD);
        connectionAddressText.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        connectionAddressText.setTextIsSelectable(true);
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        addressParams.setMargins(0, dp(10), 0, dp(10));
        card.addView(connectionAddressText, addressParams);

        connectionHintText = createInfoText("", 14,
                Color.rgb(178, 193, 204), Typeface.NORMAL);
        connectionHintText.setLineSpacing(0, 1.12f);
        card.addView(connectionHintText);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        actionsParams.setMargins(0, dp(18), 0, 0);
        card.addView(actions, actionsParams);

        copyAddressButton = createInfoButton("Copy address", true);
        copyAddressButton.setOnClickListener(view -> copyConnectionAddress());
        actions.addView(copyAddressButton);

        FeedbackButton refreshButton = createInfoButton("Refresh", false);
        refreshButton.setOnClickListener(view -> {
            updateConnectionAddress();
            refreshButton.showFeedback("Refreshed");
        });
        actions.addView(refreshButton);

        LinearLayout steps = new LinearLayout(this);
        steps.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams stepsParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        stepsParams.setMargins(0, dp(22), 0, 0);
        wifiPanel.addView(steps, stepsParams);
        steps.addView(createStep("1", "Pair without USB · Android 11+",
                "Open Developer options → Wireless debugging → Pair device with pairing code. "
                + "On the computer, choose Wi-Fi → Pair a phone without USB and enter that address and code."));
        steps.addView(createStep("2", "Connect over Wi-Fi",
                "After pairing, choose Wi-Fi on the computer. If the phone is not found, use Connect IP with "
                + "the IP address and port on the main Wireless debugging screen — not the pairing port."));

        FeedbackButton settingsButton = createInfoButton("Open Developer options", false);
        settingsButton.setOnClickListener(view -> {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException e) {
                Toast.makeText(this, "Open Settings → Developer options manually", Toast.LENGTH_LONG).show();
            }
        });
        wifiPanel.addView(settingsButton);

        TextView note = createInfoText(
                "Wireless debugging chooses its own port, which may change. Use a trusted Wi-Fi network. "
                + "Legacy alternative: use this IP with :5555 only if ADB TCP/IP is already enabled; "
                + "Android 10 and older need USB for that initial setup.",
                13, Color.rgb(126, 148, 162), Typeface.NORMAL);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        noteParams.setMargins(0, dp(22), 0, 0);
        wifiPanel.addView(note, noteParams);

        NavigationBarView navigation = wide ? new NavigationRailView(this) : new BottomNavigationView(this);
        navigation.setLabelVisibilityMode(NavigationBarView.LABEL_VISIBILITY_LABELED);
        int[] ids = {R.id.connection_usb, R.id.connection_wifi, R.id.connection_internet, R.id.connection_settings};
        int[] icons = {R.drawable.ic_connection_usb, R.drawable.ic_connection_wifi, R.drawable.ic_connection_internet, R.drawable.ic_settings};
        String[] labels = {"USB", "Wi-Fi", "Internet", "Settings"};
        String[] titles = {"USB connection", "Wi-Fi / direct IP", "Internet connection", "Settings"};
        String[] subtitles = {"A wired connection for a responsive desktop.", "Connect nearby, without a cable.",
                "Your desktop, across private networks.", "Make the receiver work your way."};
        View[] panels = {(View) usbPanel.getParent(), (View) wifiPanel.getParent(), (View) internetCard.getParent(), (View) settingsPanel.getParent()};
        for (int i = 0; i < ids.length; ++i) navigation.getMenu().add(0, ids[i], i, labels[i]).setIcon(icons[i]);
        Runnable selectPanel = () -> {
            for (int i = 0; i < panels.length; ++i) panels[i].setVisibility(i == selectedNavigation ? View.VISIBLE : View.GONE);
            title.setText(titles[selectedNavigation]);
            subtitle.setText(subtitles[selectedNavigation]);
            scrollView.scrollTo(0, 0);
            if (selectedNavigation == 1) updateConnectionAddress();
        };
        navigation.setSelectedItemId(ids[selectedNavigation]);
        navigation.setOnItemSelectedListener(item -> {
            for (int i = 0; i < ids.length; ++i) if (item.getItemId() == ids[i]) selectedNavigation = i;
            selectPanel.run();
            return true;
        });
        // The root owns safe-area padding, not both root and navigation.
        ViewCompat.setOnApplyWindowInsetsListener(navigation, (view, insets) -> insets);
        if (wide) {
            infoRoot.addView(navigation, new LinearLayout.LayoutParams(dp(96), LinearLayout.LayoutParams.MATCH_PARENT));
            infoRoot.addView(scrollView, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1));
        } else {
            infoRoot.addView(scrollView, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
            infoRoot.addView(navigation, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        }
        selectPanel.run();

        setContentView(infoRoot);
        ViewCompat.requestApplyInsets(infoRoot);
        updateConnectionAddress();
    }

    private LinearLayout createConnectionPanel(LinearLayout page) {
        MaterialCardView card = new MaterialCardView(this);
        card.setRadius(dp(24));
        card.setCardBackgroundColor(Color.rgb(28, 33, 35));
        card.setStrokeWidth(0);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(24);
        page.addView(card, params);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(20), dp(20), dp(20));
        card.addView(content, new FrameLayout.LayoutParams(-1, -2));
        return content;
    }

    private void buildUsbPanel(LinearLayout panel) {
        panel.addView(createStep("1", "Connect a USB data cable", "Connect this phone to the computer. A charge-only cable will not appear in the desktop app."));
        panel.addView(createStep("2", "Allow USB debugging", "Enable USB debugging in Developer options, then approve the computer's debugging prompt on this phone."));
        panel.addView(createStep("3", "Start from the desktop", "Open dskcpy on the computer, choose USB, select this phone and press Start streaming. This app opens the stream automatically."));
        FeedbackButton settings = createInfoButton("Open Developer options", true);
        settings.setOnClickListener(view -> {
            try { startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
            catch (RuntimeException error) { Toast.makeText(this, "Open Settings → Developer options manually", Toast.LENGTH_LONG).show(); }
        });
        panel.addView(settings);
        TextView hint = createInfoText("No Wi-Fi, Tailscale or session key needed for USB.", 14, Color.LTGRAY, Typeface.NORMAL);
        hint.setPadding(0, dp(16), 0, 0);
        panel.addView(hint);
    }

    private void buildSettingsPanel(LinearLayout panel) {
        panel.addView(createInfoText("Receiver defaults", 20, Color.WHITE, Typeface.NORMAL));
        MaterialSwitch audio = new MaterialSwitch(this);
        audio.setText("Play desktop audio on phone");
        audio.setMinHeight(dp(64));
        audio.setChecked(session == null || session.audioEnabled());
        audio.setEnabled(session != null);
        audio.setOnCheckedChangeListener((button, enabled) -> { if (session != null) session.setAudioEnabled(enabled); });
        panel.addView(audio, new LinearLayout.LayoutParams(-1, -2));
        MaterialSwitch touch = new MaterialSwitch(this);
        touch.setText("Allow touch input to desktop");
        touch.setMinHeight(dp(64));
        touch.setChecked(session == null || session.touchEnabled());
        touch.setEnabled(session != null);
        touch.setOnCheckedChangeListener((button, enabled) -> { if (session != null) session.setTouchEnabled(enabled); });
        panel.addView(touch, new LinearLayout.LayoutParams(-1, -2));
        TextView help = createInfoText("These choices are saved on this phone. The live toolbar can change them during a session.\n\n"
                + "Volume − / + controls the computer. Hold to repeat. Phone audio mute only silences this receiver; use the phone's volume keys for its speaker level. Mac audio forwarding is not yet available.\n\n"
                + "Leaving the app pauses video and audio. Return to resume, or use Stop session to disconnect.\n\n"
                + "Privacy: session keys are temporary and never saved. Desktop audio is mirrored, not recorded. No microphone access is requested.",
                14, Color.LTGRAY, Typeface.NORMAL);
        help.setPadding(0, dp(16), 0, 0);
        help.setLineSpacing(0, 1.15f);
        panel.addView(help);
    }

    private TextView createInfoText(String text, int sizeSp, int color, int style) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTypeface(Typeface.DEFAULT, style);
        return view;
    }

    private FeedbackButton createInfoButton(String label, boolean primary) {
        FeedbackButton button = new FeedbackButton(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        button.setTextColor(new ColorStateList(new int[][] {{-android.R.attr.state_enabled}, {}},
                new int[] {Color.rgb(123, 130, 133), primary ? Color.rgb(0, 54, 65) : Color.rgb(224, 227, 229)}));
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(56));
        button.setClickable(true);
        button.setFocusable(true);
        setButtonBackground(button, primary ? Color.rgb(137, 209, 229) : Color.rgb(52, 75, 82), 28, primary);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(12);
        button.setLayoutParams(params);
        return button;
    }

    private final class FeedbackButton extends MaterialButton {
        private final Runnable restoreLabel;
        private String restingLabel;

        FeedbackButton(String label) {
            super(ReverseDisplayActivity.this);
            restingLabel = label;
            setText(label);
            setAllCaps(false);
            setPadding(dp(16), dp(12), dp(16), dp(12));
            setInsetTop(0);
            setInsetBottom(0);
            restoreLabel = () -> setText(restingLabel);
        }

        void setLabel(String label) {
            removeCallbacks(restoreLabel);
            restingLabel = label;
            setText(label);
        }

        void showFeedback(String message) {
            removeCallbacks(restoreLabel);
            setText(message);
            announceForAccessibility(message);
            postDelayed(restoreLabel, 5000);
        }

        @Override
        protected void onDetachedFromWindow() {
            removeCallbacks(restoreLabel);
            restoreLabel.run();
            super.onDetachedFromWindow();
        }
    }

    private GradientDrawable buttonFill(int color, int radius, int stroke) {
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(color);
        fill.setCornerRadius(dp(radius));
        fill.setStroke(dp(2), stroke);
        return fill;
    }

    private void setButtonBackground(TextView button, int baseColor, int radius, boolean primary) {
        if (button instanceof MaterialButton) {
            MaterialButton material = (MaterialButton) button;
            material.setCornerRadius(dp(radius));
            material.setBackgroundTintList(new ColorStateList(new int[][] {
                {-android.R.attr.state_enabled}, {android.R.attr.state_selected}, {}
            }, new int[] {Color.rgb(46, 51, 53), Color.rgb(0, 78, 93), baseColor}));
            material.setRippleColor(ColorStateList.valueOf(Color.argb(65, 165, 238, 255)));
            material.setStrokeWidth(dp(2));
            material.setStrokeColor(new ColorStateList(new int[][] {{android.R.attr.state_focused}, {}},
                    new int[] {Color.rgb(165, 238, 255), Color.TRANSPARENT}));
            return;
        }
        int accent = Color.rgb(86, 205, 247);
        int highlighted = primary ? Color.rgb(142, 224, 250) : Color.rgb(38, 70, 86);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[] {-android.R.attr.state_enabled}, buttonFill(baseColor, radius, Color.TRANSPARENT));
        states.addState(new int[] {android.R.attr.state_pressed}, buttonFill(highlighted, radius, accent));
        states.addState(new int[] {android.R.attr.state_focused}, buttonFill(highlighted, radius, accent));
        states.addState(new int[] {android.R.attr.state_hovered}, buttonFill(highlighted, radius, accent));
        states.addState(new int[] {android.R.attr.state_selected}, buttonFill(Color.rgb(22, 62, 49), radius, Color.rgb(68, 218, 135)));
        states.addState(new int[] {}, buttonFill(baseColor, radius, Color.TRANSPARENT));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Color.argb(90, 170, 232, 255)),
                states, buttonFill(Color.WHITE, radius, Color.TRANSPARENT)));
    }

    private LinearLayout createStep(String number, String heading, String body) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.TOP);
        row.setPadding(0, dp(8), 0, dp(8));

        TextView numberView = createInfoText(number, 14,
                Color.rgb(5, 22, 30), Typeface.BOLD);
        numberView.setGravity(Gravity.CENTER);
        GradientDrawable numberBackground = new GradientDrawable();
        numberBackground.setColor(Color.rgb(86, 205, 247));
        numberBackground.setShape(GradientDrawable.OVAL);
        numberView.setBackground(numberBackground);
        row.addView(numberView, new LinearLayout.LayoutParams(dp(30), dp(30)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        copyParams.setMargins(dp(12), 0, 0, 0);
        row.addView(copy, copyParams);
        copy.addView(createInfoText(heading, 16, Color.WHITE, Typeface.BOLD));
        TextView bodyView = createInfoText(body, 14,
                Color.rgb(171, 188, 199), Typeface.NORMAL);
        bodyView.setLineSpacing(0, 1.12f);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        bodyParams.setMargins(0, dp(3), 0, 0);
        copy.addView(bodyView, bodyParams);
        return row;
    }

    private void updateConnectionAddress() {
        String ip = findWifiIpv4Address();
        if (ip == null) {
            connectionAddressText.setText("Wi-Fi not connected");
            connectionHintText.setText(
                    "Connect this phone to Wi-Fi, then tap Refresh.");
            copyAddressButton.setEnabled(false);
            copyAddressButton.setAlpha(0.45f);
            return;
        }
        connectionAddressText.setText(ip);
        connectionHintText.setText(
                "Find the connection port in Settings → Developer options → Wireless debugging. "
                + "This IP alone does not mean debugging is enabled.");
        copyAddressButton.setEnabled(true);
        copyAddressButton.setAlpha(1f);
    }

    private void copyConnectionAddress() {
        CharSequence address = connectionAddressText.getText();
        if (address == null || address.length() == 0) {
            return;
        }
        ClipboardManager clipboard =
                (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("dskcpy address", address));
            copyAddressButton.showFeedback("Copied");
        }
    }

    private static String findWifiIpv4Address() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> interfaces =
                    NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) {
                return null;
            }
            for (NetworkInterface network : Collections.list(interfaces)) {
                String name = network.getName().toLowerCase(Locale.US);
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()
                            || !address.isSiteLocalAddress()) {
                        continue;
                    }
                    String hostAddress = address.getHostAddress();
                    if (name.startsWith("wlan")) {
                        return hostAddress;
                    }
                    if (fallback == null) {
                        fallback = hostAddress;
                    }
                }
            }
        } catch (SocketException | RuntimeException e) {
            Ln.w("Could not determine the Wi-Fi address: " + e.getMessage());
        }
        return fallback;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) cancelVolumeRepeat();
        if (hasFocus && surfaceView != null) {
            hideSystemUi();
        }
    }

    private void hideSystemUi() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void startInternetSession() {
        if (session == null) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 27182);
        }
        session.startInternet(usePassphrase, passphraseWords);
    }

    private void closeInternetSession() {
        if (session != null) session.stopSession("Internet session closed. Start a new session to connect again.");
        clearInternetClipboard();
        syncSession();
    }

    private void copyInternetSecret() {
        if (session == null || !session.isActive() || internetKeyText.getText().length() == 0) return;
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null) return;
        String secret = internetKeyText.getText().toString();
        ClipData clip = ClipData.newPlainText("dskcpy temporary session", secret);
        if (Build.VERSION.SDK_INT >= 24) {
            android.os.PersistableBundle extras = new android.os.PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
            clip.getDescription().setExtras(extras);
        }
        try {
            clipboard.setPrimaryClip(clip);
            ownedClipboardSecret = secret;
            internetCopyButton.showFeedback("Copied");
            internetHandler.removeCallbacks(clearSecretClipboard);
            internetHandler.postDelayed(clearSecretClipboard, 60_000);
        } catch (RuntimeException e) {
            internetCopyButton.showFeedback("Copy unavailable");
        }
    }

    private void clearInternetClipboard() {
        internetHandler.removeCallbacks(clearSecretClipboard);
        if (ownedClipboardSecret == null) return;
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            android.content.ClipDescription description = clipboard == null ? null : clipboard.getPrimaryClipDescription();
            if (description != null && "dskcpy temporary session".contentEquals(description.getLabel())) {
                ClipData current = clipboard.getPrimaryClip();
                if (current != null && current.getItemCount() == 1 && ownedClipboardSecret.contentEquals(current.getItemAt(0).getText())) {
                    if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip();
                    else clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
                }
            }
        } catch (RuntimeException ignored) {
            // Android can deny clipboard access after the app leaves foreground.
        } finally {
            ownedClipboardSecret = null;
        }
    }

    private void onVideoSize(int width, int height) {
        runOnUiThread(() -> {
            videoWidth = width;
            videoHeight = height;
            int orientation = width >= height
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
            if (getRequestedOrientation() != orientation) {
                setRequestedOrientation(orientation);
            }
            updateSurfaceLayout();
        });
    }

    private void updateSurfaceLayout() {
        if (rootView == null || surfaceView == null || videoWidth <= 0 || videoHeight <= 0) {
            return;
        }
        int containerWidth = rootView.getWidth();
        int containerHeight = rootView.getHeight();
        if (containerWidth <= 0 || containerHeight <= 0) {
            return;
        }

        float scale = Math.min((float) containerWidth / videoWidth,
                (float) containerHeight / videoHeight);
        int width = Math.max(1, Math.round(videoWidth * scale));
        int height = Math.max(1, Math.round(videoHeight * scale));

        FrameLayout.LayoutParams params =
                (FrameLayout.LayoutParams) surfaceView.getLayoutParams();
        if (params.width != width || params.height != height
                || params.gravity != Gravity.CENTER) {
            params.width = width;
            params.height = height;
            params.gravity = Gravity.CENTER;
            surfaceView.setLayoutParams(params);
        }
        updateControlBarLayout(containerWidth, containerHeight, width, height);
    }

    private void createControlBar() {
        volumeButtons.clear();
        moreControlsVisible = false;
        controlBar = new GridLayout(this);
        controlBar.setOrientation(GridLayout.HORIZONTAL);
        controlBar.setColumnCount(1);
        controlBar.setPadding(dp(6), dp(6), dp(6), dp(6));
        controlBar.setElevation(dp(6));

        styleControlPanel(controlBar);

        controlBar.addView(createDesktopActionButton("V−", "Volume down",
                DeviceMessage.REVERSE_SYSTEM_ACTION_VOLUME_DOWN, Color.LTGRAY, false));
        controlBar.addView(createDesktopActionButton("V+", "Volume up",
                DeviceMessage.REVERSE_SYSTEM_ACTION_VOLUME_UP, Color.LTGRAY, false));
        audioButton = createControlButton("A", "Mute phone audio", Color.rgb(68, 218, 135));
        audioButton.setOnClickListener(view -> {
            if (session == null) return;
            session.setAudioEnabled(!session.audioEnabled());
            updateAudioButton();
            Toast.makeText(this, session.audioEnabled() ? "Phone audio enabled" : "Phone audio muted", Toast.LENGTH_SHORT).show();
        });
        controlBar.addView(audioButton);
        updateAudioButton();

        TextView stopButton = createControlButton("■", "Stop session", Color.rgb(255, 118, 126));
        stopButton.setOnClickListener(view -> {
            if (session != null) session.requestStop();
        });
        touchButton = createControlButton(touchEnabled ? "T" : "T̸", touchEnabled ? "Disable touch input" : "Enable touch input",
                touchEnabled ? Color.rgb(68, 218, 135) : Color.rgb(255, 118, 126));
        touchButton.setSelected(touchEnabled);
        touchButton.setOnClickListener(view -> {
            touchEnabled = !touchEnabled;
            if (session != null) session.setTouchEnabled(touchEnabled);
            updateTouchButton();
        });
        controlBar.addView(touchButton);
        controlBar.addView(stopButton);

        moreControlsButton = createControlButton("…", "More desktop controls", Color.LTGRAY);
        moreControlsButton.setOnClickListener(view -> {
            if (moreControlsVisible) hideMoreDesktopControls(true);
            else showMoreDesktopControls();
        });
        ViewCompat.setStateDescription(moreControlsButton, "Collapsed");
        controlBar.addView(moreControlsButton);

        hideControlsButton = createControlButton("›", "Hide desktop controls", Color.LTGRAY);
        hideControlsButton.setOnClickListener(view -> {
            cancelVolumeRepeat();
            hideMoreDesktopControls(false);
            controlScroller.setVisibility(View.GONE);
            showControlsButton.setVisibility(View.VISIBLE);
        });
        controlBar.addView(hideControlsButton);

        controlScroller = new ScrollView(this);
        controlScroller.setClipToPadding(false);
        controlScroller.setVerticalScrollBarEnabled(false);
        controlScroller.setScrollbarFadingEnabled(false);
        if (Build.VERSION.SDK_INT >= 23) controlScroller.setScrollIndicators(View.SCROLL_INDICATOR_TOP | View.SCROLL_INDICATOR_BOTTOM);
        controlScroller.addView(controlBar, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.WRAP_CONTENT, ScrollView.LayoutParams.WRAP_CONTENT));
        rootView.addView(controlScroller, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.END | Gravity.CENTER_VERTICAL));

        showControlsButton = createControlButton("‹", "Show desktop controls",
                Color.rgb(32, 191, 244));
        showControlsButton.setVisibility(View.GONE);
        showControlsButton.setElevation(dp(6));
        setButtonBackground(showControlsButton, Color.argb(238, 14, 22, 28), 9, false);
        showControlsButton.setOnClickListener(view -> {
            showControlsButton.setVisibility(View.GONE);
            controlScroller.setVisibility(View.VISIBLE);
        });
        rootView.addView(showControlsButton, new FrameLayout.LayoutParams(dp(48), dp(48),
                Gravity.END | Gravity.CENTER_VERTICAL));
        createMoreControlBar();
    }

    private void styleControlPanel(View panel) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(238, 14, 22, 28));
        background.setCornerRadius(dp(16));
        background.setStroke(dp(1), Color.argb(34, 255, 255, 255));
        panel.setBackground(background);
        panel.setElevation(dp(6));
    }

    private void createMoreControlBar() {
        moreControlBar = new GridLayout(this);
        moreControlBar.setPadding(dp(6), dp(6), dp(6), dp(6));
        styleControlPanel(moreControlBar);
        moreControlBar.addView(createDesktopActionButton("M", "Mute or unmute computer volume",
                DeviceMessage.REVERSE_SYSTEM_ACTION_VOLUME_MUTE, Color.LTGRAY, false));
        moreControlBar.addView(createDesktopActionButton("—", "Minimize active window",
                DeviceMessage.REVERSE_SYSTEM_ACTION_MINIMIZE, Color.LTGRAY, false));
        moreControlBar.addView(createDesktopActionButton("□", "Maximize or restore active window",
                DeviceMessage.REVERSE_SYSTEM_ACTION_MAXIMIZE_RESTORE, Color.LTGRAY, false));
        moreControlBar.addView(createDesktopActionButton("×", "Close active window",
                DeviceMessage.REVERSE_SYSTEM_ACTION_CLOSE, Color.rgb(255, 118, 126), true));
        moreControlBar.addView(createDesktopActionButton("L", "Lock computer",
                DeviceMessage.REVERSE_SYSTEM_ACTION_LOCK, Color.LTGRAY, true));
        TextView collapse = createControlButton("‹", "Back to main controls", Color.rgb(32, 191, 244));
        collapse.setOnClickListener(view -> hideMoreDesktopControls(true));
        moreControlBar.addView(collapse);
        moreControlScroller = new ScrollView(this);
        moreControlScroller.setVerticalScrollBarEnabled(false);
        moreControlScroller.setScrollbarFadingEnabled(false);
        moreControlScroller.addView(moreControlBar, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.WRAP_CONTENT, ScrollView.LayoutParams.WRAP_CONTENT));
        moreControlScroller.setVisibility(View.GONE);
        ViewCompat.setAccessibilityPaneTitle(moreControlScroller, "Additional desktop controls");
        rootView.addView(moreControlScroller, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT));
    }

    private TextView createDesktopActionButton(String glyph, String description,
            int action, int color, boolean confirm) {
        TextView button = createControlButton(glyph, description, color);
        if (confirm) {
            button.setOnClickListener(view -> confirmDesktopAction(description, action));
        } else {
            button.setOnClickListener(view -> sendDesktopAction(action));
        }
        return button;
    }

    private TextView createControlButton(String glyph, String description, int color) {
        boolean volume = glyph.equals("V−") || glyph.equals("V+");
        MaterialButton button = volume ? new RepeatMaterialButton(this) : new MaterialButton(this);
        if (volume) volumeButtons.add((RepeatMaterialButton) button);
        button.setAllCaps(false);
        button.setStateListAnimator(null);
        button.setText("");
        button.setIconResource(controlIcon(glyph));
        button.setIconSize(dp(24));
        button.setIconPadding(0);
        button.setIconGravity(MaterialButton.ICON_GRAVITY_TEXT_START);
        button.setIconTint(ColorStateList.valueOf(color));
        button.setInsetTop(0);
        button.setInsetBottom(0);
        button.setTextColor(color);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setGravity(Gravity.CENTER);
        button.setContentDescription(description);
        button.setMinWidth(0);
        button.setMinHeight(0);
        button.setMinimumWidth(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        setButtonBackground(button, Color.TRANSPARENT, 12, false);
        if (Build.VERSION.SDK_INT >= 26 && !volume) {
            button.setTooltipText(description);
        }
        if (!volume) button.setOnLongClickListener(view -> {
            showControlHint(view);
            return true;
        });
        if (volume) {
            ((RepeatMaterialButton) button).setHoldHint(() -> showControlHint(button));
            button.setLongClickable(false); // The repeat scheduler owns this gesture.
        }
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        return button;
    }

    private int controlIcon(String glyph) {
        switch (glyph) {
            case "V−": return R.drawable.ic_volume_down;
            case "V+": return R.drawable.ic_volume_up;
            case "M": return R.drawable.ic_desktop_mute;
            case "A": return R.drawable.ic_phone_audio;
            case "—": return R.drawable.ic_minimize;
            case "□": return R.drawable.ic_maximize;
            case "×": return R.drawable.ic_close;
            case "L": return R.drawable.ic_lock;
            case "■": return R.drawable.ic_stop;
            case "T": return R.drawable.ic_touch;
            case "T̸": return R.drawable.ic_touch_off;
            case "‹": return R.drawable.ic_show;
            case "…": return R.drawable.ic_more;
            default: return R.drawable.ic_hide;
        }
    }

    private void cancelVolumeRepeat() {
        for (RepeatMaterialButton button : volumeButtons) button.cancelRepeat();
    }

    private void dismissControlHint() {
        if (controlHintToast != null) controlHintToast.cancel();
        controlHintToast = null;
    }

    private void showControlHint(View control) {
        dismissControlHint();
        String explanation = control == moreControlsButton && moreControlsVisible
                ? "Hide extra desktop controls" : String.valueOf(control.getContentDescription());
        if (control instanceof RepeatMaterialButton) explanation += " · Keep holding to repeat";
        controlHintToast = Toast.makeText(this, explanation, Toast.LENGTH_SHORT);
        controlHintToast.show();
    }

    private void updateAudioButton() {
        if (audioButton == null || session == null) return;
        boolean enabled = session.audioEnabled();
        boolean unavailable = session.audioStatus().contains("unavailable") || session.audioStatus().contains("another app");
        audioButton.setSelected(enabled);
        ((MaterialButton) audioButton).setIconResource(enabled ? (unavailable ? R.drawable.ic_warning : R.drawable.ic_phone_audio) : R.drawable.ic_phone_audio_off);
        ((MaterialButton) audioButton).setIconTint(ColorStateList.valueOf(!enabled ? Color.rgb(255, 180, 171)
                : unavailable ? Color.rgb(246, 190, 80) : Color.rgb(137, 209, 229)));
        ViewCompat.setStateDescription(audioButton, enabled ? session.audioStatus() : "Muted");
        audioButton.setContentDescription(enabled ? "Mute phone audio" : "Enable phone audio");
        if (Build.VERSION.SDK_INT >= 26) audioButton.setTooltipText(
                unavailable ? session.audioStatus() : audioButton.getContentDescription());
    }

    private void updateTouchButton() {
        touchButton.setSelected(touchEnabled);
        ((MaterialButton) touchButton).setIconResource(touchEnabled ? R.drawable.ic_touch : R.drawable.ic_touch_off);
        ((MaterialButton) touchButton).setIconTint(ColorStateList.valueOf(touchEnabled ? Color.rgb(137, 209, 229) : Color.rgb(255, 180, 171)));
        ViewCompat.setStateDescription(touchButton, touchEnabled ? "Enabled" : "Disabled");
        touchButton.setContentDescription(touchEnabled ? "Disable touch input"
                                                       : "Enable touch input");
        if (Build.VERSION.SDK_INT >= 26) {
            touchButton.setTooltipText(touchButton.getContentDescription());
        }
        Toast.makeText(this, touchEnabled ? "Desktop touch enabled"
                                         : "Desktop touch disabled",
                Toast.LENGTH_SHORT).show();
    }

    private void confirmDesktopAction(String description, int action) {
        new MaterialAlertDialogBuilder(this)
                .setTitle(description + "?")
                .setMessage(action == DeviceMessage.REVERSE_SYSTEM_ACTION_LOCK
                        ? "The computer will lock. Streaming may pause until it is unlocked locally."
                        : "This asks the active desktop window to close.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton(action == DeviceMessage.REVERSE_SYSTEM_ACTION_LOCK
                        ? "Lock" : "Close", (dialog, which) -> sendDesktopAction(action))
                .setOnDismissListener(dialog -> hideSystemUi())
                .show();
    }

    private void showMoreDesktopControls() {
        cancelVolumeRepeat();
        moreControlsVisible = true;
        updateSurfaceLayout();
        moreControlsButton.setSelected(true);
        ViewCompat.setStateDescription(moreControlsButton, "Expanded");
        moreControlScroller.animate().cancel();
        moreControlScroller.setVisibility(View.VISIBLE);
        moreControlScroller.setAlpha(0f);
        moreControlScroller.setTranslationY(dp(24));
        moreControlScroller.animate().alpha(1f).translationY(0f).setDuration(180)
                .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        moreControlBar.getChildAt(0).requestFocus();
    }

    private void hideMoreDesktopControls(boolean restoreFocus) {
        if (!moreControlsVisible || moreControlScroller == null) return;
        moreControlsVisible = false;
        moreControlScroller.animate().cancel();
        moreControlScroller.setVisibility(View.GONE);
        moreControlScroller.setTranslationY(0f);
        moreControlScroller.setAlpha(1f);
        if (moreReplacesMain) controlScroller.setVisibility(View.VISIBLE);
        moreControlsButton.setSelected(false);
        ViewCompat.setStateDescription(moreControlsButton, "Collapsed");
        if (restoreFocus) moreControlsButton.requestFocus();
    }

    private void sendDesktopAction(int action) {
        DeviceMessageSender sender;
        synchronized (lock) {
            if (reverseDisplay == null || stopping || !activityVisible) {
                Toast.makeText(this, "Desktop is not connected", Toast.LENGTH_SHORT).show();
                return;
            }
            sender = reverseDisplay.getSender();
        }
        sender.send(DeviceMessage.createReverseSystemAction(action));
    }

    private void updateControlBarLayout(int containerWidth, int containerHeight,
            int surfaceWidth, int surfaceHeight) {
        int childCount = controlBar.getChildCount();
        int buttonSize = dp(48);
        int gap = dp(4);
        Insets safe = Insets.NONE;
        WindowInsetsCompat windowInsets = ViewCompat.getRootWindowInsets(rootView);
        if (windowInsets != null) safe = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout()
                | WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.mandatorySystemGestures());
        ControlBarLayout layout = new ControlBarLayout(containerWidth, containerHeight, surfaceWidth, surfaceHeight,
                safe.left, safe.top, safe.right, safe.bottom, buttonSize, gap, dp(6), dp(6), childCount,
                rootView.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL);
        layoutControlGrid(controlBar, layout.columns, layout.rows, buttonSize, gap);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(layout.width, layout.height, Gravity.TOP | Gravity.LEFT);
        barParams.leftMargin = layout.left;
        barParams.topMargin = layout.top;
        controlScroller.setLayoutParams(barParams);
        controlScroller.setVerticalScrollBarEnabled(layout.contentHeight > layout.height);
        FrameLayout.LayoutParams showParams = new FrameLayout.LayoutParams(buttonSize, buttonSize, Gravity.TOP | Gravity.LEFT);
        showParams.leftMargin = layout.showLeft;
        showParams.topMargin = layout.showTop;
        showControlsButton.setLayoutParams(showParams);
        boolean rtl = rootView.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL;
        hideControlsButton.setRotation(layout.side ? (rtl ? 180 : 0) : 90);
        showControlsButton.setRotation(layout.side ? (rtl ? 180 : 0) : 90);
        ControlTrayLayout tray = new ControlTrayLayout(layout, containerWidth, containerHeight,
                safe.left, safe.top, safe.right, safe.bottom, buttonSize, gap, dp(6), dp(6),
                moreControlBar.getChildCount(), rtl);
        layoutControlGrid(moreControlBar, tray.columns, tray.rows, buttonSize, gap);
        FrameLayout.LayoutParams trayParams = new FrameLayout.LayoutParams(tray.width, tray.height, Gravity.TOP | Gravity.LEFT);
        trayParams.leftMargin = tray.left;
        trayParams.topMargin = tray.top;
        moreControlScroller.setLayoutParams(trayParams);
        moreControlScroller.setVerticalScrollBarEnabled(tray.contentHeight > tray.height);
        moreReplacesMain = tray.replacesMain;
        if (moreControlsVisible) controlScroller.setVisibility(tray.replacesMain ? View.GONE : View.VISIBLE);
    }

    private void layoutControlGrid(GridLayout grid, int columns, int rows, int buttonSize, int gap) {
        // Clear old indices before changing dimensions: GridLayout validates them.
        for (int i = 0; i < grid.getChildCount(); ++i) grid.getChildAt(i).setLayoutParams(new GridLayout.LayoutParams());
        grid.setColumnCount(columns);
        grid.setRowCount(rows);
        for (int i = 0; i < grid.getChildCount(); ++i) {
            int row = i / columns, column = i % columns;
            GridLayout.LayoutParams item = new GridLayout.LayoutParams(GridLayout.spec(row), GridLayout.spec(column));
            item.width = item.height = buttonSize;
            item.setMarginEnd(column < columns - 1 ? gap : 0);
            item.bottomMargin = row < rows - 1 ? gap : 0;
            grid.getChildAt(i).setLayoutParams(item);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private boolean onTouch(View view, MotionEvent event) {
        if (!touchEnabled || !activityVisible) {
            return true;
        }
        DeviceMessageSender sender;
        synchronized (lock) {
            if (reverseDisplay == null || stopping) {
                return true;
            }
            sender = reverseDisplay.getSender();
        }

        int action = event.getActionMasked();
        int actionIndex = event.getActionIndex();
        int firstPointer;
        int lastPointer;
        if (action == MotionEvent.ACTION_MOVE) {
            firstPointer = 0;
            lastPointer = event.getPointerCount();
        } else if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_UP) {
            firstPointer = actionIndex;
            lastPointer = actionIndex + 1;
        } else if (action == MotionEvent.ACTION_POINTER_DOWN
                || action == MotionEvent.ACTION_POINTER_UP) {
            // The host needs every active contact in each injected frame.
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
            sender.send(DeviceMessage.createReverseTouch(event, i, pointerAction,
                    width, height));
        }
        return true;
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        onSurfaceCreated(holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        // The decoder renders directly to this surface.
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        onSurfaceDestroyed(holder.getSurface());
    }

    @Override
    public void onSurfaceCreated(Surface surface) {
        this.surface = surface;
        if (session != null) session.attachSurface(surface);
    }

    @Override
    public void onSurfaceDestroyed(Surface surface) {
        if (this.surface == surface) this.surface = null;
        if (session != null) session.detachSurface(surface);
    }

    @Override
    protected void onDestroy() {
        cancelVolumeRepeat();
        stopping = true;
        if (session != null) {
            session.unobserve(sessionChanged);
            if (surface != null) session.detachSurface(surface);
        }
        if (bound) unbindService(serviceConnection);
        session = null;
        synchronized (lock) { reverseDisplay = null; }
        clearInternetClipboard();
        internetHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

}
