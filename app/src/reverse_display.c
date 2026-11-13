#include "reverse_display.h"

#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL3/SDL.h>

#include "events.h"
#include "receiver.h"
#include "reverse_watchdog.h"
#include "reverse_audio.h"
#include "reverse_touch.h"
#include "util/env.h"
#include "util/binary.h"
#include "util/log.h"
#include "util/tick.h"
#include "util/thread.h"

#ifdef _WIN32

// winsock2.h must be included before windows.h. reverse_display.h already
// includes util/net.h, which includes winsock2.h on Windows.
# include <windows.h>
# include "reverse_windows_keyboard.h"
# include "reverse_windows_input.h"
# include "reverse_windows_clipboard.h"
# include <d3d11.h>
# include <dxgi1_2.h>

# include <libavcodec/avcodec.h>
# include <libavutil/avutil.h>
# include <libavutil/frame.h>
# include <libavutil/opt.h>
# include <libavutil/time.h>

#define REVERSE_DISPLAY_STREAM_MAGIC UINT32_C(0x53524431) // "SRD1"
#define REVERSE_DISPLAY_CODEC_H264 UINT32_C(1)
#define REVERSE_DISPLAY_FRAME_FLAG_CONFIG UINT32_C(1)
#define REVERSE_DISPLAY_FRAME_FLAG_KEY UINT32_C(2)
#define REVERSE_DISPLAY_MAX_FRAME_SIZE (16u * 1024u * 1024u)
#define REVERSE_DISPLAY_TOUCH_CONTACT_RADIUS 2
#define REVERSE_DISPLAY_VIDEO_SEND_BUFFER (64 * 1024)
#define REVERSE_DISPLAY_MAX_FRAMES_IN_FLIGHT 2

struct reverse_capture {
    IDXGIFactory1 *factory;
    ID3D11Device *device;
    ID3D11DeviceContext *context;
    IDXGIOutputDuplication *duplication;
    ID3D11Texture2D *staging;

    RECT desktop_rect;
    int source_width;
    int source_height;
    int target_width;
    int target_height;
    bool com_initialized;

    // DXGI may provide the hardware cursor separately from the desktop
    // texture. Keep the latest shape and paint it into the CPU readback
    // before the frame is converted to YUV.
    uint8_t *pointer_shape;
    UINT pointer_shape_capacity;
    UINT pointer_shape_size;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO pointer_shape_info;
    POINT pointer_position;
    bool pointer_visible;
    bool pointer_shape_warning_logged;
};

struct reverse_display_state {
    sc_socket video_socket;
    sc_socket control_socket;
    const struct scrcpy_options *options;

    _Atomic bool stopped;
    _Atomic bool fatal_error;
    _Atomic bool video_paused;
    _Atomic bool force_refresh;
    _Atomic bool stream_ready;
    _Atomic bool audio_enabled;
    _Atomic int64_t audio_acked_pts;
    sc_mutex send_mutex;
    sc_mutex watchdog_mutex;
    struct sc_reverse_watchdog watchdog;
    struct sc_reverse_watchdog audio_watchdog;

    // Updated by the capture thread before the first frame is sent. Touches
    // are ignored until these values are valid.
    _Atomic int desktop_left;
    _Atomic int desktop_top;
    _Atomic int desktop_width;
    _Atomic int desktop_height;
    _Atomic int64_t last_acked_pts;
    _Atomic int64_t stream_start_us;
    int64_t last_metrics_log_us;

    struct reverse_capture capture;
    struct sc_receiver receiver;
    sc_mutex touch_mutex;
    struct sc_reverse_touch touch;
    struct sc_windows_keyboard keyboard; // Protected by touch_mutex, including teardown.
    HWND clipboard_window; // Hidden message-only owner; only with explicit opt-in.
    enum sc_windows_key_result keyboard_status;
    int64_t keyboard_cleanup_after;
    int touch_left, touch_top, touch_width, touch_height;
    bool touch_warning_logged;
    sc_thread capture_thread;
    bool capture_thread_started;
    sc_thread audio_thread;
    bool audio_thread_started;
};

struct reverse_buffer {
    const uint8_t *data;
    size_t size;
    uint8_t *owned;
};

static void
release_dxgi_object(void **object) {
    if (*object) {
        IUnknown *unknown = *object;
        unknown->lpVtbl->Release(unknown);
        *object = NULL;
    }
}

static inline uint8_t
clamp_u8(int value) {
    if (value < 0) {
        return 0;
    }
    if (value > 255) {
        return 255;
    }
    return (uint8_t) value;
}

static inline int
reverse_y(int r, int g, int b) {
    return ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
}

static inline int
reverse_u(int r, int g, int b) {
    return ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
}

static inline int
reverse_v(int r, int g, int b) {
    return ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
}

static void
reverse_convert_bgra(const D3D11_MAPPED_SUBRESOURCE *mapped,
                     int source_width, int source_height, AVFrame *frame) {
    int target_width = frame->width;
    int target_height = frame->height;
    const uint8_t *source = mapped->pData;

    for (int y = 0; y < target_height; ++y) {
        int source_y = y * source_height / target_height;
        const uint8_t *source_row = source + source_y * mapped->RowPitch;
        uint8_t *target_row = frame->data[0] + y * frame->linesize[0];
        for (int x = 0; x < target_width; ++x) {
            int source_x = x * source_width / target_width;
            const uint8_t *pixel = source_row + source_x * 4;
            target_row[x] = clamp_u8(reverse_y(pixel[2], pixel[1], pixel[0]));
        }
    }

    assert(frame->format == AV_PIX_FMT_YUV420P
           || frame->format == AV_PIX_FMT_NV12);
    bool nv12 = frame->format == AV_PIX_FMT_NV12;
    for (int y = 0; y < target_height / 2; ++y) {
        uint8_t *u_row = nv12 ? NULL
                              : frame->data[1] + y * frame->linesize[1];
        uint8_t *v_row = nv12 ? NULL
                              : frame->data[2] + y * frame->linesize[2];
        uint8_t *uv_row = nv12
                        ? frame->data[1] + y * frame->linesize[1] : NULL;
        for (int x = 0; x < target_width / 2; ++x) {
            // YUV420 stores one chroma sample for each 2x2 luma block.
            // Averaging all four mapped pixels avoids turning Windows
            // ClearType subpixels into strong colored fringes around text.
            int r = 0;
            int g = 0;
            int b = 0;
            for (int dy = 0; dy < 2; ++dy) {
                int source_y = (2 * y + dy) * source_height / target_height;
                const uint8_t *source_row =
                    source + source_y * mapped->RowPitch;
                for (int dx = 0; dx < 2; ++dx) {
                    int source_x =
                        (2 * x + dx) * source_width / target_width;
                    const uint8_t *pixel = source_row + source_x * 4;
                    r += pixel[2];
                    g += pixel[1];
                    b += pixel[0];
                }
            }
            r = (r + 2) / 4;
            g = (g + 2) / 4;
            b = (b + 2) / 4;
            uint8_t u = clamp_u8(reverse_u(r, g, b));
            uint8_t v = clamp_u8(reverse_v(r, g, b));
            if (nv12) {
                uv_row[2 * x] = u;
                uv_row[2 * x + 1] = v;
            } else {
                u_row[x] = u;
                v_row[x] = v;
            }
        }
    }
}

static void
reverse_blend_cursor_pixel(uint8_t *dst, const uint8_t *src) {
    uint8_t alpha = src[3];
    if (!alpha) {
        return;
    }
    if (alpha == 255) {
        memcpy(dst, src, 3);
    } else {
        for (unsigned i = 0; i < 3; ++i) {
            dst[i] = (uint8_t) ((src[i] * alpha
                                + dst[i] * (255 - alpha) + 127) / 255);
        }
    }
    dst[3] = 255;
}

static void
reverse_draw_cursor_color(const struct reverse_capture *capture,
                          uint8_t *desktop, UINT desktop_pitch,
                          int width, int height) {
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO *shape =
        &capture->pointer_shape_info;
    int left = capture->pointer_position.x;
    int top = capture->pointer_position.y;
    int source_left = left < 0 ? -left : 0;
    int source_top = top < 0 ? -top : 0;
    int destination_left = left > 0 ? left : 0;
    int destination_top = top > 0 ? top : 0;
    int copy_width = (int) shape->Width - source_left;
    int copy_height = (int) shape->Height - source_top;
    if (destination_left + copy_width > width) {
        copy_width = width - destination_left;
    }
    if (destination_top + copy_height > height) {
        copy_height = height - destination_top;
    }
    if (copy_width <= 0 || copy_height <= 0) {
        return;
    }

    for (int y = 0; y < copy_height; ++y) {
        const uint8_t *source = capture->pointer_shape
                              + (source_top + y) * shape->Pitch
                              + source_left * 4;
        uint8_t *destination = desktop
                              + (destination_top + y) * desktop_pitch
                              + destination_left * 4;
        for (int x = 0; x < copy_width; ++x) {
            reverse_blend_cursor_pixel(destination, source);
            source += 4;
            destination += 4;
        }
    }
}

static void
reverse_draw_cursor_masked_color(const struct reverse_capture *capture,
                                 uint8_t *desktop, UINT desktop_pitch,
                                 int width, int height) {
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO *shape =
        &capture->pointer_shape_info;
    int left = capture->pointer_position.x;
    int top = capture->pointer_position.y;
    int source_left = left < 0 ? -left : 0;
    int source_top = top < 0 ? -top : 0;
    int destination_left = left > 0 ? left : 0;
    int destination_top = top > 0 ? top : 0;
    int copy_width = (int) shape->Width - source_left;
    int copy_height = (int) shape->Height - source_top;
    if (destination_left + copy_width > width) {
        copy_width = width - destination_left;
    }
    if (destination_top + copy_height > height) {
        copy_height = height - destination_top;
    }
    if (copy_width <= 0 || copy_height <= 0) {
        return;
    }

    for (int y = 0; y < copy_height; ++y) {
        const uint8_t *source = capture->pointer_shape
                              + (source_top + y) * shape->Pitch
                              + source_left * 4;
        uint8_t *destination = desktop
                              + (destination_top + y) * desktop_pitch
                              + destination_left * 4;
        for (int x = 0; x < copy_width; ++x) {
            uint8_t alpha = source[3];
            if (alpha == 0) {
                memcpy(destination, source, 3);
                destination[3] = 255;
            } else if (alpha == 255) {
                for (unsigned i = 0; i < 3; ++i) {
                    destination[i] ^= source[i];
                }
                destination[3] = 255;
            } else {
                // The API documents only 0 and 0xff for this format, but
                // alpha blending keeps non-conforming driver shapes usable.
                reverse_blend_cursor_pixel(destination, source);
            }
            source += 4;
            destination += 4;
        }
    }
}

static void
reverse_draw_cursor_monochrome(const struct reverse_capture *capture,
                               uint8_t *desktop, UINT desktop_pitch,
                               int width, int height) {
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO *shape =
        &capture->pointer_shape_info;
    int shape_height = (int) shape->Height / 2;
    int left = capture->pointer_position.x;
    int top = capture->pointer_position.y;
    int source_left = left < 0 ? -left : 0;
    int source_top = top < 0 ? -top : 0;
    int destination_left = left > 0 ? left : 0;
    int destination_top = top > 0 ? top : 0;
    int copy_width = (int) shape->Width - source_left;
    int copy_height = shape_height - source_top;
    if (destination_left + copy_width > width) {
        copy_width = width - destination_left;
    }
    if (destination_top + copy_height > height) {
        copy_height = height - destination_top;
    }
    if (copy_width <= 0 || copy_height <= 0) {
        return;
    }

    for (int y = 0; y < copy_height; ++y) {
        const uint8_t *and_row = capture->pointer_shape
                               + (source_top + y) * shape->Pitch;
        const uint8_t *xor_row = capture->pointer_shape
                               + (shape_height + source_top + y) * shape->Pitch;
        uint8_t *destination = desktop
                              + (destination_top + y) * desktop_pitch
                              + destination_left * 4;
        for (int x = 0; x < copy_width; ++x) {
            unsigned source_x = (unsigned) (source_left + x);
            bool and_bit = (and_row[source_x / 8]
                            & (uint8_t) (0x80 >> (source_x & 7))) != 0;
            bool xor_bit = (xor_row[source_x / 8]
                            & (uint8_t) (0x80 >> (source_x & 7))) != 0;
            if (!and_bit) {
                uint8_t value = xor_bit ? 255 : 0;
                destination[0] = value;
                destination[1] = value;
                destination[2] = value;
                destination[3] = 255;
            } else if (xor_bit) {
                destination[0] = 255 - destination[0];
                destination[1] = 255 - destination[1];
                destination[2] = 255 - destination[2];
                destination[3] = 255;
            }
            destination += 4;
        }
    }
}

static void
reverse_draw_cursor(const struct reverse_capture *capture, uint8_t *desktop,
                    UINT desktop_pitch) {
    if (!capture->pointer_visible || !capture->pointer_shape_size) {
        return;
    }

    int width = capture->source_width;
    int height = capture->source_height;
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO *shape =
        &capture->pointer_shape_info;
    if (!shape->Width || !shape->Height || !shape->Pitch
            || shape->Width > (UINT) width || shape->Height > (UINT) height) {
        // The cursor may legitimately be clipped by the monitor, but its
        // shape itself must still be internally valid before reading it.
        if (!shape->Width || !shape->Height || !shape->Pitch) {
            return;
        }
    }

    switch (shape->Type) {
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR:
            if (shape->Pitch < shape->Width * 4
                    || capture->pointer_shape_size < shape->Pitch * shape->Height) {
                return;
            }
            reverse_draw_cursor_color(capture, desktop, desktop_pitch,
                                       width, height);
            break;
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR:
            if (shape->Pitch < shape->Width * 4
                    || capture->pointer_shape_size < shape->Pitch * shape->Height) {
                return;
            }
            reverse_draw_cursor_masked_color(capture, desktop, desktop_pitch,
                                              width, height);
            break;
        case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME:
            if (shape->Height & 1
                    || shape->Pitch < (shape->Width + 7) / 8
                    || capture->pointer_shape_size
                       < shape->Pitch * shape->Height) {
                return;
            }
            reverse_draw_cursor_monochrome(capture, desktop, desktop_pitch,
                                           width, height);
            break;
        default:
            break;
    }
}

static void
reverse_update_cursor(struct reverse_capture *capture,
                      const DXGI_OUTDUPL_FRAME_INFO *frame_info) {
    if (frame_info->LastMouseUpdateTime.QuadPart) {
        capture->pointer_visible = frame_info->PointerPosition.Visible;
        if (capture->pointer_visible) {
            capture->pointer_position = frame_info->PointerPosition.Position;
        }
    }

    if (!frame_info->PointerShapeBufferSize) {
        return;
    }

    UINT buffer_size = frame_info->PointerShapeBufferSize;
    if (buffer_size > REVERSE_DISPLAY_MAX_FRAME_SIZE) {
        if (!capture->pointer_shape_warning_logged) {
            LOGW("Windows cursor shape is unexpectedly large; hiding it");
            capture->pointer_shape_warning_logged = true;
        }
        return;
    }
    if (buffer_size > capture->pointer_shape_capacity) {
        uint8_t *shape = realloc(capture->pointer_shape, buffer_size);
        if (!shape) {
            if (!capture->pointer_shape_warning_logged) {
                LOGW("Could not allocate memory for the Windows cursor shape");
                capture->pointer_shape_warning_logged = true;
            }
            return;
        }
        capture->pointer_shape = shape;
        capture->pointer_shape_capacity = buffer_size;
    }

    UINT required = 0;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO shape_info;
    HRESULT hr = capture->duplication->lpVtbl->GetFramePointerShape(
        capture->duplication, buffer_size, capture->pointer_shape, &required,
        &shape_info);
    if (FAILED(hr)) {
        if (!capture->pointer_shape_warning_logged) {
            LOGW("Could not retrieve the Windows cursor shape: 0x%08lx",
                 (unsigned long) hr);
            capture->pointer_shape_warning_logged = true;
        }
        return;
    }

    capture->pointer_shape_size = required;
    capture->pointer_shape_info = shape_info;
    capture->pointer_shape_warning_logged = false;
}

static bool
reverse_capture_init(struct reverse_capture *capture,
                     const struct scrcpy_options *options) {
    memset(capture, 0, sizeof(*capture));

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (SUCCEEDED(hr)) {
        capture->com_initialized = true;
    } else if (hr != RPC_E_CHANGED_MODE) {
        LOGE("Could not initialize COM for desktop capture: 0x%08lx",
             (unsigned long) hr);
        return false;
    }

    hr = CreateDXGIFactory1(&IID_IDXGIFactory1, (void **) &capture->factory);
    if (FAILED(hr)) {
        LOGE("Could not create the DXGI factory: 0x%08lx", (unsigned long) hr);
        return false;
    }

    UINT selected_output = options->reverse_display_index;
    UINT output_index = 0;
    IDXGIAdapter1 *adapter = NULL;
    IDXGIOutput *output = NULL;
    IDXGIOutput1 *output1 = NULL;
    bool found = false;

    for (UINT adapter_index = 0; !found; ++adapter_index) {
        hr = capture->factory->lpVtbl->EnumAdapters1(capture->factory,
                                                      adapter_index, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND) {
            break;
        }
        if (FAILED(hr)) {
            LOGE("Could not enumerate DXGI adapters: 0x%08lx",
                 (unsigned long) hr);
            return false;
        }

        for (UINT adapter_output_index = 0;; ++adapter_output_index) {
            hr = adapter->lpVtbl->EnumOutputs(adapter, adapter_output_index,
                                              &output);
            if (hr == DXGI_ERROR_NOT_FOUND) {
                break;
            }
            if (FAILED(hr)) {
                LOGE("Could not enumerate DXGI outputs: 0x%08lx",
                     (unsigned long) hr);
                release_dxgi_object((void **) &adapter);
                return false;
            }

            if (output_index++ != selected_output) {
                release_dxgi_object((void **) &output);
                continue;
            }

            DXGI_OUTPUT_DESC output_desc;
            hr = output->lpVtbl->GetDesc(output, &output_desc);
            if (SUCCEEDED(hr)) {
                capture->desktop_rect = output_desc.DesktopCoordinates;
                capture->source_width = capture->desktop_rect.right
                                      - capture->desktop_rect.left;
                capture->source_height = capture->desktop_rect.bottom
                                       - capture->desktop_rect.top;
                hr = output->lpVtbl->QueryInterface(output, &IID_IDXGIOutput1,
                                                     (void **) &output1);
            }
            release_dxgi_object((void **) &output);
            if (FAILED(hr)) {
                LOGE("Could not access DXGI output %u: 0x%08lx",
                     selected_output, (unsigned long) hr);
                release_dxgi_object((void **) &adapter);
                return false;
            }

            hr = D3D11CreateDevice((IDXGIAdapter *) adapter,
                                   D3D_DRIVER_TYPE_UNKNOWN, NULL,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, NULL, 0,
                                   D3D11_SDK_VERSION, &capture->device, NULL,
                                   &capture->context);
            if (FAILED(hr)) {
                LOGE("Could not create the D3D11 device: 0x%08lx",
                     (unsigned long) hr);
                release_dxgi_object((void **) &output1);
                release_dxgi_object((void **) &capture->context);
                release_dxgi_object((void **) &capture->device);
                release_dxgi_object((void **) &adapter);
                return false;
            }

            hr = output1->lpVtbl->DuplicateOutput(output1,
                                                  (IUnknown *) capture->device,
                                                  &capture->duplication);
            release_dxgi_object((void **) &output1);
            if (FAILED(hr)) {
                if (hr == E_ACCESSDENIED) {
                    LOGE("Windows denied desktop capture (0x%08lx). Unlock the "
                         "computer and run dskcpy in your normal desktop session, "
                         "outside a restricted environment", (unsigned long) hr);
                } else if (hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) {
                    LOGE("Windows has reached its simultaneous desktop capture "
                         "limit. Close another screen recorder and reconnect");
                } else if (hr == DXGI_ERROR_SESSION_DISCONNECTED) {
                    LOGE("The Windows desktop session is disconnected. Sign "
                         "back in on the computer and reconnect");
                } else {
                    LOGE("Could not duplicate Windows monitor %u: 0x%08lx",
                         selected_output, (unsigned long) hr);
                }
                release_dxgi_object((void **) &capture->context);
                release_dxgi_object((void **) &capture->device);
                release_dxgi_object((void **) &adapter);
                return false;
            }

            found = true;
            break;
        }

        release_dxgi_object((void **) &adapter);
    }

    if (!found) {
        LOGE("Windows monitor index %u was not found", selected_output);
        return false;
    }

    if (capture->source_width < 2 || capture->source_height < 2) {
        LOGE("Invalid Windows monitor size: %dx%d", capture->source_width,
             capture->source_height);
        return false;
    }

    capture->target_width = capture->source_width;
    capture->target_height = capture->source_height;
    // A full 4K desktop adds a large CPU readback and encoder queue on the
    // reverse path. Keep the default bounded for interactive latency; users
    // can opt into a larger stream with --max-size.
    uint16_t max_size = options->max_size ? options->max_size : 1920;
    if (max_size && (capture->target_width > max_size
                     || capture->target_height > max_size)) {
        if (capture->target_width >= capture->target_height) {
            capture->target_width = max_size;
            capture->target_height = capture->source_height * max_size
                                   / capture->source_width;
        } else {
            capture->target_height = max_size;
            capture->target_width = capture->source_width * max_size
                                  / capture->source_height;
        }
    }
    // YUV420P requires even dimensions.
    capture->target_width &= ~1;
    capture->target_height &= ~1;
    if (capture->target_width < 2 || capture->target_height < 2) {
        LOGE("Windows monitor is too small for reverse display");
        return false;
    }

    D3D11_TEXTURE2D_DESC desc;
    memset(&desc, 0, sizeof(desc));
    desc.Width = capture->source_width;
    desc.Height = capture->source_height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    hr = capture->device->lpVtbl->CreateTexture2D(capture->device, &desc, NULL,
                                                   &capture->staging);
    if (FAILED(hr)) {
        LOGE("Could not create the desktop staging texture: 0x%08lx",
             (unsigned long) hr);
        return false;
    }

    return true;
}

static void
reverse_capture_destroy(struct reverse_capture *capture) {
    free(capture->pointer_shape);
    capture->pointer_shape = NULL;
    capture->pointer_shape_capacity = 0;
    capture->pointer_shape_size = 0;
    release_dxgi_object((void **) &capture->staging);
    release_dxgi_object((void **) &capture->duplication);
    release_dxgi_object((void **) &capture->context);
    release_dxgi_object((void **) &capture->device);
    release_dxgi_object((void **) &capture->factory);
    if (capture->com_initialized) {
        CoUninitialize();
        capture->com_initialized = false;
    }
}

enum reverse_capture_result {
    REVERSE_CAPTURE_TIMEOUT,
    REVERSE_CAPTURE_FRAME,
    REVERSE_CAPTURE_ERROR,
};

static enum reverse_capture_result
reverse_capture_next(struct reverse_capture *capture, AVFrame *frame) {
    DXGI_OUTDUPL_FRAME_INFO frame_info;
    IDXGIResource *resource = NULL;
    ID3D11Texture2D *texture = NULL;
    D3D11_MAPPED_SUBRESOURCE mapped;
    bool mapped_valid = false;
    bool frame_acquired = false;
    HRESULT hr = capture->duplication->lpVtbl->AcquireNextFrame(
        capture->duplication, 16, &frame_info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        return REVERSE_CAPTURE_TIMEOUT;
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
        LOGE("Windows desktop duplication was lost; reconnect the display");
        return REVERSE_CAPTURE_ERROR;
    }
    if (FAILED(hr)) {
        LOGE("Could not acquire a Windows desktop frame: 0x%08lx",
             (unsigned long) hr);
        return REVERSE_CAPTURE_ERROR;
    }
    reverse_update_cursor(capture, &frame_info);
    frame_acquired = true;

    if (!resource) {
        LOGE("Windows desktop duplication returned no frame resource");
        capture->duplication->lpVtbl->ReleaseFrame(capture->duplication);
        return REVERSE_CAPTURE_ERROR;
    }

    hr = resource->lpVtbl->QueryInterface(resource, &IID_ID3D11Texture2D,
                                          (void **) &texture);
    if (SUCCEEDED(hr)) {
        capture->context->lpVtbl->CopyResource(capture->context,
                                               (ID3D11Resource *) capture->staging,
                                               (ID3D11Resource *) texture);
        hr = capture->context->lpVtbl->Map(capture->context,
                                           (ID3D11Resource *) capture->staging,
                                           0, D3D11_MAP_READ, 0, &mapped);
        if (SUCCEEDED(hr)) {
            mapped_valid = true;
            reverse_draw_cursor(capture, mapped.pData, mapped.RowPitch);
            if (av_frame_make_writable(frame) >= 0) {
                reverse_convert_bgra(&mapped, capture->source_width,
                                     capture->source_height, frame);
            } else {
                hr = E_OUTOFMEMORY;
            }
        }
    }

    if (mapped_valid) {
        capture->context->lpVtbl->Unmap(capture->context,
                                        (ID3D11Resource *) capture->staging, 0);
    }
    release_dxgi_object((void **) &texture);
    release_dxgi_object((void **) &resource);
    if (frame_acquired) {
        capture->duplication->lpVtbl->ReleaseFrame(capture->duplication);
    }

    if (FAILED(hr)) {
        LOGE("Could not copy a Windows desktop frame: 0x%08lx",
             (unsigned long) hr);
        return REVERSE_CAPTURE_ERROR;
    }
    return REVERSE_CAPTURE_FRAME;
}

static unsigned
reverse_get_fps(const char *value) {
    if (!value) {
        return 60;
    }
    char *end;
    float parsed = strtof(value, &end);
    if (end == value || *end || parsed < 1 || parsed > 240) {
        LOGW("Invalid reverse-display max FPS '%s', using 60", value);
        return 60;
    }
    return (unsigned) (parsed + 0.5f);
}

static bool
reverse_wait_for_capture(const struct reverse_display_state *state,
                         sc_tick deadline) {
    while (!atomic_load_explicit(&state->stopped, memory_order_acquire)) {
        sc_tick remaining = deadline - sc_tick_now();
        if (remaining <= 0) {
            return true;
        }

        sc_tick milliseconds = (remaining + 999) / 1000;
        DWORD delay = (DWORD) MIN(milliseconds, (sc_tick) 10);
        Sleep(delay ? delay : 1);
    }
    return false;
}

static uint32_t
reverse_get_bit_rate(const struct scrcpy_options *options, int width,
                     int height, unsigned fps) {
    if (options->video_bit_rate) {
        return options->video_bit_rate;
    }

    // Desktop text and thin UI edges need substantially more bitrate than
    // camera content. Target roughly 0.10 bit/pixel/frame, with a floor that
    // keeps a 720p stream crisp after Android scales it to the panel.
    uint64_t value = (uint64_t) width * height * fps / 10;
    if (value < 8 * 1000 * 1000) {
        value = 8 * 1000 * 1000;
    }
    if (value > 32 * 1000 * 1000) {
        value = 32 * 1000 * 1000;
    }
    return (uint32_t) value;
}

static AVCodecContext *
reverse_open_encoder(const struct scrcpy_options *options, int width, int height,
                    unsigned fps) {
    static const char *const preferred_encoders[] = {
        "h264_nvenc",
        "h264_amf",
        "h264_qsv",
        "h264_mf",
        "libx264",
    };
    unsigned count = options->video_encoder ? 1
                                             : ARRAY_LEN(preferred_encoders);
    for (unsigned i = 0; i < count; ++i) {
        const char *name = options->video_encoder
                         ? options->video_encoder : preferred_encoders[i];
        const AVCodec *codec = avcodec_find_encoder_by_name(name);
        if (!codec) {
            if (options->video_encoder) {
                LOGE("Windows H.264 encoder not found: %s", name);
                return NULL;
            }
            continue;
        }

        bool is_mf = !strcmp(codec->name, "h264_mf");
        unsigned variants = is_mf ? 2 : 1;
        for (unsigned variant = 0; variant < variants; ++variant) {
            bool force_mf_hardware = is_mf && variant == 0;
            AVCodecContext *context = avcodec_alloc_context3(codec);
            if (!context) {
                LOG_OOM();
                return NULL;
            }

            context->width = width;
            context->height = height;
            bool hardware_encoder = !strcmp(codec->name, "h264_nvenc")
                                 || !strcmp(codec->name, "h264_amf")
                                 || !strcmp(codec->name, "h264_qsv")
                                 || is_mf;
            context->pix_fmt = hardware_encoder ? AV_PIX_FMT_NV12
                                                : AV_PIX_FMT_YUV420P;
            context->bit_rate = reverse_get_bit_rate(options, width, height,
                                                     fps);
            context->rc_max_rate = context->bit_rate;
            // Keep VBV small enough for interactive streaming, but leave
            // enough headroom for a detailed desktop IDR frame. A single-
            // frame VBV visibly pulsed on complex 1080p keyframes.
            context->rc_buffer_size = context->bit_rate / fps * 4;
            context->time_base = (AVRational) {1, 1000000};
            context->framerate = (AVRational) {(int) fps, 1};
            // The transport is reliable, so a longer GOP avoids a visible
            // quality pulse every second without affecting input latency.
            context->gop_size = (int) fps * 5;
            context->max_b_frames = 0;
            context->thread_count = 1;
            context->flags |= AV_CODEC_FLAG_LOW_DELAY;

            if (!strcmp(codec->name, "h264_nvenc")) {
                av_opt_set(context->priv_data, "preset", "p1", 0);
                av_opt_set(context->priv_data, "tune", "ull", 0);
                av_opt_set(context->priv_data, "rc", "cbr", 0);
                av_opt_set(context->priv_data, "rc-lookahead", "0", 0);
                av_opt_set(context->priv_data, "surfaces", "2", 0);
                av_opt_set(context->priv_data, "delay", "0", 0);
                av_opt_set(context->priv_data, "zerolatency", "1", 0);
                av_opt_set(context->priv_data, "forced-idr", "1", 0);
            } else if (!strcmp(codec->name, "h264_amf")) {
                av_opt_set(context->priv_data, "usage", "ultralowlatency", 0);
                av_opt_set(context->priv_data, "quality", "speed", 0);
                av_opt_set(context->priv_data, "latency", "1", 0);
                av_opt_set(context->priv_data, "rc", "vbr_latency", 0);
                av_opt_set(context->priv_data, "async_depth", "1", 0);
                av_opt_set(context->priv_data, "preencode", "0", 0);
                av_opt_set(context->priv_data, "bf", "0", 0);
                av_opt_set(context->priv_data, "forced_idr", "1", 0);
            } else if (!strcmp(codec->name, "h264_qsv")) {
                av_opt_set(context->priv_data, "preset", "veryfast", 0);
                av_opt_set(context->priv_data, "async_depth", "1", 0);
                av_opt_set(context->priv_data, "low_delay_brc", "1", 0);
                av_opt_set(context->priv_data, "look_ahead", "0", 0);
                av_opt_set(context->priv_data, "scenario", "displayremoting", 0);
                av_opt_set(context->priv_data, "bf", "0", 0);
                av_opt_set(context->priv_data, "forced_idr", "1", 0);
            } else if (is_mf) {
                av_opt_set(context->priv_data, "scenario", "display_remoting", 0);
                av_opt_set(context->priv_data, "rate_control", "ld_vbr", 0);
                av_opt_set(context->priv_data, "hw_encoding",
                           force_mf_hardware ? "1" : "0", 0);
            } else {
                av_opt_set(context->priv_data, "preset", "ultrafast", 0);
                av_opt_set(context->priv_data, "tune", "zerolatency", 0);
                av_opt_set(context->priv_data, "bf", "0", 0);
                av_opt_set(context->priv_data, "rc-lookahead", "0", 0);
                av_opt_set(context->priv_data, "repeat-headers", "1", 0);
                av_opt_set(context->priv_data, "forced-idr", "1", 0);
            }

            int ret = avcodec_open2(context, codec, NULL);
            if (ret >= 0) {
                const char *mode = is_mf
                                 ? (force_mf_hardware ? ", hardware" : ", software")
                                 : "";
                LOGI("Reverse display encoder: %s%s (%dx%d, %.1f Mbps)",
                     codec->name, mode, width, height,
                     context->bit_rate / 1000000.0);
                return context;
            }

            LOGW("Could not open Windows H.264 encoder %s%s: %d", name,
                 is_mf ? (force_mf_hardware ? " (hardware)" : " (software)")
                       : "",
                 ret);
            avcodec_free_context(&context);
        }
        if (options->video_encoder) {
            return NULL;
        }
    }

    LOGE("No usable Windows H.264 encoder was found");
    return NULL;
}

static bool
reverse_send_bytes(sc_socket socket, const void *data, size_t size) {
    return net_send_all(socket, data, size) == (ssize_t) size;
}

static bool
reverse_send_stream_header(struct reverse_display_state *state,
                           const struct reverse_capture *capture) {
    uint8_t header[16];
    sc_write32be(&header[0], REVERSE_DISPLAY_STREAM_MAGIC);
    sc_write32be(&header[4], REVERSE_DISPLAY_CODEC_H264);
    sc_write32be(&header[8], (uint32_t) capture->target_width);
    sc_write32be(&header[12], (uint32_t) capture->target_height);
    return reverse_send_bytes(state->video_socket, header, sizeof(header));
}

static bool
reverse_has_annexb_start_code(const uint8_t *data, size_t size) {
    if (size < 3) {
        return false;
    }

    // Only accept a start code at the beginning of the packet. Searching the
    // whole packet can mistake an AVCC NAL payload containing 00 00 00 01
    // for Annex-B and forward the length-prefixed packet unchanged.
    size_t pos = 0;
    while (pos < size && data[pos] == 0) {
        ++pos;
    }
    return pos >= 2 && pos < size && data[pos] == 1;
}

static unsigned
reverse_avcc_length_size(const AVCodecContext *encoder) {
    if (encoder->extradata && encoder->extradata_size >= 5
            && encoder->extradata[0] == 1) {
        return (encoder->extradata[4] & 3) + 1;
    }
    return 4;
}

static bool
reverse_normalize_h264(const AVCodecContext *encoder, const uint8_t *data,
                       size_t size, struct reverse_buffer *result) {
    result->data = data;
    result->size = size;
    result->owned = NULL;
    if (reverse_has_annexb_start_code(data, size)) {
        return true;
    }

    unsigned length_size = reverse_avcc_length_size(encoder);
    if (length_size > 4) {
        return false;
    }

    size_t pos = 0;
    size_t count = 0;
    while (pos <= size && size - pos >= length_size) {
        uint32_t nal_size = 0;
        for (unsigned i = 0; i < length_size; ++i) {
            nal_size = (nal_size << 8) | data[pos + i];
        }
        pos += length_size;
        if (!nal_size || nal_size > size - pos) {
            return false;
        }
        pos += nal_size;
        ++count;
    }
    if (pos != size || !count || count > SIZE_MAX / 4) {
        return false;
    }

    if (count > (SIZE_MAX - size) / 4) {
        return false;
    }
    size_t output_size = size + count * 4;
    uint8_t *output = malloc(output_size);
    if (!output) {
        LOG_OOM();
        return false;
    }

    pos = 0;
    size_t output_pos = 0;
    while (pos < size) {
        uint32_t nal_size = 0;
        for (unsigned i = 0; i < length_size; ++i) {
            nal_size = (nal_size << 8) | data[pos + i];
        }
        pos += length_size;
        memcpy(&output[output_pos], "\0\0\0\1", 4);
        output_pos += 4;
        memcpy(&output[output_pos], &data[pos], nal_size);
        output_pos += nal_size;
        pos += nal_size;
    }

    result->data = output;
    result->size = output_pos;
    result->owned = output;
    return true;
}

static bool
reverse_normalize_h264_config(const uint8_t *data, size_t size,
                              struct reverse_buffer *result) {
    result->data = data;
    result->size = size;
    result->owned = NULL;
    if (reverse_has_annexb_start_code(data, size)) {
        return true;
    }

    // AVCDecoderConfigurationRecord (avcC): SPS/PPS are each prefixed by a
    // two-byte length, unlike encoded AVCC packets which use the encoder's
    // configurable length size.
    if (size < 7 || data[0] != 1) {
        return false;
    }

    unsigned sps_count = data[5] & 0x1f;
    if (!sps_count) {
        return false;
    }

    size_t pos = 6;
    size_t output_size = 0;
    for (unsigned i = 0; i < sps_count; ++i) {
        if (pos > size || size - pos < 2) {
            return false;
        }
        uint16_t nal_size = sc_read16be(&data[pos]);
        pos += 2;
        if (!nal_size || nal_size > size - pos
                || output_size > SIZE_MAX - 4 - nal_size) {
            return false;
        }
        output_size += 4 + nal_size;
        pos += nal_size;
    }

    if (pos >= size) {
        return false;
    }
    unsigned pps_count = data[pos++];
    if (!pps_count) {
        return false;
    }
    for (unsigned i = 0; i < pps_count; ++i) {
        if (pos > size || size - pos < 2) {
            return false;
        }
        uint16_t nal_size = sc_read16be(&data[pos]);
        pos += 2;
        if (!nal_size || nal_size > size - pos
                || output_size > SIZE_MAX - 4 - nal_size) {
            return false;
        }
        output_size += 4 + nal_size;
        pos += nal_size;
    }

    uint8_t *output = malloc(output_size);
    if (!output) {
        LOG_OOM();
        return false;
    }

    pos = 6;
    size_t output_pos = 0;
    for (unsigned i = 0; i < sps_count; ++i) {
        uint16_t nal_size = sc_read16be(&data[pos]);
        pos += 2;
        memcpy(&output[output_pos], "\0\0\0\1", 4);
        output_pos += 4;
        memcpy(&output[output_pos], &data[pos], nal_size);
        output_pos += nal_size;
        pos += nal_size;
    }
    unsigned pps_count_again = data[pos++];
    for (unsigned i = 0; i < pps_count_again; ++i) {
        uint16_t nal_size = sc_read16be(&data[pos]);
        pos += 2;
        memcpy(&output[output_pos], "\0\0\0\1", 4);
        output_pos += 4;
        memcpy(&output[output_pos], &data[pos], nal_size);
        output_pos += nal_size;
        pos += nal_size;
    }

    result->data = output;
    result->size = output_pos;
    result->owned = output;
    return true;
}

static bool
reverse_send_frame_packet(struct reverse_display_state *state,
                          const uint8_t *data, size_t size, int64_t pts,
                          uint32_t flags) {
    if (!size || size > REVERSE_DISPLAY_MAX_FRAME_SIZE) {
        LOGE("Invalid encoded reverse-display frame size: %" PRIu64,
             (uint64_t) size);
        return false;
    }
    uint8_t header[16];
    sc_write32be(&header[0], (uint32_t) size);
    sc_write64be(&header[4], (uint64_t) pts);
    sc_write32be(&header[12], flags);
    if (!(flags & REVERSE_DISPLAY_FRAME_FLAG_CONFIG)) {
        sc_mutex_lock(&state->watchdog_mutex);
        sc_reverse_watchdog_submit(&state->watchdog, pts);
        sc_mutex_unlock(&state->watchdog_mutex);
    }
    sc_mutex_lock(&state->send_mutex);
    bool ok = reverse_send_bytes(state->video_socket, header, sizeof(header))
           && reverse_send_bytes(state->video_socket, data, size);
    sc_mutex_unlock(&state->send_mutex);
    return ok;
}

static bool
reverse_audio_stopped(void *userdata) {
    struct reverse_display_state *state = userdata;
    return atomic_load_explicit(&state->stopped, memory_order_acquire);
}

static bool
reverse_audio_enabled(void *userdata) {
    struct reverse_display_state *state = userdata;
    return state->options->reverse_audio
        && atomic_load_explicit(&state->stream_ready, memory_order_acquire)
        && atomic_load_explicit(&state->audio_enabled, memory_order_acquire)
        && !atomic_load_explicit(&state->video_paused, memory_order_acquire)
        && !reverse_audio_stopped(userdata);
}

static int64_t
reverse_audio_acked(void *userdata) {
    struct reverse_display_state *state = userdata;
    return atomic_load_explicit(&state->audio_acked_pts, memory_order_acquire);
}

static bool
reverse_send_audio(void *userdata, const uint8_t *data, size_t size,
                    int64_t pts, uint32_t flags) {
    struct reverse_display_state *state = userdata;
    if (!size || size > 4096 || reverse_audio_stopped(state)) return false;
    uint8_t header[16];
    sc_write32be(header, (uint32_t) size);
    sc_write64be(header + 4, pts);
    sc_write32be(header + 12, flags);
    sc_mutex_lock(&state->watchdog_mutex);
    sc_reverse_watchdog_begin(&state->audio_watchdog, av_gettime_relative());
    if (flags == SC_REVERSE_AUDIO_PACKET) sc_reverse_watchdog_submit(&state->audio_watchdog, pts);
    sc_mutex_unlock(&state->watchdog_mutex);
    sc_mutex_lock(&state->send_mutex);
    bool ok = reverse_send_bytes(state->video_socket, header, sizeof(header))
           && reverse_send_bytes(state->video_socket, data, size);
    sc_mutex_unlock(&state->send_mutex);
    sc_mutex_lock(&state->watchdog_mutex);
    sc_reverse_watchdog_end(&state->audio_watchdog);
    sc_mutex_unlock(&state->watchdog_mutex);
    return ok;
}

static int
reverse_audio_thread(void *userdata) {
    static const struct sc_reverse_audio_callbacks cbs = {
        .stopped = reverse_audio_stopped, .enabled = reverse_audio_enabled,
        .acked_pts = reverse_audio_acked, .send = reverse_send_audio,
    };
    sc_reverse_audio_run(&cbs, userdata);
    return 0;
}

static bool
reverse_send_config(struct reverse_display_state *state,
                    const AVCodecContext *encoder) {
    if (!encoder->extradata || encoder->extradata_size <= 0) {
        return true;
    }

    struct reverse_buffer buffer;
    bool ok = reverse_normalize_h264_config(encoder->extradata,
                                            encoder->extradata_size, &buffer);
    if (!ok) {
        LOGE("Could not convert the Windows H.264 encoder configuration");
        return false;
    }
    ok = reverse_send_frame_packet(state, buffer.data, buffer.size, 0,
                                   REVERSE_DISPLAY_FRAME_FLAG_CONFIG);
    free(buffer.owned);
    return ok;
}

static bool
reverse_encode_frame(struct reverse_display_state *state,
                     AVCodecContext *encoder, AVFrame *frame,
                     int64_t *sent_pts) {
    *sent_pts = AV_NOPTS_VALUE;
    int ret = avcodec_send_frame(encoder, frame);
    if (ret < 0) {
        LOGE("Could not encode a Windows desktop frame: %d", ret);
        return false;
    }

    AVPacket *packet = av_packet_alloc();
    if (!packet) {
        LOG_OOM();
        return false;
    }

    bool ok = true;
    for (;;) {
        ret = avcodec_receive_packet(encoder, packet);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            break;
        }
        if (ret < 0) {
            LOGE("Could not receive an encoded Windows desktop frame: %d",
                 ret);
            ok = false;
            break;
        }

        struct reverse_buffer buffer;
        if (!reverse_normalize_h264(encoder, packet->data, packet->size,
                                    &buffer)) {
            LOGE("The Windows H.264 encoder produced an invalid packet");
            ok = false;
            break;
        }
        uint32_t flags = (packet->flags & AV_PKT_FLAG_KEY)
                       ? REVERSE_DISPLAY_FRAME_FLAG_KEY : 0;
        int64_t pts = packet->pts == AV_NOPTS_VALUE
                    ? frame->pts : packet->pts;
        if (!reverse_send_frame_packet(state, buffer.data, buffer.size, pts,
                                       flags)) {
            ok = false;
        } else {
            *sent_pts = pts;
        }
        free(buffer.owned);
        av_packet_unref(packet);
        if (!ok) {
            break;
        }
    }

    av_packet_free(&packet);
    return ok;
}

static bool
reverse_capture_and_encode(struct reverse_display_state *state) {
    struct reverse_capture *capture = &state->capture;
    if (!reverse_capture_init(capture, state->options)) {
        reverse_capture_destroy(capture);
        return false;
    }

    atomic_store_explicit(&state->desktop_left, capture->desktop_rect.left,
                          memory_order_release);
    atomic_store_explicit(&state->desktop_top, capture->desktop_rect.top,
                          memory_order_release);
    atomic_store_explicit(&state->desktop_width, capture->source_width,
                          memory_order_release);
    atomic_store_explicit(&state->desktop_height, capture->source_height,
                          memory_order_release);

    unsigned fps = reverse_get_fps(state->options->max_fps);
    AVCodecContext *encoder = reverse_open_encoder(state->options,
                                                   capture->target_width,
                                                   capture->target_height, fps);
    if (!encoder) {
        reverse_capture_destroy(capture);
        return false;
    }

    AVFrame *frame = av_frame_alloc();
    if (!frame) {
        LOG_OOM();
        avcodec_free_context(&encoder);
        reverse_capture_destroy(capture);
        return false;
    }
    frame->format = encoder->pix_fmt;
    frame->width = capture->target_width;
    frame->height = capture->target_height;
    int ret = av_frame_get_buffer(frame, 32);
    bool ok = ret >= 0;
    if (!ok) {
        LOGE("Could not allocate the reverse-display video frame: %d", ret);
    }

    sc_mutex_lock(&state->watchdog_mutex);
    sc_reverse_watchdog_begin(&state->watchdog, av_gettime_relative());
    sc_mutex_unlock(&state->watchdog_mutex);
    if (ok && !reverse_send_stream_header(state, capture)) {
        ok = false;
    }
    if (ok && !reverse_send_config(state, encoder)) {
        ok = false;
    }
    sc_mutex_lock(&state->watchdog_mutex);
    sc_reverse_watchdog_end(&state->watchdog);
    sc_mutex_unlock(&state->watchdog_mutex);

    atomic_store_explicit(&state->stream_ready, ok, memory_order_release);
    int64_t start_pts = av_gettime_relative();
    atomic_store_explicit(&state->stream_start_us, start_pts,
                          memory_order_release);
    int64_t pending_pts[REVERSE_DISPLAY_MAX_FRAMES_IN_FLIGHT];
    unsigned pending_count = 0;
    sc_tick frame_interval = SC_TICK_FREQ / fps;
    sc_tick next_capture = sc_tick_now();
    bool have_frame = false;
    while (ok && !atomic_load_explicit(&state->stopped, memory_order_acquire)) {
        if (atomic_load_explicit(&state->video_paused, memory_order_acquire)) {
            Sleep(20);
            next_capture = sc_tick_now();
            continue;
        }
        while (pending_count >= REVERSE_DISPLAY_MAX_FRAMES_IN_FLIGHT
                && !atomic_load_explicit(&state->stopped,
                                         memory_order_acquire)) {
            int64_t acked_pts = atomic_load_explicit(&state->last_acked_pts,
                                                     memory_order_acquire);
            unsigned consumed = 0;
            while (consumed < pending_count
                    && pending_pts[consumed] <= acked_pts) {
                ++consumed;
            }
            if (consumed) {
                pending_count -= consumed;
                memmove(pending_pts, pending_pts + consumed,
                        pending_count * sizeof(*pending_pts));
                break;
            }
            Sleep(1);
        }
        if (atomic_load_explicit(&state->stopped, memory_order_acquire)) {
            break;
        }

        if (atomic_load_explicit(&state->video_paused, memory_order_acquire)) {
            continue;
        }

        if (!reverse_wait_for_capture(state, next_capture)) {
            break;
        }
        // Pace capture from the end of the previous iteration. This prevents
        // a high-refresh monitor from outrunning the Android decoder and
        // accumulating stale frames in the transport/codec pipeline.
        next_capture = sc_tick_now() + frame_interval;

        enum reverse_capture_result result = reverse_capture_next(capture, frame);
        if (result == REVERSE_CAPTURE_TIMEOUT
                && (!have_frame || !atomic_load_explicit(&state->force_refresh,
                                                          memory_order_acquire))) {
            continue;
        }
        if (result == REVERSE_CAPTURE_ERROR) {
            ok = false;
            break;
        }
        have_frame = true;
        // A recreated Surface/WebCodecs decoder needs an independently decodable
        // IDR, not just another delta frame from the retained desktop image.
        // Consume atomically so a concurrent refresh request is not lost.
        bool refresh = atomic_exchange_explicit(&state->force_refresh, false,
                                                memory_order_acq_rel);
        frame->pict_type = refresh ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;

        // The timestamp is only used to preserve ordering on Android. Keep it
        // relative to this stream; host and device monotonic clocks have
        // unrelated epochs and must not be compared by MediaCodec.
        frame->pts = av_gettime_relative() - start_pts;
        int64_t sent_pts;
        sc_mutex_lock(&state->watchdog_mutex);
        sc_reverse_watchdog_begin(&state->watchdog, av_gettime_relative());
        sc_mutex_unlock(&state->watchdog_mutex);
        if (!reverse_encode_frame(state, encoder, frame, &sent_pts)) {
            ok = false;
        } else if (sent_pts != AV_NOPTS_VALUE) {
            assert(pending_count < REVERSE_DISPLAY_MAX_FRAMES_IN_FLIGHT);
            pending_pts[pending_count++] = sent_pts;
        }
        sc_mutex_lock(&state->watchdog_mutex);
        sc_reverse_watchdog_end(&state->watchdog);
        sc_mutex_unlock(&state->watchdog_mutex);
    }

    av_frame_free(&frame);
    avcodec_free_context(&encoder);
    reverse_capture_destroy(capture);
    return ok;
}

static bool
reverse_map_position(const struct reverse_display_state *state,
                     const struct sc_position *position, LONG *x, LONG *y) {
    int screen_width = position->screen_size.width;
    int screen_height = position->screen_size.height;
    int desktop_width = atomic_load_explicit(&state->desktop_width,
                                             memory_order_acquire);
    int desktop_height = atomic_load_explicit(&state->desktop_height,
                                              memory_order_acquire);
    if (screen_width <= 0 || screen_height <= 0 || desktop_width <= 0
            || desktop_height <= 0) {
        return false;
    }

    int desktop_left = atomic_load_explicit(&state->desktop_left,
                                            memory_order_acquire);
    int desktop_top = atomic_load_explicit(&state->desktop_top,
                                           memory_order_acquire);
    int64_t desktop_right = (int64_t) desktop_left + desktop_width - 1;
    int64_t desktop_bottom = (int64_t) desktop_top + desktop_height - 1;
    int64_t mapped_x = desktop_left
                     + (int64_t) position->point.x
                       * (desktop_width - 1) / (screen_width - 1 > 0
                                                 ? screen_width - 1 : 1);
    int64_t mapped_y = desktop_top
                     + (int64_t) position->point.y
                       * (desktop_height - 1) / (screen_height - 1 > 0
                                                  ? screen_height - 1 : 1);
    if (mapped_x < desktop_left) {
        mapped_x = desktop_left;
    } else if (mapped_x > desktop_right) {
        mapped_x = desktop_right;
    }
    if (mapped_y < desktop_top) {
        mapped_y = desktop_top;
    } else if (mapped_y > desktop_bottom) {
        mapped_y = desktop_bottom;
    }

    *x = (LONG) mapped_x;
    *y = (LONG) mapped_y;
    return true;
}

static uint32_t
reverse_touch_pressure(float pressure) {
    if (!(pressure > 0)) {
        return 0;
    }
    if (pressure >= 1) {
        return 1024;
    }
    return (uint32_t) (pressure * 1024);
}

static void
reverse_make_touch_info(const struct sc_reverse_touch_point *contact,
                        UINT pointer_flags, POINTER_TOUCH_INFO *info) {
    memset(info, 0, sizeof(*info));
    info->pointerInfo.pointerType = PT_TOUCH;
    info->pointerInfo.pointerId = (UINT32) contact->pointer_id;
    // POINTER_FLAG_PRIMARY is assigned by Windows for injected touch. Setting
    // it in the input frame makes InjectTouchInput reject the contact with
    // ERROR_INVALID_PARAMETER on current Windows builds.
    info->pointerInfo.pointerFlags = pointer_flags;
    info->pointerInfo.ptPixelLocation.x = contact->x;
    info->pointerInfo.ptPixelLocation.y = contact->y;
    info->pressure = contact->pressure;
    info->rcContact.left = contact->x - REVERSE_DISPLAY_TOUCH_CONTACT_RADIUS;
    info->rcContact.top = contact->y - REVERSE_DISPLAY_TOUCH_CONTACT_RADIUS;
    info->rcContact.right = contact->x + REVERSE_DISPLAY_TOUCH_CONTACT_RADIUS;
    info->rcContact.bottom = contact->y + REVERSE_DISPLAY_TOUCH_CONTACT_RADIUS;
    info->touchFlags = TOUCH_FLAG_NONE;
    info->touchMask = TOUCH_MASK_CONTACTAREA | TOUCH_MASK_PRESSURE;
}

static bool
reverse_send_mouse_event(const struct sc_reverse_touch_point *contact,
                         DWORD button_flags) {
    int virtual_left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int virtual_top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int virtual_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int virtual_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (virtual_width < 2 || virtual_height < 2) {
        LOGW("Could not determine the Windows virtual desktop bounds");
        return false;
    }

    int64_t x = (int64_t) contact->x - virtual_left;
    int64_t y = (int64_t) contact->y - virtual_top;
    if (x < 0) {
        x = 0;
    } else if (x > virtual_width - 1) {
        x = virtual_width - 1;
    }
    if (y < 0) {
        y = 0;
    } else if (y > virtual_height - 1) {
        y = virtual_height - 1;
    }

    INPUT input;
    memset(&input, 0, sizeof(input));
    input.type = INPUT_MOUSE;
    input.mi.dx = (LONG) (x * 65535 / (virtual_width - 1));
    input.mi.dy = (LONG) (y * 65535 / (virtual_height - 1));
    input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
                     | MOUSEEVENTF_VIRTUALDESK | button_flags;
    if (SendInput(1, &input, sizeof(input)) != 1) {
        LOGW("Could not inject the mouse fallback for Android touch: error %lu",
             (unsigned long) GetLastError());
        return false;
    }
    return true;
}

static enum sc_reverse_touch_result
reverse_touch_inject(void *userdata,
                     const struct sc_reverse_touch_frame *frame, unsigned count) {
    struct reverse_display_state *state = userdata;
    POINTER_TOUCH_INFO contacts[SC_REVERSE_TOUCH_LIMIT];
    for (unsigned i = 0; i < count; ++i) {
        UINT flags;
        switch (frame[i].phase) {
            case SC_TOUCH_PRESS:
                flags = POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE
                      | POINTER_FLAG_INCONTACT;
                break;
            case SC_TOUCH_UPDATE:
                flags = POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE
                      | POINTER_FLAG_INCONTACT;
                break;
            case SC_TOUCH_RELEASE:
                flags = POINTER_FLAG_UP;
                break;
            case SC_TOUCH_ABORT:
                flags = POINTER_FLAG_CANCELED | POINTER_FLAG_UP;
                break;
            default:
                return SC_TOUCH_FAILED;
        }
        reverse_make_touch_info(&frame[i].point, flags, &contacts[i]);
    }
    if (InjectTouchInput(count, contacts)) {
        return SC_TOUCH_OK;
    }
    DWORD error = GetLastError();
    if (error == ERROR_NOT_READY) {
        return SC_TOUCH_RETRY;
    }
    if (!state->touch_warning_logged) {
        LOGW("Windows touch frame failed (error %lu); cancelling this gesture",
             (unsigned long) error);
        state->touch_warning_logged = true;
    }
    switch (error) {
        case ERROR_TIMEOUT: return SC_TOUCH_TIMEOUT;
        case ERROR_INVALID_PARAMETER: return SC_TOUCH_INVALID;
        case ERROR_ACCESS_DENIED:
        case ERROR_NOT_SUPPORTED:
        case ERROR_CALL_NOT_IMPLEMENTED:
            return SC_TOUCH_UNAVAILABLE;
        default: return SC_TOUCH_FAILED;
    }
}

static void
reverse_touch_retry_wait(void *userdata) {
    (void) userdata;
    Sleep(1); // Bounded by the portable sender; no busy wait.
}

static bool
reverse_touch_mouse(void *userdata, const struct sc_reverse_touch_point *point,
                    enum sc_reverse_touch_phase phase) {
    (void) userdata;
    DWORD flags = phase == SC_TOUCH_PRESS ? MOUSEEVENTF_LEFTDOWN
                : phase == SC_TOUCH_RELEASE ? MOUSEEVENTF_LEFTUP : 0;
    return reverse_send_mouse_event(point, flags);
}

static bool
reverse_keyboard_modifier_down(uint16_t usage, void *userdata) {
    (void) userdata;
    static const WORD keys[] = {VK_LCONTROL,VK_LSHIFT,VK_LMENU,VK_LWIN,VK_RCONTROL,VK_RSHIFT,VK_RMENU,VK_RWIN};
    return usage>=224 && usage<=231 && (GetAsyncKeyState(keys[usage-224]) & 0x8000) != 0;
}

static size_t
reverse_keyboard_inject(const struct sc_windows_key_event *events, size_t count, void *userdata) {
    (void) userdata;
    if (!count || count > 2 * SC_REVERSE_TEXT_MAX) return 0;
    INPUT inputs[2 * SC_REVERSE_TEXT_MAX];
    for (size_t i = 0; i < count; ++i) inputs[i] = sc_windows_make_input(&events[i]);
    return SendInput((UINT) count, inputs, sizeof(INPUT));
}

// Called with touch_mutex held. No keys/text or OS error details enter IPC.
static void
reverse_keyboard_status(struct reverse_display_state *state, enum sc_windows_key_result result) {
    if (state->keyboard_status == result) return;
    state->keyboard_status = result;
    const char *status = result == SC_WINDOWS_KEY_OK ? "ready"
        : result == SC_WINDOWS_KEY_BLOCKED ? "blocked" : "unsupported";
    printf("DSKCPY_KEYBOARD_STATUS %s\n", status); fflush(stdout);
    if (result == SC_WINDOWS_KEY_BLOCKED)
        LOGW("Windows could not accept browser keyboard input; check the active app/desktop. No elevation is attempted");
}

static void
reverse_cancel_keyboard(struct reverse_display_state *state) {
    sc_mutex_lock(&state->touch_mutex);
    if (!sc_windows_keyboard_release(&state->keyboard)) reverse_keyboard_status(state, SC_WINDOWS_KEY_BLOCKED);
    sc_mutex_unlock(&state->touch_mutex);
}

static enum sc_clipboard_status reverse_clipboard_read(void *context, char *text, size_t *length) {
    return sc_windows_clipboard_read(((struct reverse_display_state *)context)->clipboard_window, text, length);
}
static bool reverse_clipboard_write(void *context, const char *text, size_t length) {
    return sc_windows_clipboard_write(((struct reverse_display_state *)context)->clipboard_window, text, length);
}
static bool reverse_clipboard_paste(void *context) {
    struct reverse_display_state *s = context;
    if (s->keyboard.blocked || s->keyboard.release_pending) return false;
    for (unsigned i = 0; i < 256; ++i) if (s->keyboard.down[i]) return false;
    for (unsigned i = 224; i <= 231; ++i) if (reverse_keyboard_modifier_down(i, NULL)) return false;
    enum sc_windows_key_result down = sc_windows_keyboard_key(&s->keyboard, 0, 25, 1);
    enum sc_windows_key_result up = sc_windows_keyboard_key(&s->keyboard, 1, 25, 0);
    if (down != SC_WINDOWS_KEY_OK || up != SC_WINDOWS_KEY_OK) {
        sc_windows_keyboard_release(&s->keyboard); reverse_keyboard_status(s, SC_WINDOWS_KEY_BLOCKED); return false;
    }
    return true;
}
static void reverse_receiver_on_clipboard(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *context) {
    (void)receiver; struct reverse_display_state *s = context;
    if (msg->reverse_clipboard.op == SC_CLIPBOARD_CANCEL) return;
    static const struct sc_reverse_clipboard_callbacks callbacks = {reverse_clipboard_read, reverse_clipboard_write, reverse_clipboard_paste};
    uint8_t output[8 + SC_REVERSE_CLIPBOARD_MAX];
    sc_mutex_lock(&s->touch_mutex);
    bool allowed = s->options->reverse_clipboard && s->options->reverse_keyboard && s->options->reverse_socket
        && s->clipboard_window && !atomic_load(&s->stopped) && !atomic_load(&s->fatal_error)
        && !atomic_load(&s->video_paused) && atomic_load(&s->stream_ready);
    size_t size = sc_reverse_clipboard_process(&msg->reverse_clipboard, allowed, &callbacks, s, output);
    sc_mutex_unlock(&s->touch_mutex);
    if (size && !atomic_load(&s->stopped)) {
        uint8_t header[16]; sc_write32be(header, (uint32_t)size); sc_write64be(header + 4, 0); sc_write32be(header + 12, SC_REVERSE_CLIPBOARD_PACKET);
        sc_mutex_lock(&s->send_mutex);
        bool sent = reverse_send_bytes(s->video_socket, header, sizeof(header)) && reverse_send_bytes(s->video_socket, output, size);
        sc_mutex_unlock(&s->send_mutex);
        if (!sent) atomic_store(&s->fatal_error, true);
    }
    memset(output, 0, sizeof(output));
}

static void
reverse_receiver_on_keyboard(struct sc_receiver *receiver, const struct sc_device_msg *msg, void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    sc_mutex_lock(&state->touch_mutex);
    // This recheck serializes injection against Stop and geometry cleanup.
    bool release = msg->type == DEVICE_MSG_TYPE_REVERSE_KEY && msg->reverse_key.action == 2;
    if (release || !state->options->reverse_keyboard || !state->options->reverse_socket
            || atomic_load_explicit(&state->stopped, memory_order_acquire)
            || atomic_load_explicit(&state->fatal_error, memory_order_acquire)
            || atomic_load_explicit(&state->video_paused, memory_order_acquire)
            || !atomic_load_explicit(&state->stream_ready, memory_order_acquire)) {
        bool cleared = release
            ? sc_windows_keyboard_key(&state->keyboard, 2, 0, 0) == SC_WINDOWS_KEY_OK
            : sc_windows_keyboard_release(&state->keyboard);
        if (!cleared) reverse_keyboard_status(state, SC_WINDOWS_KEY_BLOCKED);
        else if (release) state->keyboard_status = SC_WINDOWS_KEY_INVALID; // Report the next actual attempt again.
    } else {
        enum sc_windows_key_result result = msg->type == DEVICE_MSG_TYPE_REVERSE_KEY
            ? sc_windows_keyboard_key(&state->keyboard, msg->reverse_key.action, msg->reverse_key.usage, msg->reverse_key.modifiers)
            : sc_windows_keyboard_text(&state->keyboard, (const uint8_t *) msg->reverse_text.text, msg->reverse_text.length);
        reverse_keyboard_status(state, result);
    }
    sc_mutex_unlock(&state->touch_mutex);
}

static void
reverse_cancel_touches(struct reverse_display_state *state) {
    sc_mutex_lock(&state->touch_mutex);
    bool cleared = sc_reverse_touch_cancel(&state->touch);
    sc_mutex_unlock(&state->touch_mutex);
    if (!cleared) {
        LOGW("Windows touch cleanup did not complete; new gestures are blocked");
    }
}

// Called with touch_mutex held. Resolution/origin changes invalidate the
// gesture: old desktop coordinates must never be replayed on a new display.
static void
reverse_check_touch_geometry(struct reverse_display_state *state) {
    int left = atomic_load_explicit(&state->desktop_left, memory_order_acquire);
    int top = atomic_load_explicit(&state->desktop_top, memory_order_acquire);
    int width = atomic_load_explicit(&state->desktop_width, memory_order_acquire);
    int height = atomic_load_explicit(&state->desktop_height, memory_order_acquire);
    if (left != state->touch_left || top != state->touch_top
            || width != state->touch_width || height != state->touch_height) {
        sc_reverse_touch_cancel(&state->touch);
        if (!sc_windows_keyboard_release(&state->keyboard)) reverse_keyboard_status(state, SC_WINDOWS_KEY_BLOCKED);
        state->touch_left = left;
        state->touch_top = top;
        state->touch_width = width;
        state->touch_height = height;
    }
}

static void
reverse_inject_touch(struct reverse_display_state *state,
                     const struct sc_device_msg *msg) {
    enum sc_reverse_touch_action action;
    switch (msg->reverse_touch.action & AMOTION_EVENT_ACTION_MASK) {
        case AMOTION_EVENT_ACTION_DOWN: action = SC_TOUCH_DOWN; break;
        case AMOTION_EVENT_ACTION_POINTER_DOWN: action = SC_TOUCH_ADD; break;
        case AMOTION_EVENT_ACTION_MOVE: action = SC_TOUCH_MOVE; break;
        case AMOTION_EVENT_ACTION_UP:
        case AMOTION_EVENT_ACTION_POINTER_UP: action = SC_TOUCH_UP; break;
        case AMOTION_EVENT_ACTION_CANCEL: action = SC_TOUCH_CANCEL; break;
        default: return;
    }
    sc_mutex_lock(&state->touch_mutex);
    // Check after locking too: a main-thread Stop must not race a new DOWN.
    if (!atomic_load_explicit(&state->stopped, memory_order_acquire)
            && !atomic_load_explicit(&state->video_paused, memory_order_acquire)) {
        reverse_check_touch_geometry(state);
        LONG x = 0, y = 0;
        if (action == SC_TOUCH_CANCEL || action == SC_TOUCH_UP
                || reverse_map_position(state, &msg->reverse_touch.position, &x, &y)) {
            struct sc_reverse_touch_point point = {
                .pointer_id = msg->reverse_touch.pointer_id,
                .x = x, .y = y,
                .pressure = reverse_touch_pressure(msg->reverse_touch.pressure),
            };
            sc_reverse_touch_event(&state->touch, action, point, av_gettime_relative());
        }
    }
    sc_mutex_unlock(&state->touch_mutex);
}

static void
reverse_receiver_on_touch(struct sc_receiver *receiver,
                          const struct sc_device_msg *msg, void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    if (!atomic_load_explicit(&state->stopped, memory_order_acquire)
            && !atomic_load_explicit(&state->video_paused, memory_order_acquire)) {
        reverse_inject_touch(state, msg);
    }
}

static void
reverse_receiver_on_scroll(struct sc_receiver *receiver,
                           const struct sc_device_msg *msg, void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    if (atomic_load_explicit(&state->stopped, memory_order_acquire)
            || atomic_load_explicit(&state->video_paused, memory_order_acquire)) {
        return;
    }
    struct sc_reverse_touch_point point = {0};
    LONG x, y;
    if (!reverse_map_position(state, &msg->reverse_scroll.position, &x, &y)) {
        return;
    }
    point.x = x;
    point.y = y;
    reverse_cancel_touches(state);
    if (!reverse_send_mouse_event(&point, 0)) {
        return;
    }
    INPUT events[2] = {0};
    unsigned count = 0;
    // 40 viewport pixels correspond to one wheel detent (120 units).
    if (msg->reverse_scroll.dy) {
        events[count].type = INPUT_MOUSE;
        events[count].mi.dwFlags = MOUSEEVENTF_WHEEL;
        events[count++].mi.mouseData = (DWORD) (-msg->reverse_scroll.dy * 3);
    }
    if (msg->reverse_scroll.dx) {
        events[count].type = INPUT_MOUSE;
        events[count].mi.dwFlags = MOUSEEVENTF_HWHEEL;
        events[count++].mi.mouseData = (DWORD) (msg->reverse_scroll.dx * 3);
    }
    if (count && SendInput(count, events, sizeof(INPUT)) != count) {
        LOGW("Could not inject desktop scroll: error %lu", (unsigned long) GetLastError());
    }
}

static bool
reverse_send_key_chord(const WORD *keys, unsigned key_count) {
    assert(key_count > 0 && key_count <= 2);
    INPUT inputs[4];
    memset(inputs, 0, sizeof(inputs));
    for (unsigned i = 0; i < key_count; ++i) {
        inputs[i].type = INPUT_KEYBOARD;
        inputs[i].ki.wVk = keys[i];
        inputs[2 * key_count - 1 - i].type = INPUT_KEYBOARD;
        inputs[2 * key_count - 1 - i].ki.wVk = keys[i];
        inputs[2 * key_count - 1 - i].ki.dwFlags = KEYEVENTF_KEYUP;
    }

    UINT input_count = 2 * key_count;
    UINT sent = SendInput(input_count, inputs, sizeof(*inputs));
    if (sent != input_count) {
        LOGW("Could not inject Windows system key: error %lu",
             (unsigned long) GetLastError());
        return false;
    }
    return true;
}

static void
reverse_apply_system_action(struct reverse_display_state *state,
                            enum sc_reverse_system_action action) {
    switch (action) {
        case SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE:
        case SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE: {
            bool enabled = action == SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE;
            atomic_store_explicit(&state->audio_enabled, enabled, memory_order_release);
            sc_mutex_lock(&state->watchdog_mutex);
            sc_reverse_watchdog_set_paused(&state->audio_watchdog,
                !enabled || atomic_load_explicit(&state->video_paused, memory_order_acquire),
                av_gettime_relative());
            sc_mutex_unlock(&state->watchdog_mutex);
            LOGI("Phone audio %s", enabled ? "enabled" : "muted");
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_STOP_SESSION:
            // Explicit phone Stop is a normal end, not a transport failure.
            atomic_store_explicit(&state->stopped, true, memory_order_release);
            reverse_cancel_touches(state);
            sc_push_event(SDL_EVENT_QUIT);
            break;
        case SC_REVERSE_SYSTEM_ACTION_PAUSE_VIDEO:
            atomic_store_explicit(&state->video_paused, true, memory_order_release);
            sc_mutex_lock(&state->watchdog_mutex);
            sc_reverse_watchdog_set_paused(&state->watchdog, true, av_gettime_relative());
            sc_reverse_watchdog_set_paused(&state->audio_watchdog, true, av_gettime_relative());
            sc_mutex_unlock(&state->watchdog_mutex);
            reverse_cancel_touches(state);
            LOGI("Reverse display paused (Android background)");
            break;
        case SC_REVERSE_SYSTEM_ACTION_RESUME_VIDEO:
            sc_mutex_lock(&state->watchdog_mutex);
            sc_reverse_watchdog_set_paused(&state->watchdog, false, av_gettime_relative());
            sc_reverse_watchdog_set_paused(&state->audio_watchdog,
                !atomic_load_explicit(&state->audio_enabled, memory_order_acquire), av_gettime_relative());
            sc_mutex_unlock(&state->watchdog_mutex);
            atomic_store_explicit(&state->force_refresh, true, memory_order_release);
            atomic_store_explicit(&state->video_paused, false, memory_order_release);
            LOGI("Reverse display resumed (Android foreground)");
            break;
        case SC_REVERSE_SYSTEM_ACTION_VOLUME_DOWN: {
            const WORD keys[] = {VK_VOLUME_DOWN};
            reverse_send_key_chord(keys, ARRAY_LEN(keys));
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_VOLUME_UP: {
            const WORD keys[] = {VK_VOLUME_UP};
            reverse_send_key_chord(keys, ARRAY_LEN(keys));
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_VOLUME_MUTE: {
            const WORD keys[] = {VK_VOLUME_MUTE};
            reverse_send_key_chord(keys, ARRAY_LEN(keys));
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_MINIMIZE: {
            HWND window = GetForegroundWindow();
            if (window) {
                ShowWindowAsync(window, SW_MINIMIZE);
            }
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_MAXIMIZE_RESTORE: {
            HWND window = GetForegroundWindow();
            if (window) {
                ShowWindowAsync(window, IsZoomed(window) ? SW_RESTORE
                                                        : SW_MAXIMIZE);
            }
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_CLOSE: {
            const WORD keys[] = {VK_MENU, VK_F4};
            reverse_send_key_chord(keys, ARRAY_LEN(keys));
            break;
        }
        case SC_REVERSE_SYSTEM_ACTION_LOCK:
            if (!LockWorkStation()) {
                LOGW("Could not lock the Windows workstation: error %lu",
                     (unsigned long) GetLastError());
            }
            break;
        default:
            LOGW("Ignoring unknown reverse system action: %d", (int) action);
            break;
    }
}

static void
reverse_receiver_on_system_action(struct sc_receiver *receiver,
                                  const struct sc_device_msg *msg,
                                  void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    if (!atomic_load_explicit(&state->stopped, memory_order_acquire)) {
        if (msg->reverse_system_action.action != SC_REVERSE_SYSTEM_ACTION_AUDIO_ENABLE
                && msg->reverse_system_action.action != SC_REVERSE_SYSTEM_ACTION_AUDIO_DISABLE) reverse_cancel_keyboard(state);
        reverse_apply_system_action(state, msg->reverse_system_action.action);
    }
}

static void
reverse_receiver_on_frame_ack(struct sc_receiver *receiver,
                              const struct sc_device_msg *msg,
                              void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    int64_t pts = msg->reverse_frame_ack.pts;
    int64_t now = av_gettime_relative();
    sc_mutex_lock(&state->watchdog_mutex);
    bool accepted = sc_reverse_watchdog_ack(&state->watchdog, pts, now);
    sc_mutex_unlock(&state->watchdog_mutex);
    if (!accepted) {
        return;
    }

    atomic_store_explicit(&state->last_acked_pts, pts,
                          memory_order_release);

    int64_t start = atomic_load_explicit(&state->stream_start_us,
                                         memory_order_acquire);
    if (start > 0 && now - state->last_metrics_log_us >= 1000000) {
        int64_t age = now - start - pts;
        if (age >= 0) {
            LOGD("Reverse display capture-to-decode round-trip: %.1f ms",
                 age / 1000.0);
        }
        state->last_metrics_log_us = now;
    }
}

static void
reverse_receiver_on_audio_ack(struct sc_receiver *receiver,
                              const struct sc_device_msg *msg, void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    int64_t pts = msg->reverse_frame_ack.pts;
    sc_mutex_lock(&state->watchdog_mutex);
    bool accepted = sc_reverse_watchdog_ack(&state->audio_watchdog, pts, av_gettime_relative());
    sc_mutex_unlock(&state->watchdog_mutex);
    if (accepted) atomic_store_explicit(&state->audio_acked_pts, pts, memory_order_release);
}

static void
reverse_receiver_on_ended(struct sc_receiver *receiver, bool error,
                           void *userdata) {
    (void) receiver;
    struct reverse_display_state *state = userdata;
    // This callback runs on the input thread, after its last input message.
    // Run even during intentional shutdown: the phone may never send UP.
    reverse_cancel_touches(state);
    reverse_cancel_keyboard(state);
    if (atomic_load_explicit(&state->stopped, memory_order_acquire)) {
        return;
    }
    if (error) {
        atomic_store_explicit(&state->fatal_error, true, memory_order_release);
        sc_push_event(SC_EVENT_DEMUXER_ERROR);
    } else {
        sc_push_event(SC_EVENT_DEVICE_DISCONNECTED);
    }
}

static int
reverse_capture_thread(void *userdata) {
    struct reverse_display_state *state = userdata;
    sc_thread_set_priority(SC_THREAD_PRIORITY_HIGH);
    bool ok = reverse_capture_and_encode(state);
    if (!ok && !atomic_load_explicit(&state->stopped, memory_order_acquire)) {
        atomic_store_explicit(&state->fatal_error, true, memory_order_release);
        sc_push_event(SC_EVENT_DEMUXER_ERROR);
    }
    return 0;
}

// Only the GUI opts into pipe control; ordinary terminal stdin is untouched.
static HANDLE
reverse_gui_control_pipe(void) {
    char *mode = sc_get_env("SCRCPY_GUI_CONTROL");
    bool enabled = mode && !strcmp(mode, "stdin-v1");
    free(mode);
    HANDLE pipe = GetStdHandle(STD_INPUT_HANDLE);
    return enabled && pipe != INVALID_HANDLE_VALUE
        && GetFileType(pipe) == FILE_TYPE_PIPE ? pipe : INVALID_HANDLE_VALUE;
}

static bool
reverse_gui_stop_requested(HANDLE pipe) {
    if (pipe == INVALID_HANDLE_VALUE) {
        return false;
    }
    DWORD available;
    if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) {
        return true; // The owning GUI exited or closed its control pipe.
    }
    if (!available) {
        return false;
    }
    char command;
    DWORD count;
    return !ReadFile(pipe, &command, 1, &count, NULL)
        || !count || command == 'q';
}

enum scrcpy_exit_code
sc_reverse_display_run(sc_socket video_socket, sc_socket control_socket,
                        const struct scrcpy_options *options) {
    struct reverse_display_state state = {
        .video_socket = video_socket,
        .control_socket = control_socket,
        .options = options,
    };
    atomic_init(&state.stopped, false);
    atomic_init(&state.fatal_error, false);
    atomic_init(&state.video_paused, false);
    atomic_init(&state.force_refresh, false);
    atomic_init(&state.stream_ready, false);
    atomic_init(&state.audio_enabled, false); // Old phones receive video only.
    atomic_init(&state.audio_acked_pts, -1);
    atomic_init(&state.desktop_left, 0);
    atomic_init(&state.desktop_top, 0);
    atomic_init(&state.desktop_width, 0);
    atomic_init(&state.desktop_height, 0);
    atomic_init(&state.last_acked_pts, -1);
    atomic_init(&state.stream_start_us, 0);
    sc_reverse_watchdog_init(&state.watchdog);
    sc_reverse_watchdog_init(&state.audio_watchdog);
    state.audio_watchdog.paused = true;
    if (!sc_mutex_init(&state.watchdog_mutex)) {
        return SCRCPY_EXIT_FAILURE;
    }
    if (!sc_mutex_init(&state.send_mutex)) {
        sc_mutex_destroy(&state.watchdog_mutex);
        return SCRCPY_EXIT_FAILURE;
    }
    if (!sc_mutex_init(&state.touch_mutex)) {
        sc_mutex_destroy(&state.send_mutex);
        sc_mutex_destroy(&state.watchdog_mutex);
        return SCRCPY_EXIT_FAILURE;
    }
    sc_windows_keyboard_init(&state.keyboard, reverse_keyboard_inject, reverse_keyboard_modifier_down, NULL);
    HANDLE gui_control = reverse_gui_control_pipe();
    bool native_touch = InitializeTouchInjection(SC_REVERSE_TOUCH_LIMIT,
                                                TOUCH_FEEDBACK_NONE);
    if (!native_touch) {
        LOGW("Could not initialize Windows touch injection: error %lu; "
             "using mouse fallback for primary Android touch",
             (unsigned long) GetLastError());
    }
    static const struct sc_reverse_touch_callbacks touch_callbacks = {
        .inject = reverse_touch_inject,
        .retry_wait = reverse_touch_retry_wait,
        .mouse = reverse_touch_mouse,
    };
    sc_reverse_touch_init(&state.touch, !native_touch, &touch_callbacks, &state);

    // The control socket is already configured by the server setup. Apply
    // the same low-latency TCP setting to the custom video stream.
    bool nodelay = net_set_tcp_nodelay(video_socket, true);
    (void) nodelay; // net_set_tcp_nodelay() logs its own error.
    bool send_buffer = net_set_socket_send_buffer(
        video_socket, REVERSE_DISPLAY_VIDEO_SEND_BUFFER);
    (void) send_buffer; // net_set_socket_send_buffer() logs its own error.

    static const struct sc_receiver_callbacks receiver_cbs = {
        .on_ended = reverse_receiver_on_ended,
        .on_reverse_keyboard = reverse_receiver_on_keyboard,
        .on_reverse_clipboard = reverse_receiver_on_clipboard,
        .on_reverse_touch = reverse_receiver_on_touch,
        .on_reverse_scroll = reverse_receiver_on_scroll,
        .on_reverse_frame_ack = reverse_receiver_on_frame_ack,
        .on_reverse_system_action = reverse_receiver_on_system_action,
        .on_reverse_audio_ack = reverse_receiver_on_audio_ack,
    };
    if (!sc_receiver_init(&state.receiver, control_socket, &receiver_cbs,
                          &state)) {
        sc_mutex_destroy(&state.touch_mutex);
        sc_mutex_destroy(&state.watchdog_mutex);
        sc_mutex_destroy(&state.send_mutex);
        return SCRCPY_EXIT_FAILURE;
    }

    if (options->reverse_clipboard) state.clipboard_window = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandleW(NULL), NULL);
    bool receiver_started = false;
    bool ok = sc_receiver_start(&state.receiver);
    if (ok) {
        receiver_started = true;
        ok = sc_thread_create(&state.capture_thread, reverse_capture_thread,
                              "reverse-capture", &state);
        state.capture_thread_started = ok;
        if (ok && options->reverse_audio) {
            state.audio_thread_started = sc_thread_create(&state.audio_thread,
                reverse_audio_thread, "reverse-audio", &state);
            if (!state.audio_thread_started) LOGW("Desktop audio worker unavailable; video continues");
        }
    }

    enum scrcpy_exit_code ret = SCRCPY_EXIT_FAILURE;
    if (!ok) {
        LOGE("Could not start reverse-display worker threads");
    } else {
        for (;;) {
            if (reverse_gui_stop_requested(gui_control)) {
                ret = SCRCPY_EXIT_SUCCESS;
                goto stop;
            }
            sc_mutex_lock(&state.watchdog_mutex);
            bool expired = sc_reverse_watchdog_expired(
                &state.watchdog, av_gettime_relative())
                || sc_reverse_watchdog_expired(&state.audio_watchdog, av_gettime_relative());
            sc_mutex_unlock(&state.watchdog_mutex);
            if (expired) {
                LOGE("Reverse display stalled for 10 seconds. "
                     "Check the phone and reconnect the stream.");
                goto stop;
            }
            sc_mutex_lock(&state.touch_mutex);
            reverse_check_touch_geometry(&state);
            if (state.keyboard.release_pending && av_gettime_relative() >= state.keyboard_cleanup_after) {
                state.keyboard_cleanup_after = av_gettime_relative() + 250000;
                if (!sc_windows_keyboard_release(&state.keyboard)) reverse_keyboard_status(&state, SC_WINDOWS_KEY_BLOCKED);
            }
            if (!atomic_load_explicit(&state.stopped, memory_order_acquire)
                    && !atomic_load_explicit(&state.video_paused, memory_order_acquire)) {
                sc_reverse_touch_tick(&state.touch, av_gettime_relative());
            }
            sc_mutex_unlock(&state.touch_mutex);
            SDL_Event event;
            if (!SDL_WaitEventTimeout(&event, 20)) {
                if (atomic_load_explicit(&state.fatal_error,
                                         memory_order_acquire)) {
                    break;
                }
                continue;
            }

            switch (event.type) {
                case SDL_EVENT_QUIT:
                    ret = SCRCPY_EXIT_SUCCESS;
                    goto stop;
                case SC_EVENT_DEVICE_DISCONNECTED:
                    ret = SCRCPY_EXIT_DISCONNECTED;
                    goto stop;
                case SC_EVENT_DEMUXER_ERROR:
                    ret = SCRCPY_EXIT_FAILURE;
                    goto stop;
                default:
                    // Reverse display has no SDL window. Keep unrelated
                    // events available to the rest of the application.
                    break;
            }
        }
    }

stop:
    atomic_store_explicit(&state.stopped, true, memory_order_release);
    net_interrupt(video_socket);
    net_interrupt(control_socket);

    if (receiver_started) {
        sc_receiver_join(&state.receiver);
    }
    if (state.capture_thread_started) {
        sc_thread_join(&state.capture_thread, NULL);
    }
    if (state.audio_thread_started) sc_thread_join(&state.audio_thread, NULL);
    reverse_cancel_touches(&state); // Also covers worker-start failures.
    reverse_cancel_keyboard(&state);
    sc_receiver_destroy(&state.receiver);
    if (state.clipboard_window) DestroyWindow(state.clipboard_window);
    sc_mutex_destroy(&state.touch_mutex);
    sc_mutex_destroy(&state.watchdog_mutex);
    sc_mutex_destroy(&state.send_mutex);

    return ret;
}

#elif defined(HAVE_REVERSE_MACOS)

enum scrcpy_exit_code
sc_reverse_display_run(sc_socket video_socket, sc_socket control_socket,
                        const struct scrcpy_options *options) {
    return sc_reverse_display_macos_run(video_socket, control_socket, options);
}

#else

enum scrcpy_exit_code
sc_reverse_display_run(sc_socket video_socket, sc_socket control_socket,
                        const struct scrcpy_options *options) {
    (void) video_socket;
    (void) control_socket;
    (void) options;
    LOGE("--reverse-display needs Windows or an experimental macOS build");
    return SCRCPY_EXIT_FAILURE;
}

#endif // _WIN32
