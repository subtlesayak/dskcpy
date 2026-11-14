#include <assert.h>
#include "reverse_quality.h"
struct sink { bool fail; unsigned calls; uint32_t rate; };
static bool apply(uint32_t rate, void *context) {
 struct sink *s=context; s->calls++;
 if(s->fail) return false;
 s->rate=rate;return true;
}
int main(void) {
 struct sc_reverse_quality q;
 assert(sc_reverse_quality_target(60,12000000,0,&q) && q.fps==60 && q.bit_rate==12000000);
 assert(sc_reverse_quality_target(60,12000000,1,&q) && q.fps==30 && q.bit_rate==7200000);
 assert(sc_reverse_quality_target(60,12000000,2,&q) && q.fps==15 && q.bit_rate==3600000);
 for(unsigned fps=1;fps<=240;fps++) for(unsigned level=0;level<3;level++) {
  assert(sc_reverse_quality_target(fps,500000,level,&q));assert(q.fps<=fps && q.bit_rate<=500000);
 }
 assert(!sc_reverse_quality_target(0,12000000,0,&q));
 assert(!sc_reverse_quality_target(241,12000000,0,&q));
 assert(!sc_reverse_quality_target(60,UINT32_MAX,0,&q));
 assert(!sc_reverse_quality_target(60,12000000,3,&q));
 struct sink s={0};q=(struct sc_reverse_quality){60,12000000};
 assert(sc_reverse_quality_apply(60,12000000,1,apply,&s,&q));assert(q.fps==30&&s.rate==7200000);
 s.fail=true;assert(!sc_reverse_quality_apply(60,12000000,2,apply,&s,&q));assert(q.fps==30&&q.bit_rate==7200000&&s.rate==7200000);
 unsigned count=s.calls;assert(!sc_reverse_quality_apply(60,12000000,3,apply,&s,&q));assert(s.calls==count);
 return 0;
}
