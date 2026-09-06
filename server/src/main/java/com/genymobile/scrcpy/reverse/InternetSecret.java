package com.genymobile.scrcpy.reverse;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;

/** Offline, uniformly random temporary secrets; not wallet recovery phrases. */
final class InternetSecret {
    private static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

    private InternetSecret() {
    }

    static String generateKey() {
        SecureRandom random = new SecureRandom();
        StringBuilder result = new StringBuilder(26);
        for (int i = 0; i < 26; i++) result.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        return result.toString();
    }

    static String generatePassphrase(InputStream input) throws IOException {
        return generatePassphrase(input, 12);
    }

    static String generatePassphrase(InputStream input, int count) throws IOException {
        if (count != 3 && count != 12) throw new IllegalArgumentException("Choose 3 or 12 words");
        List<String> words = new ArrayList<>(2048);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.matches("[a-z]{3,8}") || words.size() >= 2048) throw new IOException("Invalid word list");
                words.add(line);
            }
        }
        if (words.size() != 2048 || new HashSet<>(words).size() != 2048) throw new IOException("Invalid word list");
        SecureRandom random = new SecureRandom();
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < count; i++) {
            if (i > 0) result.append(' ');
            result.append(words.get(random.nextInt(words.size())));
        }
        return result.toString();
    }

    static byte[] deriveKey(String secret) throws GeneralSecurityException {
        String canonical = secret.trim().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (!canonical.matches("[a-z]{3,8}(( [a-z]{3,8}){2}|( [a-z]{3,8}){11})")) {
            canonical = secret.trim().toUpperCase(Locale.ROOT);
            if (!canonical.matches("[23456789A-HJ-NP-Z]{26}")) throw new IllegalArgumentException("Invalid session secret");
        }
        return MessageDigest.getInstance("SHA-256").digest(("DisplayBridge/1/secret\0" + canonical).getBytes(StandardCharsets.UTF_8));
    }
}
