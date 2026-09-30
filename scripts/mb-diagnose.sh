#!/usr/bin/env bash
# Diagnose the local MagicBlock stack. mb-stack only surfaces child lines that contain
# error|failed|fatal|panic, so an ER that exits for another reason leaves no trace.
# This starts the base L1 alone, then runs ephemeral-validator in the foreground with
# its full output. Extra args are forwarded to mb-test-validator (e.g. --upgradeable-program).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.solpoker-env" ] && . "$HOME/.solpoker-env"
unset CLICOLOR_FORCE FORCE_COLOR
export CLICOLOR=0 NO_COLOR=1
D="$ROOT/.mb-diag"
rm -rf "$D"
mkdir -p "$D"
cd "$D" || exit 1
pkill -f solana-test-validator >/dev/null 2>&1
pkill -f ephemeral-validator >/dev/null 2>&1
pkill -f query-filtering >/dev/null 2>&1
sleep 2

health() { curl -s -m 2 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$1" 2>/dev/null; }

echo "=== environment"
uname -a
echo "nproc=$(nproc) ulimit_n=$(ulimit -n) max_map_count=$(cat /proc/sys/vm/max_map_count 2>/dev/null)"
free -m | sed -n 2p
echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)"
echo "cpu flags: $(grep -m1 -o -wE 'avx2|avx512f|avx512bw|avx512vl|bmi2|adx|sha_ni|aes' /proc/cpuinfo | sort -u | tr '\n' ' ')"
echo "ephemeral-validator: $(ephemeral-validator --version 2>&1 | head -1)"

echo "=== base L1"
mb-test-validator --reset --rpc-port 8899 "$@" > base.log 2>&1 &
BASE=$!
for i in $(seq 1 60); do health http://127.0.0.1:8899 | grep -q '"ok"' && break; sleep 2; done
echo "base getHealth: $(health http://127.0.0.1:8899)"

echo "=== ephemeral-validator in the foreground (45 s; exit 124 = still running = healthy)"
RUST_BACKTRACE=1 RUST_LOG="${RUST_LOG:-info}" timeout 45 ephemeral-validator --no-tui \
  --listen 127.0.0.1:7799 --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 > er.log 2>&1 &
ER=$!
sleep 15
echo "ER getHealth after 15 s: $(health http://127.0.0.1:7799)"
wait $ER
rc=$?
echo "ER exit code: $rc"
echo "--- er.log (first 40 lines)"
head -n 40 er.log
echo "--- er.log (last 80 lines)"
tail -n 80 er.log
kill $BASE >/dev/null 2>&1
wait $BASE 2>/dev/null
exit 0
