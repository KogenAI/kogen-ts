#!/bin/sh
set -e
cd "$(dirname "$0")"
mise exec go@1.27.0 -- go build -o landing-adapter .
