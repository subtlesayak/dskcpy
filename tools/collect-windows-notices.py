"""Retain installed runtime-package notices and exact MSYS2 source references."""
import json
import pathlib
import shutil
import subprocess
import sys


def command(*args):
    return subprocess.check_output(args, text=True).strip()


runtime, destination = map(pathlib.Path, sys.argv[1:])
destination.mkdir()  # Never replace an existing stage or a working package.
mingw_bin = pathlib.Path(command('cygpath', '-w', '/ucrt64/bin'))
index = {p.name.lower(): p.name for p in mingw_bin.iterdir() if p.is_file()}
copied = []
for label, posix in [('ucrt64', '/ucrt64/share/licenses'), ('msys', '/usr/share/licenses')]:
    source = pathlib.Path(command('cygpath', '-w', posix))
    if source.is_dir():
        shutil.copytree(source, destination / label)
        copied.extend(str(p.relative_to(destination)) for p in (destination / label).rglob('*') if p.is_file())
assert copied, 'Installed native license texts are missing'
packages = {}
for dll in sorted(runtime.glob('*.dll')):
    actual = index[dll.name.lower()]
    package = command('pacman', '-Qoq', '/ucrt64/bin/' + actual)
    assert package and '\n' not in package, 'Ambiguous runtime owner'
    if package not in packages:
        version = command('pacman', '-Q', package).split(maxsplit=1)[1]
        info = command('pacman', '-Qi', package)
        fields = {}
        for line in info.splitlines():
            if ':' in line and not line.startswith(' '):
                key, value = line.split(':', 1)
                fields[key.strip()] = value.strip()
        assert fields.get('Licenses') not in [None, '', 'None', 'Unknown'], 'Runtime license metadata missing'
        packages[package] = {'version': version, 'licenses': fields['Licenses'],
                             'project': fields.get('URL'),
                             'sourceReference': 'https://packages.msys2.org/package/' + package,
                             'files': []}
    packages[package]['files'].append(dll.name)
assert packages, 'No native runtime packages were recorded'
(destination / 'runtime-packages.json').write_text(json.dumps({
    'packages': packages, 'noticeFilesCopied': len(copied),
    'reviewedForStableDistribution': False,
    'note': 'Installed notices and source references are retained. Stable distribution qualification remains open.'
}, indent=2) + '\n')
print(json.dumps({'nativeRuntimePackages': len(packages), 'noticeFilesCopied': len(copied)}))
