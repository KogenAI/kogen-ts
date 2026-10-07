"""JSON matchers used by case files.

A matcher is plain JSON:
- object: every listed key must match (subset); ``"$exact": true`` also forbids extra keys;
  a value of ``"$absent"`` requires the key to be missing.
- list: same length, element-wise. ``{"$contains": [...]}`` = each matcher matches some element;
  ``{"$subsequence": [...]}`` = matchers match elements in order; ``{"$len": n}``;
  ``{"$each": m}`` = every element matches m; ``{"$any_of": [m1, m2]}``; ``{"$not": m}``.
- string: ``"~<regex>"`` full-match; type tokens ``$any $str $int $num $bool $null $list $obj
  $hex8 $hex32 $hex40 $hex64 $sha $nonempty``; ``"$$..."`` / ``"~~..."`` escape a literal
  leading ``$``/``~``; anything else is compared literally.
"""

import re

TYPE_TOKENS = {
    "$any": lambda v: True,
    "$str": lambda v: isinstance(v, str),
    "$nonempty": lambda v: isinstance(v, str) and v != "",
    "$int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "$num": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "$bool": lambda v: isinstance(v, bool),
    "$null": lambda v: v is None,
    "$list": lambda v: isinstance(v, list),
    "$obj": lambda v: isinstance(v, dict),
    "$hex8": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{8}", v) is not None,
    "$hex32": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{32}", v) is not None,
    "$hex40": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{40}", v) is not None,
    "$hex64": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None,
    "$sha": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", v) is not None,
    "$str_or_null": lambda v: v is None or isinstance(v, str),
    "$int_or_null": lambda v: v is None or (isinstance(v, int) and not isinstance(v, bool)),
}


def match(matcher, value, path="$"):
    """Return a list of mismatch descriptions (empty = match)."""
    errors = []
    _match(matcher, value, path, errors)
    return errors


def _short(v, limit=160):
    s = repr(v)
    return s if len(s) <= limit else s[:limit] + "…"


def _match(m, v, path, errors):
    if isinstance(m, str):
        if m.startswith("$$") or m.startswith("~~"):
            if v != m[1:]:
                errors.append("%s: expected %s, got %s" % (path, _short(m[1:]), _short(v)))
            return
        if m in TYPE_TOKENS:
            if not TYPE_TOKENS[m](v):
                errors.append("%s: expected %s, got %s" % (path, m, _short(v)))
            return
        if m == "$absent":
            errors.append("%s: expected absent" % path)
            return
        if m.startswith("~"):
            if not isinstance(v, str) or re.fullmatch(m[1:], v, re.S) is None:
                errors.append("%s: %s does not match /%s/" % (path, _short(v), m[1:]))
            return
        if v != m:
            errors.append("%s: expected %s, got %s" % (path, _short(m), _short(v)))
        return
    if isinstance(m, dict):
        special = [k for k in m if k.startswith("$") and k != "$exact"]
        if special:
            _match_special(m, v, path, errors)
            return
        if not isinstance(v, dict):
            errors.append("%s: expected object, got %s" % (path, _short(v)))
            return
        for k, sub in m.items():
            if k == "$exact":
                continue
            if sub == "$absent":
                if k in v:
                    errors.append("%s.%s: expected absent, got %s" % (path, k, _short(v[k])))
                continue
            if k not in v:
                errors.append("%s.%s: missing" % (path, k))
                continue
            _match(sub, v[k], "%s.%s" % (path, k), errors)
        if m.get("$exact"):
            extra = sorted(set(v) - set(k for k in m if k != "$exact"))
            if extra:
                errors.append("%s: unexpected keys %s" % (path, extra))
        return
    if isinstance(m, list):
        if not isinstance(v, list):
            errors.append("%s: expected list, got %s" % (path, _short(v)))
            return
        if len(m) != len(v):
            errors.append("%s: expected %d elements, got %d (%s)" % (path, len(m), len(v), _short(v)))
            return
        for i, (sm, sv) in enumerate(zip(m, v)):
            _match(sm, sv, "%s[%d]" % (path, i), errors)
        return
    if isinstance(m, bool) or isinstance(v, bool):
        ok = type(m) is type(v) and m == v
    else:
        ok = m == v
    if not ok:
        errors.append("%s: expected %s, got %s" % (path, _short(m), _short(v)))


def _match_special(m, v, path, errors):
    if "$contains" in m:
        if not isinstance(v, list):
            errors.append("%s: expected list, got %s" % (path, _short(v)))
            return
        for i, sm in enumerate(m["$contains"]):
            if not any(not match(sm, el) for el in v):
                errors.append("%s: no element matches %s" % (path, _short(sm)))
    if "$subsequence" in m:
        if not isinstance(v, list):
            errors.append("%s: expected list, got %s" % (path, _short(v)))
            return
        pos = 0
        for sm in m["$subsequence"]:
            while pos < len(v) and match(sm, v[pos]):
                pos += 1
            if pos >= len(v):
                errors.append("%s: subsequence element %s not found in order" % (path, _short(sm)))
                return
            pos += 1
    if "$len" in m:
        if not isinstance(v, (list, str, dict)) or len(v) != m["$len"]:
            errors.append("%s: expected length %s, got %s" % (path, m["$len"], _short(v)))
    if "$min_len" in m:
        if not isinstance(v, (list, str, dict)) or len(v) < m["$min_len"]:
            errors.append("%s: expected length >= %s" % (path, m["$min_len"]))
    if "$max_len" in m:
        if not isinstance(v, (list, str, dict)) or len(v) > m["$max_len"]:
            errors.append("%s: expected length <= %s" % (path, m["$max_len"]))
    if "$each" in m:
        if not isinstance(v, list):
            errors.append("%s: expected list" % path)
        else:
            for i, el in enumerate(v):
                _match(m["$each"], el, "%s[%d]" % (path, i), errors)
    if "$any_of" in m:
        if all(match(sm, v) for sm in m["$any_of"]):
            errors.append("%s: %s matches none of %s" % (path, _short(v), _short(m["$any_of"])))
    if "$not" in m:
        if not match(m["$not"], v):
            errors.append("%s: %s must not match %s" % (path, _short(v), _short(m["$not"])))
    if "$ge" in m:
        if not isinstance(v, (int, float)) or v < m["$ge"]:
            errors.append("%s: expected >= %s, got %s" % (path, m["$ge"], _short(v)))
    if "$le" in m:
        if not isinstance(v, (int, float)) or v > m["$le"]:
            errors.append("%s: expected <= %s, got %s" % (path, m["$le"], _short(v)))
    if "$keys" in m:
        if not isinstance(v, dict) or sorted(v) != sorted(m["$keys"]):
            errors.append("%s: expected keys %s, got %s" % (path, sorted(m["$keys"]), sorted(v) if isinstance(v, dict) else _short(v)))
    if "$has_keys" in m:
        if not isinstance(v, dict):
            errors.append("%s: expected object" % path)
        else:
            missing = [k for k in m["$has_keys"] if k not in v]
            if missing:
                errors.append("%s: missing keys %s" % (path, missing))
    if "$contains_text" in m:
        if not isinstance(v, str) or m["$contains_text"] not in v:
            errors.append("%s: %s does not contain %s" % (path, _short(v), _short(m["$contains_text"])))
    if "$object" in m:
        _match(m["$object"], v, path, errors)
