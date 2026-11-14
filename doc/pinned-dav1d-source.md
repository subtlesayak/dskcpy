# Pinned dav1d release source

The dependency builder uses VideoLAN's official dav1d 1.5.3 release archive:

- [Release directory](https://download.videolan.org/pub/videolan/dav1d/1.5.3/)
- [Published SHA-256](https://download.videolan.org/pub/videolan/dav1d/1.5.3/dav1d-1.5.3.tar.xz.sha256)
- Archive SHA-256: `732010aa5ef461fa93355ed2c6c5fedb48ddc4b74e697eaabe8907eaeb943011`

Both architectures' pinned Mac builds failed connecting to the previous
code.videolan.org source-forge archive endpoint after its existing bounded
retries. The release archive is served separately by download.videolan.org.
The dependency version, build configuration and feature set are unchanged.

The downloaded release archive matches the upstream-published SHA-256. Its
359 regular files have the same relative paths and byte hashes as the previously
pinned GitLab snapshot (`cbe212b02faf8c6eed5b6d55ef8a6e363aaab83f15112e960701a9c3df813686`).
There are no changed, added or removed regular files. The archive encoding and
metadata differ; this comparison does not claim the compressed archives match.

The production checksum is fixed in source. Builds never fetch a checksum to
trust an arbitrary download, bypass verification, change versions automatically,
or drop the AV1 decoder. Existing checked-cache, temporary-download and bounded
retry behavior remains in force. CI already caches both tar.gz and tar.xz files.
An unavailable or altered release archive still fails the build. This change
does not establish artifact signing, notarization, installation or hardware
qualification, and does not update an installed host.
