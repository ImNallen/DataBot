mod classify;
mod history;
mod split;

pub use classify::{DmlVerb, Invalidates, StmtKind, classify};
pub use split::{ByteTarget, StmtSpan, pick, split_statements};

pub(crate) use history::{history_is_write, history_text};
