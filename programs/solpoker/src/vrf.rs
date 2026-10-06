//! VRF request encoding helpers. Pure functions only — unit-testable without a
//! validator. Formulas from design §9 and context-block-v5 【架构】randomness.
//!
//! The state machine itself lives in `solpoker-core` (`VrfSlot::arm/request/
//! fulfill/retry`); this module only handles what crosses the wire to the VRF
//! queue:
//!
//! ```text
//! caller_seed   = sha256("solpoker/vrf/v1" ‖ table ‖ hand_id_be ‖ target ‖ attempt)
//! callback_args = hand_id_be ‖ target ‖ attempt        (parsed back in the callback)
//! fulfillment ix data = callback_discriminator ‖ randomness ‖ callback_args
//! ```
//!
//! `caller_seed` delegates to `solpoker_core::vrf::caller_seed` (sha2), whose
//! output is pinned by a CI test vector in solpoker-core — do not reimplement.

use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

use crate::state::VrfTarget;

/// Domain separator is owned by solpoker-core (`solpoker_core::vrf::caller_seed`).
pub use solpoker_core::vrf::caller_seed;

/// Anchor instruction discriminator for `vrf_callback`
/// (sha256("global:vrf_callback")[0..8], standard Anchor 1.0 scheme). Sent to
/// the queue as `callback_discriminator` so the fulfillment CPI dispatches
/// back into this handler.
pub fn vrf_callback_discriminator() -> [u8; 8] {
    let h = Sha256::digest(b"global:vrf_callback");
    h[0..8].try_into().unwrap()
}

/// Parsed callback_args payload.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CallbackArgs {
    pub hand_id: u64,
    pub target: VrfTarget,
    pub attempt: u8,
}

/// hand_id (8) + target (1) + attempt (1)
const CALLBACK_ARGS_LEN: usize = 10;

/// encode_callback_args = borsh `Vec<u8>` 编码的 `hand_id_be ‖ target ‖ attempt`，
/// 前 4 字节是 u32 LE 长度前缀。target 用 solpoker-core 的线上编码
/// （`VrfTarget::to_u8`，Preflop=0..Runout=4——与 caller_seed 钉死向量同源）。
///
/// **为什么有长度前缀**：VRF 程序把 callback_args 原样带回，而 Anchor 对 handler
/// 的 `Vec<u8>` 参数按 borsh 反序列化（u32 LE 长度 + 数据）。不传前缀时 Anchor
/// 会把 hand_id 的前 4 字节当长度——hand_id=0 时被读成 0，回调收到空 Vec 被
/// 静默忽略（2026-10-06 devnet-tee 实测发现：fulfillment 交易 ok 但状态停在
/// Pending）。
pub fn encode_callback_args(hand_id: u64, target: VrfTarget, attempt: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + CALLBACK_ARGS_LEN);
    v.extend_from_slice(&(CALLBACK_ARGS_LEN as u32).to_le_bytes());
    v.extend_from_slice(&hand_id.to_be_bytes());
    v.push(target.to_core().to_u8());
    v.push(attempt);
    v
}

/// Strict parse; anything malformed yields None and the callback ignores it.
pub fn decode_callback_args(args: &[u8]) -> Option<CallbackArgs> {
    if args.len() != CALLBACK_ARGS_LEN {
        return None;
    }
    let hand_id = u64::from_be_bytes(args[0..8].try_into().ok()?);
    let target = VrfTarget::from_u8(args[8])?;
    Some(CallbackArgs {
        hand_id,
        target,
        attempt: args[9],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_seed_matches_core_pinned_vector() {
        // Same pinned vector as solpoker-core's CI test:
        // sha256("solpoker/vrf/v1" ‖ 0x11*32 ‖ 0000000000000007 ‖ 01 ‖ 02)
        let table = [0x11u8; 32];
        let t = Pubkey::from(table);
        let seed = caller_seed(
            t.as_ref().try_into().unwrap(),
            7,
            VrfTarget::Flop.to_core(),
            2,
        );
        let hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "a1d3786b5c6a0e36d4210b947c41712bbc267068cc7210cc0643a36304b40f03"
        );
    }

    #[test]
    fn callback_args_roundtrip_all_targets() {
        for target in [
            VrfTarget::Preflop,
            VrfTarget::Flop,
            VrfTarget::Turn,
            VrfTarget::River,
            VrfTarget::Runout,
        ] {
            let args = CallbackArgs {
                hand_id: u64::MAX,
                target,
                attempt: 3,
            };
            let encoded = encode_callback_args(args.hand_id, args.target, args.attempt);
            // borsh Vec<u8>: 4-byte LE length prefix + 10 payload bytes.
            assert_eq!(encoded.len(), 14);
            assert_eq!(&encoded[0..4], &10u32.to_le_bytes());
            // The handler receives the payload after Anchor unwraps the Vec.
            assert_eq!(decode_callback_args(&encoded[4..]), Some(args));
        }
    }

    #[test]
    fn callback_args_rejects_bad_input() {
        assert_eq!(decode_callback_args(&[]), None);
        assert_eq!(decode_callback_args(&[0u8; 9]), None);
        assert_eq!(decode_callback_args(&[0u8; 11]), None);
        let mut bad = encode_callback_args(1, VrfTarget::Flop, 1);
        bad[4 + 8] = 99; // invalid target discriminant (after the length prefix)
        assert_eq!(decode_callback_args(&bad[4..]), None);
    }
}
