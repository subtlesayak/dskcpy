/* Test-only native fixture: never captures or accepts a streaming command. */
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--help") != 0) return 64;
    puts("--reverse-display --reverse-socket --reverse-keyboard ScreenCaptureKit/VideoToolbox");
    return 0;
}
