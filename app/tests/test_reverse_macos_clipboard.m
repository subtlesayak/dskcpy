#import <Cocoa/Cocoa.h>
#include <assert.h>
#include <string.h>
#include "reverse_macos_clipboard.h"
// In-memory Objective-C stand-in. No general or named OS pasteboard is opened.
@interface FakeClipboard : NSObject
@property(nonatomic, copy) NSString *value;
@property unsigned clears;
@end
@implementation FakeClipboard
- (NSString *)stringForType:(NSPasteboardType)type { assert([type isEqual:NSPasteboardTypeString]); return self.value; }
- (NSInteger)clearContents { ++self.clears; self.value = nil; return self.clears; }
- (BOOL)writeObjects:(NSArray *)items { self.value = [items[0] stringForType:NSPasteboardTypeString]; return YES; }
@end
int main(void) { @autoreleasepool {
    FakeClipboard *fake=[FakeClipboard new];NSPasteboard *board=(NSPasteboard *)fake;
    char text[SC_REVERSE_CLIPBOARD_MAX];size_t length;
    assert(sc_macos_clipboard_read(board,text,&length)==SC_CLIPBOARD_UNAVAILABLE);
    const char *sample="café 世界 🙂";
    assert(sc_macos_clipboard_write(board,sample,strlen(sample)));assert(fake.clears==1);
    assert(sc_macos_clipboard_read(board,text,&length)==SC_CLIPBOARD_OK && length==strlen(sample) && !memcmp(text,sample,length));
    assert(!sc_macos_clipboard_write(board,"\xc0\xaf",2));assert(fake.clears==1);
    fake.value=[@"x" stringByPaddingToLength:SC_REVERSE_CLIPBOARD_MAX+1 withString:@"x" startingAtIndex:0];
    assert(sc_macos_clipboard_read(board,text,&length)==SC_CLIPBOARD_TOO_LARGE);
    fake.value=@"";assert(sc_macos_clipboard_read(board,text,&length)==SC_CLIPBOARD_OK && !length);
    return 0;
} }
