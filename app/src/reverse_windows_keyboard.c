#include "reverse_windows_keyboard.h"
#include "reverse_keyboard.h"
#include <string.h>

#define EXT(scan) (0x100u | (scan))
bool sc_windows_keyboard_mapping(uint16_t usage, struct sc_windows_key_event *event) {
    // HID keyboard-page physical usages -> PC set-1 scan codes. Extended
    // navigation/keypad/modifier keys retain their E0 distinction.
    static const uint16_t codes[256] = {
        [4]=0x1e,[5]=0x30,[6]=0x2e,[7]=0x20,[8]=0x12,[9]=0x21,[10]=0x22,[11]=0x23,
        [12]=0x17,[13]=0x24,[14]=0x25,[15]=0x26,[16]=0x32,[17]=0x31,[18]=0x18,[19]=0x19,
        [20]=0x10,[21]=0x13,[22]=0x1f,[23]=0x14,[24]=0x16,[25]=0x2f,[26]=0x11,[27]=0x2d,[28]=0x15,[29]=0x2c,
        [30]=0x02,[31]=0x03,[32]=0x04,[33]=0x05,[34]=0x06,[35]=0x07,[36]=0x08,[37]=0x09,[38]=0x0a,[39]=0x0b,
        [40]=0x1c,[41]=0x01,[42]=0x0e,[43]=0x0f,[44]=0x39,[45]=0x0c,[46]=0x0d,[47]=0x1a,[48]=0x1b,[49]=0x2b,[50]=0x2b,
        [51]=0x27,[52]=0x28,[53]=0x29,[54]=0x33,[55]=0x34,[56]=0x35,[57]=0x3a,
        [58]=0x3b,[59]=0x3c,[60]=0x3d,[61]=0x3e,[62]=0x3f,[63]=0x40,[64]=0x41,[65]=0x42,[66]=0x43,[67]=0x44,[68]=0x57,[69]=0x58,
        [71]=0x46,[73]=EXT(0x52),[74]=EXT(0x47),[75]=EXT(0x49),[76]=EXT(0x53),[77]=EXT(0x4f),[78]=EXT(0x51),
        [79]=EXT(0x4d),[80]=EXT(0x4b),[81]=EXT(0x50),[82]=EXT(0x48),[83]=EXT(0x45),[84]=EXT(0x35),[85]=0x37,[86]=0x4a,[87]=0x4e,
        [88]=EXT(0x1c),[89]=0x4f,[90]=0x50,[91]=0x51,[92]=0x4b,[93]=0x4c,[94]=0x4d,[95]=0x47,[96]=0x48,[97]=0x49,[98]=0x52,[99]=0x53,[100]=0x56,[101]=EXT(0x5d),
        [224]=0x1d,[225]=0x2a,[226]=0x38,[227]=EXT(0x5b),[228]=EXT(0x1d),[229]=0x36,[230]=EXT(0x38),[231]=EXT(0x5c),
    };
    *event = (struct sc_windows_key_event){0};
    if (usage < 256 && codes[usage]) {
        event->kind=SC_WINDOWS_SCAN; event->code=codes[usage]&0xff; event->extended=(codes[usage]&0x100)!=0; return true;
    }
    // These Windows virtual keys have multi-byte or non-PC set-1 sequences.
    event->kind=SC_WINDOWS_VIRTUAL;
    if (usage==70) event->code=0x2c; // VK_SNAPSHOT
    else if (usage==72) event->code=0x13; // VK_PAUSE
    else if (usage==103) event->code=0x92; // VK_OEM_NEC_EQUAL
    else if (usage>=104 && usage<=115) event->code=(uint16_t)(0x7c+usage-104); // VK_F13..VK_F24
    else return false; // No power/eject or unnegotiated application actions.
    return true;
}
#undef EXT

void sc_windows_keyboard_init(struct sc_windows_keyboard *state, sc_windows_key_sink inject, sc_windows_modifier_state modifier_down, void *userdata) {
    memset(state,0,sizeof(*state)); state->inject=inject;state->modifier_down=modifier_down;state->userdata=userdata;
}
static bool emit(struct sc_windows_keyboard *s, uint16_t usage, bool up) {
    struct sc_windows_key_event event;
    if (!sc_windows_keyboard_mapping(usage,&event)) return false;
    event.up=up;
    // An already-held host modifier is borrowed, never added to our release
    // ledger. This query is restricted to the eight modifiers, not typed keys.
    if (!up && usage>=224 && usage<=231 && !s->down[usage] && s->modifier_down
            && s->modifier_down(usage,s->userdata)) return true;
    if (s->inject(&event,1,s->userdata)!=1) return false;
    s->down[usage]=!up; return true;
}
bool sc_windows_keyboard_release(struct sc_windows_keyboard *s) {
    bool ok=true;
    if (s->unicode_pending) {
        struct sc_windows_key_event event={.kind=SC_WINDOWS_UNICODE,.code=s->unicode_unit,.up=true};
        if (s->inject(&event,1,s->userdata)==1) s->unicode_pending=false; else ok=false;
    }
    // Release ordinary keys before their modifiers. Retain failed ownership
    // for a later cleanup attempt; never release a key we did not inject.
    for(unsigned phase=0;phase<2;phase++) for(unsigned usage=4;usage<256;usage++) {
        bool modifier=usage>=224&&usage<=231;
        if(s->down[usage]&&modifier==(phase!=0)&&!emit(s,usage,true))ok=false;
    }
    s->release_pending=!ok;if(!ok)s->blocked=true;return ok;
}
static bool external_modifiers_match(struct sc_windows_keyboard *s,uint8_t mask) {
    if (!s->modifier_down) return true;
    for (unsigned usage=224;usage<=231;usage++) {
        unsigned group=(usage-224)%4;
        if (!s->down[usage] && s->modifier_down((uint16_t)usage,s->userdata)
                && !(mask&((1u<<group)|(1u<<(group+4))))) return false;
    }
    return true;
}
static bool modifiers(struct sc_windows_keyboard *s,uint8_t mask) {
    for(unsigned group=0;group<4;group++) {
        unsigned left=224+group,right=228+group;
        bool wanted=(mask&((1u<<group)|(1u<<(group+4))))!=0;
        if(wanted&&!s->down[left]&&!s->down[right]) {
            unsigned usage=(mask&(1u<<group))?left:right;
            if(!emit(s,(uint16_t)usage,false))return false;
        } else if(!wanted) {
            if(s->down[left]&&!emit(s,(uint16_t)left,true))return false;
            if(s->down[right]&&!emit(s,(uint16_t)right,true))return false;
        }
    }
    return true;
}
static enum sc_windows_key_result blocked(struct sc_windows_keyboard *s) {
    s->blocked=true;sc_windows_keyboard_release(s);return SC_WINDOWS_KEY_BLOCKED;
}
enum sc_windows_key_result sc_windows_keyboard_key(struct sc_windows_keyboard *s,uint8_t action,uint16_t usage,uint8_t mask) {
    if(action>2||(action==2&&(usage||mask)))return SC_WINDOWS_KEY_INVALID;
    if(action==2){if(!sc_windows_keyboard_release(s))return SC_WINDOWS_KEY_BLOCKED;s->blocked=false;return SC_WINDOWS_KEY_OK;}
    if(s->blocked)return SC_WINDOWS_KEY_BLOCKED;
    struct sc_windows_key_event event;
    if(!sc_reverse_keyboard_usage(usage)||!sc_windows_keyboard_mapping(usage,&event))return SC_WINDOWS_KEY_UNSUPPORTED;
    if(s->release_pending&&!sc_windows_keyboard_release(s))return SC_WINDOWS_KEY_BLOCKED;
    bool modifier=usage>=224&&usage<=231;
    if(action==0&&!external_modifiers_match(s,mask))return blocked(s);
    if(!modifier&&action==0&&!modifiers(s,mask))return blocked(s);
    if((action==0||s->down[usage])&&!emit(s,usage,action!=0))return blocked(s);
    if((modifier||action==1)&&!modifiers(s,mask))return blocked(s);
    return SC_WINDOWS_KEY_OK;
}
enum sc_windows_key_result sc_windows_keyboard_text(struct sc_windows_keyboard *s,const uint8_t *text,size_t size) {
    if(!sc_reverse_keyboard_text(text,size))return SC_WINDOWS_KEY_INVALID;
    if(s->blocked)return SC_WINDOWS_KEY_BLOCKED;
    if(s->release_pending&&!sc_windows_keyboard_release(s))return SC_WINDOWS_KEY_BLOCKED;
    if(!modifiers(s,0)||!external_modifiers_match(s,0))return blocked(s);
    struct sc_windows_key_event events[2*SC_REVERSE_TEXT_MAX];size_t count=0;
    for(size_t i=0;i<size;) {
        uint32_t point=text[i++];unsigned remaining=0;
        if(point>=0xf0){point&=7;remaining=3;}else if(point>=0xe0){point&=15;remaining=2;}else if(point>=0xc0){point&=31;remaining=1;}
        while(remaining--){point=(point<<6)|(text[i++]&63);}
        uint16_t units[2];unsigned length=1;
        if(point>0xffff){point-=0x10000;units[0]=(uint16_t)(0xd800+(point>>10));units[1]=(uint16_t)(0xdc00+(point&1023));length=2;}else units[0]=(uint16_t)point;
        for(unsigned j=0;j<length;j++)for(unsigned up=0;up<2;up++)
            events[count++]=(struct sc_windows_key_event){.kind=SC_WINDOWS_UNICODE,.code=units[j],.up=up!=0};
    }
    size_t sent=s->inject(events,count,s->userdata);
    if(sent==count)return SC_WINDOWS_KEY_OK;
    if(sent<count&&(sent&1)){s->unicode_pending=true;s->unicode_unit=events[sent-1].code;}
    // Never replay accepted text. It may be partial, but its final key-up must
    // be retried if Windows rejects cleanup (for example at an integrity boundary).
    return blocked(s);
}
