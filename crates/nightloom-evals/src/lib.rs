//! nightloom-evals: eval and diagnostic harness.
//!
//! First resident: the streaming probe — a per-(provider, model) health
//! check that measures time-to-first-token and verifies the adapter is
//! actually surfacing reasoning deltas, text deltas, usage accounting, and
//! stop reasons. Its job is less to score models than to make it obvious
//! *where* the pipeline breaks when it breaks.

pub mod probe;

pub use probe::{ProbeReport, ProbeSpec, run_probe};
