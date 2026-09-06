package com.genymobile.scrcpy.reverse;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.junit.Assert.*;

public class InternetSecretTest {
    private static final String PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";

    @Test
    public void generatesTwelveWordsFromBundledDictionary() throws Exception {
        String first;
        try (InputStream input = getClass().getResourceAsStream("/internet-words.txt")) {
            assertNotNull(input);
            first = InternetSecret.generatePassphrase(input);
        }
        assertEquals(12, first.split(" ").length);
        assertTrue(first.matches("[a-z]{3,8}( [a-z]{3,8}){11}"));
        try (InputStream input = getClass().getResourceAsStream("/internet-words.txt")) {
            assertNotEquals(first, InternetSecret.generatePassphrase(input));
        }
    }

    @Test
    public void generatesAlphanumericWithoutAmbiguousCharacters() throws Exception {
        String first = InternetSecret.generateKey();
        assertTrue(first.matches("[23456789A-HJ-NP-Z]{26}"));
        assertNotEquals(first, InternetSecret.generateKey());
        assertArrayEquals(InternetSecret.deriveKey(first), InternetSecret.deriveKey(first.toLowerCase(java.util.Locale.ROOT)));
    }

    @Test
    public void canonicalPassphraseMatchesDesktopVector() throws Exception {
        byte[] key = InternetSecret.deriveKey(PHRASE);
        StringBuilder text = new StringBuilder();
        for (byte value : key) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        assertEquals("8fd7400bdd6f6977eb79a3438b077f1ea2b90dd7c67e418dcb901b143dca2333", text.toString());
        assertArrayEquals(key, InternetSecret.deriveKey("  " + PHRASE.toUpperCase(java.util.Locale.ROOT).replace(" ", "\n  ") + "  "));
        assertFalse(Arrays.equals(key, InternetSecret.deriveKey(PHRASE.replace("accident", "account"))));
    }

    @Test
    public void rejectsIncompleteAndMalformedSecrets() throws Exception {
        for (String secret : new String[] {"", "one two", "123456", "11111111111111111111111111", PHRASE + " extra"}) {
            try { InternetSecret.deriveKey(secret); fail("Must reject invalid format"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test
    public void generatesAndNormalizesThreeWordOption() throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/internet-words.txt")) {
            String phrase = InternetSecret.generatePassphrase(input, 3);
            assertEquals(3, phrase.split(" ").length);
            assertArrayEquals(InternetSecret.deriveKey(phrase), InternetSecret.deriveKey(phrase.toUpperCase(java.util.Locale.ROOT)));
        }
    }

    @Test
    public void rejectsCorruptDictionary() throws Exception {
        try {
            InternetSecret.generatePassphrase(new ByteArrayInputStream("not-a-word-list\n".getBytes(StandardCharsets.UTF_8)));
            fail("Must reject malformed asset");
        } catch (java.io.IOException expected) { }
    }
}
