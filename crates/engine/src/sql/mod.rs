mod classify;
mod history;
mod relations;
mod split;

pub use classify::{DmlVerb, Invalidates, StmtKind, classify};
pub use relations::{is_read_statement, relation_names, side_effect_calls};
pub use split::{ByteTarget, StmtSpan, pick, split_statements};

pub(crate) use history::{history_is_write, history_text};
