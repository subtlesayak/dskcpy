meson setup x-reverse --buildtype=debug
meson compile -C x-reverse
meson test -C x-reverse --print-errorlogs