#!/usr/bin/env bash
# Start the local MagicBlock stack (@magicblock-labs/ephemeral-validator@0.14.10).
#
#   client -> QFS 127.0.0.1:6699/6700 -> ER 127.0.0.1:7799/7800 -> base 127.0.0.1:8899/8900
#
# Ledgers live in .mb-stack/ (gitignored). Pass --reset to start from genesis.
# Extra arguments are forwarded to solana-test-validator by mb-stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.solpoker-env" ] && . "$HOME/.solpoker-env"

# mb-stack 0.14.10 detects base readiness with /^JSON RPC URL:/. When colors are
# forced (CLICOLOR_FORCE=1 / FORCE_COLOR), Agave 3.1.10 wraps that label in ANSI
# bold codes, the regex never matches and mb-stack aborts after 120 s even though
# the validator is healthy. Force plain output.
unset CLICOLOR_FORCE FORCE_COLOR
export CLICOLOR=0 NO_COLOR=1

# magicblock-validator 0.14.10 raises RLIMIT_NOFILE to 1,000,000 at startup and exits
# ("unable to set open file descriptor limit") if the hard limit is lower. mb-stack
# filters that line out, so check here. GitHub runners have a 65,536 hard limit: run
#   sudo prlimit --pid $$ --nofile=1048576:1048576
# in the same shell first.
NOFILE_NEEDED=1000000
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt "$NOFILE_NEEDED" ]; then
  echo "open-file hard limit is $(ulimit -Hn); the local ER needs >= $NOFILE_NEEDED." >&2
  echo "Fix: sudo prlimit --pid \$\$ --nofile=1048576:1048576  (then rerun in that shell)" >&2
  exit 1
fi
ulimit -n "$NOFILE_NEEDED"

EXPECTED="0.14.10"
ACTUAL="$(ephemeral-validator --version 2>/dev/null | awk '{print $2}')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "ephemeral-validator $EXPECTED required, found '${ACTUAL:-none}'." >&2
  echo "Install: npm install -g @magicblock-labs/ephemeral-validator@$EXPECTED" >&2
  exit 1
fi

mkdir -p "$ROOT/.mb-stack"
cd "$ROOT/.mb-stack"
exec mb-stack "$@"
