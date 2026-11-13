# Supplemental runtime notice

`werift-0.27.0-LICENSE.txt` is copied verbatim from the upstream `v0.27.0`
release, commit `23292efc644f1048041433a76fbcf4b6d62bfd46`, root `LICENSE`:
<https://github.com/shinyoshiaki/werift-webrtc/blob/23292efc644f1048041433a76fbcf4b6d62bfd46/LICENSE>.
SHA-256: `b83683f3f71b5971e6c2e33a8b894a49d752fd24c11b8ae08b53ca20f594fca5`.

The npm package declares MIT but ships only its separate libwebrtc notice.
Staging retains that bundled notice and adds this primary notice under
`host/licenses`. It checks the installed package name, version and license;
a dependency upgrade requires a fresh source/notice review. No build or runtime
network fetch is added. Bundle verification checks the pinned bytes and manifest
entry, independently of the manifest's supplied hash.

This closes one observed missing-file gap. Full dependency, Electron/native
notice and source-offer review, signing, installer and platform qualification
remain release gates. No complete licensing or distribution approval is claimed.
