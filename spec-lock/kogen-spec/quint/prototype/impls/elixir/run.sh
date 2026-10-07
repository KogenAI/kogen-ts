#!/bin/sh
cd "$(dirname "$0")" && exec elixir -r core.ex adapter.exs
