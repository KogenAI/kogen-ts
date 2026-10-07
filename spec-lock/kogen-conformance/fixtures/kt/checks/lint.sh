#!/bin/sh
# kt lint check: one GNU line per TODO in lib/*.txt; exit 1 if any.
status=0
for f in lib/*.txt; do
  [ -f "$f" ] || continue
  name=${f#lib/}
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in
      *TODO*)
        echo "lib/$name:$n:1: error: [lint/todo] $name: TODO found"
        status=1
        ;;
    esac
  done < "$f"
done
exit $status
