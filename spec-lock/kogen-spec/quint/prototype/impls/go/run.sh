#!/bin/sh
cd "$(dirname "$0")"
[ -x ./landing-adapter ] || ./build.sh >&2
exec ./landing-adapter
