#include <assert.h>
#include <string.h>
#include <stdlib.h>
#include "reverse_h264.h"

// Generated blue 16x16 baseline IDR (lavfi/libx264), stripped of all SEI/AUD.
// No real screen, user-owned video, capture or OS input is accessed.
static const uint8_t sample[] = {
  0,0,0,1,0x67,0x42,0xc0,0x1e,0xda,0x7b,0x01,0x10,0,0,3,0,0x10,0,0,3,0,0x28,0xf1,0x62,0xea,
  0,0,0,1,0x68,0xce,0x0f,0xc8,
  0,0,0,1,0x65,0x88,0x84,0x3a,0x11,0x8a,0,0x02,0x31,0x71,0xc0,0,0x43,0xca,0x38,0,0x08,0x05,0xe0,
};
int main(void) {
    uint8_t profile[3];
    assert(sc_reverse_h264_profile(sample, sizeof(sample), profile));
    assert(!memcmp(profile, (uint8_t[]){0x42,0xc0,0x1e}, 3));
    assert(sc_reverse_h264_validate(NULL,0,sample,sizeof(sample),16,16,profile));
    assert(sc_reverse_h264_validate(sample,33,sample+33,sizeof(sample)-33,16,16,profile));
    static const uint8_t cropped[] = {
      0,0,0,1,0x67,0x42,0xc0,0x1e,0xda,0x7f,0x93,0x01,0x10,0,0,3,0,0x10,0,0,3,0,0x28,0xf1,0x62,0xea,
      0,0,0,1,0x68,0xce,0x0f,0xc8,
      0,0,0,1,0x65,0x88,0x84,0x3a,0x11,0x8a,0,0x02,0x31,0x71,0xc0,0,0x43,0xca,0x38,0,0x08,0x05,0xe0,
    };
    assert(sc_reverse_h264_validate(NULL,0,cropped,sizeof(cropped),16,10,profile));
    assert(!sc_reverse_h264_validate(NULL,0,sample,sizeof(sample),32,16,profile));
    assert(!sc_reverse_h264_validate(NULL,0,sample,sizeof(sample),16,16,(uint8_t[]){0x64,0,0x1e}));
    assert(!sc_reverse_h264_validate(NULL,0,sample+33,sizeof(sample)-33,16,16,profile));
    assert(!sc_reverse_h264_validate(sample,65537,sample,sizeof(sample),16,16,profile));
    assert(!sc_reverse_h264_validate(NULL,0,sample,16u*1024u*1024u+1,16,16,profile));
    assert(!sc_reverse_h264_validate(NULL,0,sample,sizeof(sample),0,16,profile));
    assert(!sc_reverse_h264_profile(NULL,0,profile));
    uint8_t *parameters;size_t size;
    assert(sc_reverse_h264_parameters(sample,33,sample,sizeof(sample),&parameters,&size));
    assert(size==33 && !memcmp(parameters,sample,size));free(parameters);
    assert(!sc_reverse_h264_parameters(NULL,0,sample+33,sizeof(sample)-33,&parameters,&size));
    assert(!parameters && !size);
    uint8_t delta[sizeof(sample)];memcpy(delta,sample,sizeof(sample));delta[37]=0x41;
    assert(!sc_reverse_h264_validate(NULL,0,delta,sizeof(delta),16,16,profile));
    assert(!sc_reverse_h264_validate(sample,sizeof(sample),delta+33,sizeof(delta)-33,16,16,profile));
    return 0;
}
