#!/usr/bin/env bash
# Builds the iroh-gossip wasm module and generates JS bindings into src/wasm/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
( cd crates/audia-gossip && cargo build --release )
wasm-bindgen --target web --out-dir src/wasm \
  crates/audia-gossip/target/wasm32-unknown-unknown/release/audia_gossip.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Os src/wasm/audia_gossip_bg.wasm -o src/wasm/audia_gossip_bg.wasm
fi
ls -lh src/wasm/audia_gossip_bg.wasm
