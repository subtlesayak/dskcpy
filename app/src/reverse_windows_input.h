#ifndef SC_REVERSE_WINDOWS_INPUT_H
#define SC_REVERSE_WINDOWS_INPUT_H
#include <windows.h>
#include "reverse_windows_keyboard.h"
static inline INPUT sc_windows_make_input(const struct sc_windows_key_event *event) {
    INPUT input={0};input.type=INPUT_KEYBOARD;
    if(event->kind==SC_WINDOWS_VIRTUAL)input.ki.wVk=event->code;
    else {input.ki.wScan=event->code;input.ki.dwFlags=event->kind==SC_WINDOWS_UNICODE?KEYEVENTF_UNICODE:KEYEVENTF_SCANCODE;}
    if(event->up)input.ki.dwFlags|=KEYEVENTF_KEYUP;
    if(event->extended&&event->kind==SC_WINDOWS_SCAN)input.ki.dwFlags|=KEYEVENTF_EXTENDEDKEY;
    return input;
}
#endif
