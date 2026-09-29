"""Compare two disk images' Finder layouts (.DS_Store): window, view
options, and icon positions must match; the background alias may differ only
in the volume name and date it points at.

  python3 compare_dmg_layout.py <old .DS_Store> <new .DS_Store> <new volume name>"""
import sys
from ds_store import DSStore
import mac_alias


def read(path):
    out = {}
    with DSStore.open(path, "r") as store:
        for entry in store:
            value = entry.value
            if isinstance(value, dict):
                value = dict(value)
                if "backgroundImageAlias" in value:
                    alias = mac_alias.Alias.from_bytes(value.pop("backgroundImageAlias"))
                    value["background"] = (alias.volume.name, alias.target.filename, alias.target.posix_path)
            out[(entry.filename, entry.code.decode())] = value
    return out


old, new = read(sys.argv[1]), read(sys.argv[2])
volume = sys.argv[3]
problems = []
for key in sorted(set(old) | set(new)):
    a, b = old.get(key), new.get(key)
    if isinstance(a, dict) and isinstance(b, dict) and "background" in a:
        a = dict(a, background=(volume,) + a["background"][1:])
    if a != b:
        problems.append(f"{key}: 2.4.0 {a!r} != new {b!r}")
for key, value in sorted(new.items()):
    print(key, value)
if problems:
    print("LAYOUT DIFFERS:\n  " + "\n  ".join(problems))
    sys.exit(1)
print("layout identical to the 2.4.0 image (background alias re-pointed at", repr(volume) + ")")
