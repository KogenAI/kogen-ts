#!/bin/sh
# kt unit check: every test/unit/*.t.sh defines t_<name>() functions, each run in a
# subshell. One GNU line per failing test; exit 1 if any failed.
status=0
for f in test/unit/*.t.sh; do
  [ -f "$f" ] || continue
  base=${f#test/unit/}
  for t in $(sed -n 's/^\(t_[A-Za-z0-9_]*\)().*/\1/p' "$f"); do
    if ! ( . "./$f" && "$t" ) >/dev/null 2>&1; then
      echo "test/unit/$base:1:1: error: [kt/test] ${t#t_}: failed"
      status=1
    fi
  done
done
exit $status
