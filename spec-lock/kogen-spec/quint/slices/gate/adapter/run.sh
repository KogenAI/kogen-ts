#!/bin/sh
cd "$(dirname "$0")"
EBIN="${KOGEN_EBIN:-$HOME/Areas/Kogen/careful-rebuild/_build/dev/lib/kogen/ebin}"
exec elixir -pa "$EBIN" adapter.exs
