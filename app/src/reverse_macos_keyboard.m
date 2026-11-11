#include "reverse_macos_keyboard.h"
#include <Carbon/Carbon.h>

CGEventRef sc_reverse_macos_key_event(uint16_t usage, bool down, uint8_t modifiers, bool repeat) {
    // USB keyboard-page usages -> public Carbon virtual key constants.
    // Store code+1 because A has virtual key code zero; zero means unmapped.
#define K(usage_, key_) [usage_] = key_ + 1
    static const uint16_t codes[232] = {
        K(4,kVK_ANSI_A), K(5,kVK_ANSI_B), K(6,kVK_ANSI_C), K(7,kVK_ANSI_D), K(8,kVK_ANSI_E),
        K(9,kVK_ANSI_F), K(10,kVK_ANSI_G), K(11,kVK_ANSI_H), K(12,kVK_ANSI_I), K(13,kVK_ANSI_J),
        K(14,kVK_ANSI_K), K(15,kVK_ANSI_L), K(16,kVK_ANSI_M), K(17,kVK_ANSI_N), K(18,kVK_ANSI_O),
        K(19,kVK_ANSI_P), K(20,kVK_ANSI_Q), K(21,kVK_ANSI_R), K(22,kVK_ANSI_S), K(23,kVK_ANSI_T),
        K(24,kVK_ANSI_U), K(25,kVK_ANSI_V), K(26,kVK_ANSI_W), K(27,kVK_ANSI_X), K(28,kVK_ANSI_Y), K(29,kVK_ANSI_Z),
        K(30,kVK_ANSI_1), K(31,kVK_ANSI_2), K(32,kVK_ANSI_3), K(33,kVK_ANSI_4), K(34,kVK_ANSI_5),
        K(35,kVK_ANSI_6), K(36,kVK_ANSI_7), K(37,kVK_ANSI_8), K(38,kVK_ANSI_9), K(39,kVK_ANSI_0),
        K(40,kVK_Return), K(41,kVK_Escape), K(42,kVK_Delete), K(43,kVK_Tab), K(44,kVK_Space),
        K(45,kVK_ANSI_Minus), K(46,kVK_ANSI_Equal), K(47,kVK_ANSI_LeftBracket), K(48,kVK_ANSI_RightBracket),
        K(49,kVK_ANSI_Backslash), K(51,kVK_ANSI_Semicolon), K(52,kVK_ANSI_Quote), K(53,kVK_ANSI_Grave),
        K(54,kVK_ANSI_Comma), K(55,kVK_ANSI_Period), K(56,kVK_ANSI_Slash), K(57,kVK_CapsLock),
        K(58,kVK_F1), K(59,kVK_F2), K(60,kVK_F3), K(61,kVK_F4), K(62,kVK_F5), K(63,kVK_F6),
        K(64,kVK_F7), K(65,kVK_F8), K(66,kVK_F9), K(67,kVK_F10), K(68,kVK_F11), K(69,kVK_F12),
        K(74,kVK_Home), K(75,kVK_PageUp), K(76,kVK_ForwardDelete), K(77,kVK_End), K(78,kVK_PageDown),
        K(79,kVK_RightArrow), K(80,kVK_LeftArrow), K(81,kVK_DownArrow), K(82,kVK_UpArrow),
        K(83,kVK_ANSI_KeypadClear), K(84,kVK_ANSI_KeypadDivide), K(85,kVK_ANSI_KeypadMultiply),
        K(86,kVK_ANSI_KeypadMinus), K(87,kVK_ANSI_KeypadPlus), K(88,kVK_ANSI_KeypadEnter),
        K(89,kVK_ANSI_Keypad1), K(90,kVK_ANSI_Keypad2), K(91,kVK_ANSI_Keypad3), K(92,kVK_ANSI_Keypad4),
        K(93,kVK_ANSI_Keypad5), K(94,kVK_ANSI_Keypad6), K(95,kVK_ANSI_Keypad7), K(96,kVK_ANSI_Keypad8),
        K(97,kVK_ANSI_Keypad9), K(98,kVK_ANSI_Keypad0), K(99,kVK_ANSI_KeypadDecimal), K(100,kVK_ISO_Section),
        K(103,kVK_ANSI_KeypadEquals), K(104,kVK_F13), K(105,kVK_F14), K(106,kVK_F15),
        K(107,kVK_F16), K(108,kVK_F17), K(109,kVK_F18), K(110,kVK_F19), K(111,kVK_F20),
        K(224,kVK_Control), K(225,kVK_Shift), K(226,kVK_Option), K(227,kVK_Command),
        K(228,kVK_RightControl), K(229,kVK_RightShift), K(230,kVK_RightOption), K(231,kVK_RightCommand),
    };
#undef K
    if (usage >= 232 || !codes[usage]) return NULL;
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)(codes[usage] - 1), down);
    if (event) {
        CGEventFlags flags = 0;
        if (modifiers & 0x11) flags |= kCGEventFlagMaskControl;
        if (modifiers & 0x22) flags |= kCGEventFlagMaskShift;
        if (modifiers & 0x44) flags |= kCGEventFlagMaskAlternate;
        if (modifiers & 0x88) flags |= kCGEventFlagMaskCommand;
        CGEventSetFlags(event, flags);
        CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, down && repeat);
    }
    return event;
}
