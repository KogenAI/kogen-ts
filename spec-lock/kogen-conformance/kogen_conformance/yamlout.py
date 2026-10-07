"""Emit the strict YAML subset of spec §2.6 from JSON values (block maps, flow scalar lists)."""

import re

_PLAIN = re.compile(r"^[A-Za-z0-9_./@+()-][A-Za-z0-9_./@+() -]*$")


def scalar(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return '""'
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value)
    if _PLAIN.match(s) and not s.endswith(" ") and ": " not in s and " #" not in s and s not in ("-",):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'


def _is_scalar(v):
    return not isinstance(v, (dict, list))


def emit(value, indent=0):
    """Return YAML text for a top-level mapping."""
    lines = []
    _emit_map(value, indent, lines)
    return "\n".join(lines) + "\n"


def _emit_map(mapping, indent, lines):
    pad = " " * indent
    for key, val in mapping.items():
        if isinstance(val, dict):
            if not val:
                lines.append("%s%s: {}" % (pad, key))
            else:
                lines.append("%s%s:" % (pad, key))
                _emit_map(val, indent + 2, lines)
        elif isinstance(val, list):
            if all(_is_scalar(v) for v in val):
                lines.append("%s%s: [%s]" % (pad, key, ", ".join(scalar(v) for v in val)))
            else:
                lines.append("%s%s:" % (pad, key))
                _emit_seq(val, indent + 2, lines)
        else:
            lines.append("%s%s: %s" % (pad, key, scalar(val)))


def _emit_seq(seq, indent, lines):
    pad = " " * indent
    for val in seq:
        if isinstance(val, dict):
            sub = []
            _emit_map(val, indent + 2, sub)
            if sub:
                sub[0] = pad + "- " + sub[0][indent + 2:]
            lines.extend(sub)
        elif isinstance(val, list):
            lines.append("%s- [%s]" % (pad, ", ".join(scalar(v) for v in val)))
        else:
            lines.append("%s- %s" % (pad, scalar(val)))


def deep_merge(base, patch):
    """Merge ``patch`` into a copy of ``base``; a ``null`` value deletes the key."""
    out = dict(base)
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
        elif isinstance(v, dict) and isinstance(out.get(k), dict) and not v.get("$replace"):
            out[k] = deep_merge(out[k], v)
        elif isinstance(v, dict) and v.get("$replace"):
            out[k] = {kk: vv for kk, vv in v.items() if kk != "$replace"}
        else:
            out[k] = v
    return out
