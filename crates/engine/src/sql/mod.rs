//! Pure SQL lexing: statement splitting, picking, and classification.

mod classify;
mod split;

pub use classify::{DmlVerb, StmtKind, classify};
pub use split::{ByteTarget, StmtSpan, pick, split_statements};
