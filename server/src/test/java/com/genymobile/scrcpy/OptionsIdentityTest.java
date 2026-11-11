package com.genymobile.scrcpy;

import org.junit.Assert;
import org.junit.Test;

public class OptionsIdentityTest {
    @Test
    public void acceptsInheritedProtocolWithForkArtifactVersion() {
        Assert.assertNotEquals(BuildConfig.VERSION_NAME, BuildConfig.SCRCPY_PROTOCOL_VERSION);
        Assert.assertNotNull(Options.parse(BuildConfig.SCRCPY_PROTOCOL_VERSION));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsArtifactVersionAsWireVersion() {
        Options.parse(BuildConfig.VERSION_NAME);
    }
}
