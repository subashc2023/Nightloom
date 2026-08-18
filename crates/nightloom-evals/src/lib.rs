//! nightloom-evals: eval and diagnostic harness.
//!
//! First resident: the streaming probe — a per-(provider, model) health
//! check that measures time-to-first-token and verifies the adapter is
//! actually surfacing reasoning deltas, text deltas, usage accounting, and
//! stop reasons. Its job is less to score models than to make it obvious
//! *where* the pipeline breaks when it breaks.

//! Second resident: the task suite — the same models given a workspace, a
//! set of tools and a job, checked afterwards against the disk. The two
//! answer different questions and fail independently: an adapter can stream
//! flawlessly while the model never edits the right file.

pub mod probe;
pub mod suite;
pub mod task;

pub use probe::{ProbeReport, ProbeSpec, run_probe};
pub use task::{Attempt, Task, TaskReport, run_task};
