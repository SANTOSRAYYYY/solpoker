//! Local litesvm repro for ER traps with full logs.
//!
//! The devnet-tee validator never returns transaction logs, so on-chain
//! printf debugging is impossible. This harness loads the exact
//! `target/deploy/solpoker.so` plus account dumps produced by
//! `scripts/stage6-local-repro.mjs` (dir `local-repro-accounts/`), executes
//! `advance(hand_id)` under the real agave RBPF VM, and prints the full log
//! stream — including the VM's own trap diagnostics (stack overflow, OOM,
//! panic location).
//!
//! Usage (from the repo root):
//!   cargo run --manifest-path tools/local-repro/Cargo.toml

use std::fs;
use std::path::Path;
use std::str::FromStr;

// NB: package magicblock-litesvm exposes lib name `litesvm`; the `Account`
// type LiteSVM::set_account takes comes from package magicblock-account
// (lib name `magicblock_account`), aliased to `solana_account` inside
// magicblock-litesvm — same package, so the types are identical.
use litesvm::LiteSVM;
use magicblock_account::Account;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let idl: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("target/idl/solpoker.json")).expect("read idl"),
    )
    .expect("parse idl");
    let program_id = Address::from_str(idl["address"].as_str().unwrap()).unwrap();

    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, root.join("target/deploy/solpoker.so"))
        .expect("add program");

    // Load every account dump written by the JS side.
    let dumps_dir = root.join("local-repro-accounts");
    let mut table_pk: Option<Address> = None;
    let mut game_pk: Option<Address> = None;
    let mut game_data: Vec<u8> = Vec::new();
    for entry in fs::read_dir(&dumps_dir).expect("read dumps dir (run stage6-local-repro.mjs first)") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let dump: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read dump")).expect("parse dump");
        let pk = Address::from_str(dump["pubkey"].as_str().unwrap()).unwrap();
        let a = &dump["account"];
        let data = base64_decode(a["data"][0].as_str().unwrap());
        let owner = Address::from_str(a["owner"].as_str().unwrap()).unwrap();
        let acct = Account {
            lamports: a["lamports"].as_u64().unwrap(),
            data: data.clone(),
            owner,
            executable: a["executable"].as_bool().unwrap(),
            rent_epoch: 0,
        };
        if owner == program_id && data.len() == 1552 {
            game_pk = Some(pk);
            game_data = data.clone();
        }
        if owner == program_id && data.len() == 145 {
            table_pk = Some(pk);
        }
        svm.set_account(pk, acct).expect("set account");
    }
    let table_pk = table_pk.expect("table account among dumps");
    let game_pk = game_pk.expect("game account among dumps");

    let hand_id = u64::from_le_bytes(game_data[72..80].try_into().unwrap());
    let hand_mask = u16::from_le_bytes(game_data[1526..1528].try_into().unwrap());
    println!(
        "hand_id={hand_id} hand_mask={hand_mask:09b} phase={} vrf.state={}",
        game_data[1544], game_data[144]
    );

    // advance discriminator: sha256("global:advance")[..8], arg hand_id LE.
    let mut data = Sha256::digest(b"global:advance")[..8].to_vec();
    data.extend_from_slice(&hand_id.to_le_bytes());

    let pda = |seeds: &[&[u8]]| Address::find_program_address(seeds, &program_id).0;
    let deck = pda(&[b"deck", table_pk.as_ref(), &[0u8, 0]]);
    let proof = pda(&[b"proof", table_pk.as_ref()]);
    let secrets = pda(&[b"secrets", table_pk.as_ref()]);
    let hand = |i: u8| pda(&[b"hand", table_pk.as_ref(), &[0u8, 0], &[i]]);

    let deployer_bytes: Vec<u8> =
        serde_json::from_str(&fs::read_to_string(root.join("keys/deployer.json")).unwrap()).unwrap();
    let deployer = Keypair::try_from(deployer_bytes.as_slice()).unwrap();

    let mut metas = vec![
        AccountMeta::new_readonly(table_pk, false),
        AccountMeta::new(game_pk, false),
        AccountMeta::new(deck, false),
        AccountMeta::new(proof, false),
        AccountMeta::new(secrets, false),
    ];
    for i in 0..9u8 {
        metas.push(AccountMeta::new(hand(i), false));
    }
    metas.push(AccountMeta::new_readonly(deployer.pubkey(), true));

    let ix = Instruction { program_id, accounts: metas, data };
    // ComputeBudget::SetComputeUnitLimit (tag 0x02, u32 LE) — advance is a
    // heavy instruction (dozens of sha256/HMAC syscalls); the 200k default is
    // not enough. This is the exact fix the ER callers must apply.
    let cu_ix = Instruction {
        program_id: Address::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
        accounts: vec![],
        data: [0x02u8].into_iter().chain(1_400_000u32.to_le_bytes()).collect(),
    };
    let msg = Message::new(&[cu_ix, ix], Some(&deployer.pubkey()));
    let tx = Transaction::new(&[&deployer], msg, svm.latest_blockhash());

    match svm.send_transaction(tx) {
        Ok(meta) => {
            println!("=== SUCCESS ===");
            for l in &meta.logs {
                println!("{l}");
            }
        }
        Err(failed) => {
            println!("=== TRAP: {:?} ===", failed.err);
            for l in &failed.meta.logs {
                println!("{l}");
            }
        }
    }
}

/// Minimal base64 decoder (std-only, avoids pulling the base64 crate).
fn base64_decode(s: &str) -> Vec<u8> {
    fn val(c: u8) -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => 0,
        }
    }
    let s: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut buf = [0u8; 4];
        for (i, &c) in chunk.iter().enumerate() {
            buf[i] = val(c);
        }
        let n = ((buf[0] as u32) << 18) | ((buf[1] as u32) << 12) | ((buf[2] as u32) << 6) | buf[3] as u32;
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}
