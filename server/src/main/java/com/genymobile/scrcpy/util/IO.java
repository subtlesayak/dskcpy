package com.genymobile.scrcpy.util;

import com.genymobile.scrcpy.AndroidVersions;
import com.genymobile.scrcpy.BuildConfig;

import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructTimeval;

import java.io.FileDescriptor;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Scanner;

public final class IO {
    private IO() {
        // not instantiable
    }

    private static int write(FileDescriptor fd, ByteBuffer from) throws IOException {
        while (true) {
            try {
                return Os.write(fd, from);
            } catch (ErrnoException e) {
                if (e.errno != OsConstants.EINTR) {
                    throw new IOException(e);
                }
            }
        }
    }

    public static void writeFully(FileDescriptor fd, ByteBuffer from) throws IOException {
        if (Build.VERSION.SDK_INT >= AndroidVersions.API_23_ANDROID_6_0) {
            while (from.hasRemaining()) {
                write(fd, from);
            }
        } else {
            // ByteBuffer position is not updated as expected by Os.write() on old Android versions, so
            // handle the position and the remaining bytes manually.
            // See <https://github.com/Genymobile/scrcpy/issues/291>.
            int position = from.position();
            int remaining = from.remaining();
            while (remaining > 0) {
                int w = write(fd, from);
                if (BuildConfig.DEBUG && w < 0) {
                    // w should not be negative, since an exception is thrown on error
                    throw new AssertionError("Os.write() returned a negative value (" + w + ")");
                }
                remaining -= w;
                position += w;
                from.position(position);
            }
        }
    }

    public static void writeFully(FileDescriptor fd, byte[] buffer, int offset, int len) throws IOException {
        writeFully(fd, ByteBuffer.wrap(buffer, offset, len));
    }

    /**
     * Limit how long a blocking socket write may wait for peer consumption.
     *
     * <p>The timeout is deliberately configured at the file-descriptor level
     * so it also applies to writes performed through {@link Os#write}.</p>
     */
    public static void setWriteTimeout(FileDescriptor fd, long timeoutMillis) throws IOException {
        if (Build.VERSION.SDK_INT < AndroidVersions.API_29_ANDROID_10) {
            // StructTimeval and Os.setsockoptTimeval were added in Android 10.
            // The socket remains usable without this optional guardrail on
            // older devices.
            return;
        }
        try {
            StructTimeval timeout = StructTimeval.fromMillis(timeoutMillis);
            Os.setsockoptTimeval(fd, OsConstants.SOL_SOCKET, OsConstants.SO_SNDTIMEO, timeout);
        } catch (ErrnoException e) {
            throw new IOException(e);
        }
    }

    public static String toString(InputStream inputStream) {
        StringBuilder builder = new StringBuilder();
        Scanner scanner = new Scanner(inputStream);
        while (scanner.hasNextLine()) {
            builder.append(scanner.nextLine()).append('\n');
        }
        return builder.toString();
    }

    public static boolean isBrokenPipe(IOException e) {
        Throwable cause = e.getCause();
        return cause instanceof ErrnoException && ((ErrnoException) cause).errno == OsConstants.EPIPE;
    }

    public static boolean isBrokenPipe(Exception e) {
        return e instanceof IOException && isBrokenPipe((IOException) e);
    }

    public static boolean isWriteTimeout(Exception e) {
        if (!(e instanceof IOException)) {
            return false;
        }
        Throwable cause = e.getCause();
        return cause instanceof ErrnoException && ((ErrnoException) cause).errno == OsConstants.EAGAIN;
    }
}
