#include <assert.h>
#include <string.h>
#include <stdio.h>
#include "reverse_windows_keyboard.h"
#ifdef _WIN32
#include "reverse_windows_input.h"
#endif
struct sink { struct sc_windows_key_event events[4096];size_t count;bool fail, fail_cleanup;bool physical[8];size_t partial; };
static size_t inject(const struct sc_windows_key_event *events,size_t count,void *userdata) {
    struct sink *sink=userdata;size_t accepted=sink->fail?0:sink->partial&&sink->partial<count?sink->partial:count;
    if(sink->partial&&sink->fail_cleanup)sink->fail=true;
    sink->partial=0;assert(sink->count+accepted<=4096);
    memcpy(sink->events+sink->count,events,accepted*sizeof(*events));sink->count+=accepted;return accepted;
}
static bool modifier_down(uint16_t usage,void *userdata) {
    struct sink *sink=userdata;assert(usage>=224&&usage<=231);return sink->physical[usage-224];
}
int main(void) {
    struct sink sink={0};struct sc_windows_keyboard state;sc_windows_keyboard_init(&state,inject,modifier_down,&sink);
    struct sc_windows_key_event event;
    for(unsigned usage=4;usage<=115;usage++)assert(sc_windows_keyboard_mapping(usage,&event)==(usage!=102));
    for(unsigned usage=224;usage<=231;usage++)assert(sc_windows_keyboard_mapping(usage,&event));
    assert(!sc_windows_keyboard_mapping(0xffff,&event));
    sc_windows_keyboard_mapping(79,&event);assert(event.code==0x4d&&event.extended);
    sc_windows_keyboard_mapping(228,&event);assert(event.code==0x1d&&event.extended);
    sc_windows_keyboard_mapping(224,&event);assert(event.code==0x1d&&!event.extended);
    // Keep Num Lock distinct from Pause with its explicit virtual-key form.
    sc_windows_keyboard_mapping(83,&event);assert(event.kind==SC_WINDOWS_VIRTUAL&&event.code==0x90);
    assert(sc_windows_keyboard_key(&state,0,224,1)==SC_WINDOWS_KEY_OK);
    assert(sc_windows_keyboard_key(&state,0,4,1)==SC_WINDOWS_KEY_OK);
    assert(sc_windows_keyboard_key(&state,0,4,1)==SC_WINDOWS_KEY_OK); // Repeat.
    assert(sink.count==3&&state.down[224]&&state.down[4]);
    assert(sc_windows_keyboard_key(&state,1,224,0)==SC_WINDOWS_KEY_OK);
    assert(sc_windows_keyboard_key(&state,1,4,0)==SC_WINDOWS_KEY_OK);
    assert(!state.down[224]&&!state.down[4]);
    size_t before=sink.count;
    assert(sc_windows_keyboard_key(&state,0,79,2)==SC_WINDOWS_KEY_OK);
    assert(state.down[225]&&state.down[79]);
    assert(sc_windows_keyboard_key(&state,1,79,0)==SC_WINDOWS_KEY_OK);
    assert(!state.down[225]&&!state.down[79]);assert(sink.count==before+4);
    assert(sc_windows_keyboard_key(&state,0,230,4)==SC_WINDOWS_KEY_OK);
    assert(state.down[230]&&!state.down[226]);assert(sc_windows_keyboard_release(&state));
    const uint8_t text[]={0x63,0x61,0x66,0xc3,0xa9,0x20,0xe4,0xb8,0x96,0xe7,0x95,0x8c,0x20,0xf0,0x9f,0x98,0x8a};
    before=sink.count;assert(sc_windows_keyboard_text(&state,text,sizeof(text))==SC_WINDOWS_KEY_OK);
    assert(sink.events[sink.count-4].code==0xd83d&&sink.events[sink.count-2].code==0xde0a);
    for(size_t i=before;i<sink.count;i+=2){assert(sink.events[i].kind==SC_WINDOWS_UNICODE&&!sink.events[i].up);assert(sink.events[i+1].up&&sink.events[i].code==sink.events[i+1].code);}
    const uint8_t bad[]={0xed,0xa0,0x80};before=sink.count;
    assert(sc_windows_keyboard_text(&state,bad,sizeof(bad))==SC_WINDOWS_KEY_INVALID);assert(sink.count==before);
    assert(sc_windows_keyboard_key(&state,0,224,1)==SC_WINDOWS_KEY_OK);
    sink.fail=true;assert(!sc_windows_keyboard_release(&state));assert(state.down[224]&&state.release_pending);
    assert(sc_windows_keyboard_key(&state,0,5,1)==SC_WINDOWS_KEY_BLOCKED);assert(!state.down[5]);
    sink.fail=false;assert(sc_windows_keyboard_release(&state));assert(!state.down[224]&&!state.release_pending);
    assert(state.blocked);assert(sc_windows_keyboard_key(&state,2,0,0)==SC_WINDOWS_KEY_OK);assert(!state.blocked);
    sink.partial=1;before=sink.count;
    assert(sc_windows_keyboard_text(&state,(const uint8_t *)"ab",2)==SC_WINDOWS_KEY_BLOCKED);
    assert(sink.count==before+2&&sink.events[before].code=='a'&&!sink.events[before].up&&sink.events[before+1].up);
    assert(!state.unicode_pending);assert(state.blocked); // No replay of accepted text and balanced cleanup.
    assert(sc_windows_keyboard_key(&state,2,0,1)==SC_WINDOWS_KEY_INVALID);
    assert(sc_windows_keyboard_key(&state,0,102,0)==SC_WINDOWS_KEY_BLOCKED);
    assert(sc_windows_keyboard_key(&state,2,0,0)==SC_WINDOWS_KEY_OK);
    assert(sc_windows_keyboard_key(&state,0,102,0)==SC_WINDOWS_KEY_UNSUPPORTED);
    // Never release an externally held modifier or type under an unexpected one.
    sink.physical[0]=true;before=sink.count;
    assert(sc_windows_keyboard_key(&state,0,4,1)==SC_WINDOWS_KEY_OK);
    assert(!state.down[224]&&state.down[4]);
    assert(sc_windows_keyboard_key(&state,1,4,0)==SC_WINDOWS_KEY_OK);
    assert(sink.count==before+2&&sink.events[before].code==0x1e);
    before=sink.count;assert(sc_windows_keyboard_text(&state,(const uint8_t *)"x",1)==SC_WINDOWS_KEY_BLOCKED);
    assert(sink.count==before);sink.physical[0]=false;assert(sc_windows_keyboard_key(&state,2,0,0)==SC_WINDOWS_KEY_OK);
    // A rejected Unicode key-up remains owned until cleanup actually succeeds.
    sink.partial=1;sink.fail_cleanup=true;
    assert(sc_windows_keyboard_text(&state,(const uint8_t *)"ab",2)==SC_WINDOWS_KEY_BLOCKED);
    assert(state.unicode_pending&&state.release_pending&&state.blocked);
    before=sink.count;assert(sc_windows_keyboard_key(&state,0,5,0)==SC_WINDOWS_KEY_BLOCKED);assert(sink.count==before);
    sink.fail=false;sink.fail_cleanup=false;assert(sc_windows_keyboard_key(&state,2,0,0)==SC_WINDOWS_KEY_OK);
    assert(!state.unicode_pending&&!state.blocked&&!state.release_pending);
    uint8_t maximum[512];memset(maximum,'x',sizeof(maximum));before=sink.count;
    assert(sc_windows_keyboard_text(&state,maximum,sizeof(maximum))==SC_WINDOWS_KEY_OK);assert(sink.count==before+1024);

#ifdef _WIN32
    sc_windows_keyboard_mapping(79,&event);INPUT input=sc_windows_make_input(&event);
    assert(input.type==INPUT_KEYBOARD&&input.ki.wVk==0&&input.ki.wScan==0x4d);
    assert(input.ki.dwFlags==(KEYEVENTF_SCANCODE|KEYEVENTF_EXTENDEDKEY));
    event=(struct sc_windows_key_event){.kind=SC_WINDOWS_UNICODE,.code=0xd83d,.up=true};input=sc_windows_make_input(&event);
    assert(input.ki.wVk==0&&input.ki.wScan==0xd83d&&input.ki.dwFlags==(KEYEVENTF_UNICODE|KEYEVENTF_KEYUP));
    sc_windows_keyboard_mapping(83,&event);input=sc_windows_make_input(&event);
    assert(input.ki.wVk==VK_NUMLOCK&&input.ki.wScan==0x45&&input.ki.dwFlags==KEYEVENTF_EXTENDEDKEY);
    event.up=true;input=sc_windows_make_input(&event);
    assert(input.ki.dwFlags==(KEYEVENTF_EXTENDEDKEY|KEYEVENTF_KEYUP));
    HKL layouts[16];int layout_count=GetKeyboardLayoutList(16,layouts);bool checked=false;
    for(int i=0;i<layout_count;i++)if(((uintptr_t)layouts[i]&0xffff)==0x0409){
        const struct {UINT vk;uint16_t usage;} pairs[]={
            {'A',4},{VK_RIGHT,79},{VK_LEFT,80},{VK_DELETE,76},{VK_RCONTROL,228},{VK_RMENU,230},{VK_LWIN,227},{VK_F11,68}};
        assert((MapVirtualKeyExW(VK_NUMLOCK,MAPVK_VK_TO_VSC_EX,layouts[i])&0xff)==0x45);
        bool mappings_match=true;
        for(size_t j=0;j<sizeof(pairs)/sizeof(pairs[0]);j++){
            UINT scan=MapVirtualKeyExW(pairs[j].vk,MAPVK_VK_TO_VSC_EX,layouts[i]);
            assert(sc_windows_keyboard_mapping(pairs[j].usage,&event));
            UINT planned=event.code|(event.extended?0xe000:0);
            UINT translated=MapVirtualKeyExW(planned,MAPVK_VSC_TO_VK_EX,layouts[i]);
            // The CI desktop returns base-only VK_TO_VSC_EX codes for arrows.
            // Check the base code AND reverse translation of our full input
            // instead: dropping E0 must not turn an arrow into a keypad key.
            if(event.code!=(scan&0xff)||translated!=pairs[j].vk){
                fprintf(stderr,"Mapping mismatch: usage=%u vk=%u native=%04x planned=%04x reverse=%u\n",(unsigned)pairs[j].usage,pairs[j].vk,scan,planned,translated);
                mappings_match=false;
            }
        }
        assert(mappings_match);
        checked=true;break;
    }
    puts(checked?"Windows scan mappings checked without posting input":"US-layout comparison skipped; no layouts installed by test");

#endif
    return 0;
}
