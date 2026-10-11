#!/usr/bin/env bash
# Signs fixtures with a throwaway key (so the real release key is never needed), then runs the Rust checks.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fx="$here/../../test-artifacts/updater-$$"
mkdir -p "$fx"
node "$here/fixtures.mjs" "$fx"
FIXTURES="$fx" cargo run --quiet --manifest-path "$here/Cargo.toml"
