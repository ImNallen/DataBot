//! Pure transaction state machine: `txn_after` and `needs_implicit_begin`.

use crate::model::{TxnMode, TxnState};
use crate::sql::StmtKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtOutcome {
    Ok,
    Err,
}

/// The transaction state after Postgres processed `kind` with `outcome`, mirroring the server's
/// own rules: an error inside a block aborts it, `COMMIT` of an aborted block rolls back, and
/// transaction-control statements outside a block only warn.
pub fn txn_after(state: TxnState, kind: &StmtKind, outcome: StmtOutcome) -> TxnState {
    use StmtKind::*;
    use StmtOutcome::*;
    use TxnState::*;
    match (state, kind, outcome) {
        (Idle, Begin, Ok) => Active,
        (Idle, _, _) => Idle,
        (_, Commit, Ok) | (_, Rollback, Ok) => Idle,
        // A failed COMMIT (deferred constraint, serialization) rolls back and ends the block.
        (_, Commit, Err) => Idle,
        (_, RollbackTo, Ok) => Active,
        (Active, _, Ok) => Active,
        (Active, _, Err) => Aborted,
        (Aborted, _, _) => Aborted,
    }
}

/// Manual mode wraps the first statement of a block in `BEGIN`, except transaction control
/// and statements that refuse to run inside a block.
pub fn needs_implicit_begin(mode: TxnMode, state: TxnState, kind: &StmtKind) -> bool {
    use StmtKind::*;
    mode == TxnMode::Manual
        && state == TxnState::Idle
        && !matches!(kind, Begin | Commit | Rollback | Savepoint | RollbackTo | Release | CopyStdio | NoTxnBlock(_))
}

#[cfg(test)]
mod tests {
    use super::*;
    use StmtKind::*;
    use StmtOutcome::*;
    use TxnState::*;

    fn all_kinds() -> Vec<StmtKind> {
        vec![
            Begin,
            Commit,
            Rollback,
            Savepoint,
            RollbackTo,
            Release,
            Ddl("CREATE TABLE".into()),
            Dml(crate::sql::DmlVerb::Update),
            Query,
            CopyStdio,
            NoTxnBlock("VACUUM".into()),
            Other("SET".into()),
        ]
    }

    #[test]
    fn every_transition() {
        let table: Vec<(TxnState, StmtKind, StmtOutcome, TxnState)> = vec![
            (Idle, Begin, Ok, Active),
            (Idle, Begin, Err, Idle),
            (Idle, Commit, Ok, Idle),
            (Idle, Rollback, Ok, Idle),
            (Idle, RollbackTo, Err, Idle),
            (Idle, Query, Ok, Idle),
            (Idle, Query, Err, Idle),
            (Idle, Ddl("CREATE TABLE".into()), Ok, Idle),
            (Active, Begin, Ok, Active),
            (Active, Commit, Ok, Idle),
            (Active, Commit, Err, Idle),
            (Active, Rollback, Ok, Idle),
            (Active, Savepoint, Ok, Active),
            (Active, Savepoint, Err, Aborted),
            (Active, RollbackTo, Ok, Active),
            (Active, RollbackTo, Err, Aborted),
            (Active, Release, Ok, Active),
            (Active, Query, Ok, Active),
            (Active, Query, Err, Aborted),
            (Active, Dml(crate::sql::DmlVerb::Insert), Err, Aborted),
            (Aborted, Query, Ok, Aborted),
            (Aborted, Query, Err, Aborted),
            (Aborted, Begin, Err, Aborted),
            (Aborted, Commit, Ok, Idle),
            (Aborted, Rollback, Ok, Idle),
            (Aborted, RollbackTo, Ok, Active),
            (Aborted, RollbackTo, Err, Aborted),
            (Aborted, Savepoint, Err, Aborted),
        ];
        for (from, kind, outcome, to) in table {
            assert_eq!(txn_after(from, &kind, outcome), to, "{from:?} + {kind:?}/{outcome:?}");
        }
    }

    #[test]
    fn the_machine_is_total() {
        for state in [Idle, Active, Aborted] {
            for kind in all_kinds() {
                for outcome in [Ok, Err] {
                    let _ = txn_after(state, &kind, outcome);
                }
            }
        }
    }

    #[test]
    fn implicit_begin_only_in_manual_idle_for_blockable_statements() {
        for kind in all_kinds() {
            let expected = !matches!(kind, Begin | Commit | Rollback | Savepoint | RollbackTo | Release | CopyStdio | NoTxnBlock(_));
            assert_eq!(needs_implicit_begin(TxnMode::Manual, Idle, &kind), expected, "{kind:?}");
            assert!(!needs_implicit_begin(TxnMode::Manual, Active, &kind));
            assert!(!needs_implicit_begin(TxnMode::Manual, Aborted, &kind));
            assert!(!needs_implicit_begin(TxnMode::AutoCommit, Idle, &kind));
        }
    }
}
