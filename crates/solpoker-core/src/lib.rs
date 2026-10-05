//! solpoker-core：隐私德州扑克（Solana + MagicBlock TEE Ephemeral Rollup）的纯 Rust 核心逻辑。
//!
//! 本 crate 不依赖 Anchor / Solana SDK，只依赖 `std`、`sha2`、`hmac`，
//! 供链上程序与链下工具（keeper、索引器、参考实现）共用同一份实现。
//!
//! 模块划分（对应主设计文档 stage1-design.md）：
//! - [`vrf`]：VRF 状态机（§9 VRF 集成、§6.2 V1 拆分方案）与 `caller_seed` 请求标识；
//! - [`seats`]：九席固定座位的掩码与顺时针扫描助手（D7：v1 完整支持 2–9 人）。
//!
//! 链上程序只负责账户校验、签名者校验与 CPI，状态推进一律调用本 crate。

pub mod seats;
pub mod vrf;
