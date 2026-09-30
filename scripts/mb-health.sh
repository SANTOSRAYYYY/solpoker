#!/usr/bin/env bash
# Health check for the local MagicBlock stack started by scripts/mb-stack.sh.
set -uo pipefail
rpc() { curl -s -m 5 -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\"}" "$1"; }
ok=0
for ep in "base http://127.0.0.1:8899" "er http://127.0.0.1:7799" "qfs http://127.0.0.1:6699"; do
  set -- $ep
  v=$(rpc "$2" getVersion | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"].get("solana-core","?"))' 2>/dev/null)
  if [ -n "$v" ]; then echo "$1 $2 up (version $v)"; else echo "$1 $2 DOWN"; ok=1; fi
done
id=$(rpc http://127.0.0.1:7799 getIdentity | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["identity"])' 2>/dev/null)
echo "ER identity: ${id:-unknown} (expected mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev)"
[ "$id" = "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev" ] || ok=1
exit $ok
