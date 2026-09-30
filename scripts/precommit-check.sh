#!/usr/bin/env bash
# Refuse to commit keys, keypairs, env files or build/test artefacts.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
staged=$(git diff --cached --name-only)
bad_paths=$(printf '%s\n' "$staged" | grep -E '(^|/)keys/|keypair|solpoker-key-|(^|/)\.env|(^|/)id\.json$|^target/|node_modules/|^\.anchor/|test-ledger|^\.mb-stack' || true)
if [ -n "$bad_paths" ]; then
  echo "BLOCKED: secret or artefact paths staged:"; printf '  %s\n' $bad_paths; fail=1
else
  echo "ok: no key / artefact paths staged"
fi
if git diff --cached -U0 | grep -qE '^\+.*\[\s*([0-9]{1,3}\s*,\s*){63}[0-9]{1,3}\s*\]'; then
  echo "BLOCKED: a 64-byte secret-key-shaped array is staged"; fail=1
else
  echo "ok: no secret-key-shaped arrays staged"
fi
exit $fail
