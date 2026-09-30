#!/usr/bin/env bash
# Fail if any pinned tool or dependency drifted. Run after `anchor build` and `yarn install`.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.solpoker-env" ] && . "$HOME/.solpoker-env"

fail=0
check() { # name want got
  if [ "$3" = "$2" ]; then printf 'ok    %-40s %s\n' "$1" "$3"; else printf 'FAIL  %-40s want %s, got %s\n' "$1" "$2" "${3:-<none>}"; fail=1; fi
}

check "rustc"        "1.89.0"  "$(rustc --version | awk '{print $2}')"
check "solana-cli"   "3.1.10"  "$(solana --version | awk '{print $2}')"
check "anchor-cli"   "1.0.2"   "$(anchor --version | awk '{print $2}')"
check "node (major)" "24"      "$(node -p 'process.versions.node.split(".")[0]')"
if command -v ephemeral-validator >/dev/null 2>&1; then
  check "ephemeral-validator" "0.14.10" "$(ephemeral-validator --version | awk '{print $2}')"
fi

crate() { cargo tree --workspace -e normal --prefix none 2>/dev/null | awk -v n="$1" '$1==n {print $2}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
check "cargo anchor-lang (unique)"            "v1.0.2"  "$(crate anchor-lang)"
check "cargo ephemeral-rollups-sdk"           "v0.17.3" "$(crate ephemeral-rollups-sdk)"
check "cargo magicblock-delegation-program-api" "v3.1.0" "$(crate magicblock-delegation-program-api)"

npmv() { node -p "require('./node_modules/$1/package.json').version" 2>/dev/null; }
check "npm @anchor-lang/core"                   "1.0.2"  "$(npmv @anchor-lang/core)"
check "npm @anchor-lang/borsh"                  "1.0.2"  "$(npmv @anchor-lang/borsh)"
check "npm @anchor-lang/errors"                 "1.0.2"  "$(npmv @anchor-lang/errors)"
check "npm @magicblock-labs/ephemeral-rollups-sdk" "0.17.3" "$(npmv @magicblock-labs/ephemeral-rollups-sdk)"
check "npm @solana/web3.js"                     "1.98.4" "$(npmv @solana/web3.js)"
dups=$(find node_modules -path '*/@solana/web3.js/package.json' -not -path 'node_modules/@solana/web3.js/package.json' | wc -l)
check "npm nested @solana/web3.js copies"       "0"      "$dups"

for p in solpoker:EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf smoke:BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4; do
  n=${p%%:*}; id=${p#*:}
  [ -f "target/idl/$n.json" ] && check "IDL address $n" "$id" "$(node -p "require('./target/idl/$n.json').address")"
done

exit $fail
