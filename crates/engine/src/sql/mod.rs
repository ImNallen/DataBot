mod classify;
mod split;

pub use classify::{DmlVerb, Invalidates, StmtKind, classify};
pub use split::{ByteTarget, StmtSpan, pick, split_statements};
