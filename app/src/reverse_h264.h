#ifndef SC_REVERSE_H264_H
#define SC_REVERSE_H264_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Annex-B only. No pictures, decoder state or application data are retained.
bool sc_reverse_h264_profile(const uint8_t *bytes, size_t size, uint8_t profile[3]);
// Caller frees the returned SPS/PPS-only buffer. No picture bytes are retained.
bool sc_reverse_h264_parameters(const uint8_t *config, size_t config_size,
                               const uint8_t *picture, size_t picture_size,
                               uint8_t **parameters, size_t *parameters_size);
bool sc_reverse_h264_validate(const uint8_t *config, size_t config_size,
                             const uint8_t *picture, size_t picture_size,
                             unsigned width, unsigned height,
                             const uint8_t expected_profile[3]);
#endif
