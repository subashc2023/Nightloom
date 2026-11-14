//! The desktop's Tauri commands, by group, moved out of `main.rs` by pure
//! moves (item 642). Each module takes `use crate::*` so its code reads
//! as it did in `main.rs`; `main.rs` keeps startup, the builder and the
//! `generate_handler!` list, which names each command by its module.

pub(crate) mod agent;
pub(crate) mod aside;
pub(crate) mod attachments;
pub(crate) mod chat;
pub(crate) mod cli;
pub(crate) mod connect;
pub(crate) mod context;
pub(crate) mod edits;
pub(crate) mod memory;
pub(crate) mod menu;
pub(crate) mod notes;
pub(crate) mod projects;
pub(crate) mod providers;
pub(crate) mod sessions;
pub(crate) mod steer;
pub(crate) mod system;
pub(crate) mod threads;
pub(crate) mod turns;
pub(crate) mod usage;
