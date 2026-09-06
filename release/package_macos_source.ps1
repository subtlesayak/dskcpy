# Local source/test bundle only. No signing keys, Git history, caches or uploads.
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'release-macos-source' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Bundle output must stay within this repository.'
}
$archive = Join-Path $output 'dskcpy-macos-source.zip'
if (Test-Path -LiteralPath $archive) { throw 'Bundle already exists. Choose a new output directory; existing bundles are not overwritten.' }
$entries = [Collections.Generic.List[object]]::new()
function Add-Source([string]$relative, [string]$target = $relative) {
    $source = Join-Path $repo $relative
    $item = Get-Item -LiteralPath $source
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid source: $relative" }
    $entries.Add(@{ Source = $item.FullName; Target = $target.Replace('\', '/') })
}
foreach ($file in @('LICENSE', 'README.md', 'meson.build', 'meson_options.txt',
    'build.gradle', 'settings.gradle', 'gradle.properties', 'gradlew', 'gradlew.bat',
    'server/build.gradle', 'server/proguard-rules.pro',
    'gui/package.json', 'gui/package-lock.json', 'gui/index.html', 'gui/vite.config.ts',
    'gui/tsconfig.json', 'gui/README.md',
    'tools/macos-build.sh', 'tools/macos-start.sh', 'release/package_macos_source.ps1',
    'release/build_common', 'release/build_server.sh', 'release/package_client.sh',
    'doc/macos-host.md', 'doc/internet-mode.md', 'doc/reverse-display.md',
    'doc/roadmap.md', 'doc/reverse-display-validation.md', 'doc/build.md')) {
    Add-Source $file
}
foreach ($directory in @('app', 'server/src', 'server/scripts', 'gradle/wrapper',
    'gui/src', 'gui/server', 'gui/scripts')) {
    $sourceDirectory = Join-Path $repo $directory
    foreach ($item in Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symlinks are not allowed in this source bundle.' }
        $relative = $item.FullName.Substring($repo.Length + 1)
        Add-Source $relative
    }
}
$apk = 'server/build/outputs/apk/debug/server-debug.apk'
if (-not (Test-Path -LiteralPath (Join-Path $repo $apk))) { $apk = 'companion/reverse-display.apk' }
Add-Source $apk 'companion/reverse-display.apk'
$names = @($entries | ForEach-Object { $_.Target })
if (@($names | Select-Object -Unique).Count -ne $names.Count) { throw 'Duplicate archive paths.' }
if ($names | Where-Object { $_ -match '(^|/)(\.git|\.tmp|\.planning|node_modules|local\.properties)(/|$)|\.(jks|keystore)$' }) {
    throw 'Unexpected private/build path in bundle.'
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Directory]::CreateDirectory($output) | Out-Null
$fileStream = [IO.File]::Open($archive, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create)
$manifest = [Text.StringBuilder]::new()
try {
    foreach ($entry in $entries | Sort-Object { $_.Target }) {
        $bytes = [IO.File]::ReadAllBytes($entry.Source)
        # Windows working checkouts may have CRLF scripts. Normalize only the
        # text payload in the archive, leaving the user's source files intact.
        if ($entry.Target -notmatch '\.(apk|jar|png|ico|jpg|jpeg|gif|woff2?|ttf)$') {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes([Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n"))
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $entry.Hash = $hash
        [void]$manifest.Append($hash).Append('  ').Append($entry.Target).Append("`n")
        $payload = $zip.CreateEntry('dskcpy-macos-source/' + $entry.Target, [IO.Compression.CompressionLevel]::Optimal).Open()
        try { $payload.Write($bytes, 0, $bytes.Length) } finally { $payload.Dispose() }
    }
    $manifestEntry = $zip.CreateEntry('dskcpy-macos-source/SHA256SUMS')
    $writer = [IO.StreamWriter]::new($manifestEntry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write($manifest.ToString()) } finally { $writer.Dispose() }
} finally { $zip.Dispose(); $fileStream.Dispose() }
# Verify every payload from the actual ZIP; a success message requires a match.
$readZip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $entries) {
        $stream = $readZip.GetEntry('dskcpy-macos-source/' + $entry.Target).Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $sha.Dispose(); $stream.Dispose() }
        if ($actual.ToLowerInvariant() -ne $entry.Hash) { throw 'Archive integrity check failed.' }
    }
} finally { $readZip.Dispose() }
Write-Output "Verified $($entries.Count) payload files; archive SHA-256: $((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash)"
Write-Output $archive
