mod classify;
mod history;
mod keywords;
mod relations;
mod split;

pub use classify::{DmlVerb, Invalidates, StmtKind, classify};
pub use relations::{Vet, relation_names, vet};
pub use split::{ByteTarget, StmtSpan, pick, split_statements};

pub(crate) use history::{history_is_write, history_text};
#[cfg(all(test, feature = "pg-tests"))]
pub(crate) use keywords::{NEVER_A_FUNCTION, OTHER_KEYWORDS};
#[cfg(all(test, feature = "pg-tests"))]
pub(crate) use relations::{VETTED, VETTED_OPERATORS, VETTED_SIZES};
