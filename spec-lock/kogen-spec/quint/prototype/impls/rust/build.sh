#!/bin/sh
cd "$(dirname "$0")" && exec cargo build --release --quiet
