#!/bin/sh
# kt fix: strips trailing spaces in lib/*.txt.
for f in lib/*.txt; do
  [ -f "$f" ] || continue
  if grep -q ' $' "$f"; then
    sed 's/  *$//' "$f" > "$f.kt-fmt" && cat "$f.kt-fmt" > "$f" && rm -f "$f.kt-fmt"
  fi
done
exit 0
