#!/bin/sh
# kt acceptance runner for the command adapter: sources {path}, runs each t_A<n> in a
# subshell and appends one ledger row per test to $KOGEN_LEDGER_REPORT.
path=$1
slug=${KOGEN_INTENT_SLUG:?KOGEN_INTENT_SLUG is not set}
report=${KOGEN_LEDGER_REPORT:?KOGEN_LEDGER_REPORT is not set}
case $path in
  /*) src=$path ;;
  *) src=./$path ;;
esac
[ -f "$src" ] || { echo "kt: $path does not exist"; exit 2; }
status=0
for t in $(sed -n 's/^\(t_A[0-9][0-9]*\)().*/\1/p' "$src"); do
  id=${t#t_}
  if ( . "$src" && "$t" ); then st=passed; else st=failed; status=1; fi
  echo "kt: $id $st"
  printf '{"tag":"%s/%s","test":"%s","status":"%s"}\n' "$slug" "$id" "$id" "$st" >> "$report"
done
exit $status
