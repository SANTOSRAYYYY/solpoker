//! solpoker-core：隐私德州扑克（Solana + MagicBlock TEE Ephemeral Rollup）的纯 Rust 核心逻辑。
//!
//! 本 crate 不依赖 Anchor / Solana SDK，只依赖 `std`、`sha2`、`hmac`，
//! 供链上程序与链下工具（keeper、索引器、参考实现）共用同一份实现。
//!
//! 模块划分（对应主设计文档 stage1-design.md）：
//! - [`vrf`]：VRF 状态机（§9 VRF 集成、§6.2 V1 拆分方案）与 `caller_seed` 请求标识；
//! - [`seats`]：九席固定座位的掩码与顺时针扫描助手（D7：v1 完整支持 2–9 人）；
//! - [`deal`]：Stage 4 发牌协议（§8 的字节级定稿：盐承诺/聚合、逐街种子、第一手庄位、
//!   事件流规范编码、滚动 transcript、拒绝采样抽牌机与整手编排）；
//! - [`eval`]：7 选 5 摊牌牌力评估（类别 + kicker 全序、平局枚举，结算分池的前置件）；
//! - [`engine`]：Stage 5 规则引擎（§7.1：强制注、下注轮状态机、最小加注、
//!   不足额 all-in、超时、runout 触发）；
//! - [`settle`]：Stage 5 结算与 rake（§7.2：未跟注退回、贡献分层边池、
//!   no-flop-no-drop、顺时针奇数筹码、作废退回）。
//!
//! 链上程序只负责账户校验、签名者校验与 CPI，状态推进一律调用本 crate。

pub mod deal;
pub mod engine;
pub mod eval;
pub mod seats;
pub mod settle;
pub mod vrf;
