#!/usr/bin/env python3
"""Probe whether a cluster's delegation program (DELeGG...) knows the escape-hatch
instructions RequestUndelegation (26) and UndelegateWithRollbackAfterTimeout (27).

Method: simulate (sigVerify=false) one instruction per discriminator with dummy
accounts. An unknown discriminator fails on instruction-data parsing before any
account checks; a known one gets past parsing and fails later (account count,
signer, owner ...). We compare against a surely-unknown discriminator (250) and a
known old one (Undelegate = 3).

usage: probe_dlp.py <rpc_url> <fee_payer_pubkey>
"""
import base64, json, sys, urllib.request
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solders.hash import Hash

DLP = Pubkey.from_string("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh")
if len(sys.argv) != 3:
    sys.exit("usage: probe_dlp.py <rpc_url> <fee_payer_pubkey>  (any existing funded account; nothing is signed or sent)")
RPC = sys.argv[1]
PAYER = Pubkey.from_string(sys.argv[2])


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 solpoker-probe"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def probe(disc: int, n_accounts: int):
    dummies = [Pubkey.new_unique() for _ in range(n_accounts)]
    metas = [AccountMeta(PAYER, True, True)] + [AccountMeta(d, i == 0, True) for i, d in enumerate(dummies[1:])]
    ix = Instruction(DLP, bytes([disc]) + bytes(7), metas)
    msg = Message.new_with_blockhash([ix], PAYER, Hash.default())
    tx = Transaction.new_unsigned(msg)
    b64 = base64.b64encode(bytes(tx)).decode()
    r = rpc("simulateTransaction", [b64, {"encoding": "base64", "sigVerify": False, "replaceRecentBlockhash": True}])
    v = r.get("result", {}).get("value", {})
    logs = [l for l in (v.get("logs") or []) if "DELeGG" not in l or "failed" in l]
    return v.get("err"), logs[-3:]


ver = rpc("getVersion", [])
print("rpc", RPC, "version", ver.get("result", {}).get("solana-core"))
acc = rpc("getAccountInfo", [str(DLP), {"encoding": "base64"}])["result"]["value"]
print("dlp executable:", acc and acc["executable"], "owner:", acc and acc["owner"])
for name, disc, n in [("unknown(250)", 250, 7), ("Undelegate(3)", 3, 7), ("RequestUndelegation(26)", 26, 7),
                      ("UndelegateWithRollbackAfterTimeout(27)", 27, 9)]:
    err, logs = probe(disc, n)
    print(f"{name:42s} err={json.dumps(err)}")
    for l in logs:
        print("    ", l[:160])
