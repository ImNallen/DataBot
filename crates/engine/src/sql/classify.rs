//! `classify`: the statement kind that drives transaction tracking and catalog refresh.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmlVerb {
    Insert,
    Update,
    Delete,
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StmtKind {
    Begin,
    Commit,
    Rollback,
    Savepoint,
    RollbackTo,
    Release,
    /// Changes the catalog. Carries the command tag Postgres would report (`"CREATE TABLE"`).
    Ddl(String),
    Dml(DmlVerb),
    Query,
    /// `COPY ... FROM STDIN` / `TO STDOUT`: the simple protocol cannot carry the data.
    CopyStdio,
    /// Refuses to run inside a transaction block (`VACUUM`, `CREATE DATABASE`, ...).
    NoTxnBlock(String),
    Other(String),
}

impl StmtKind {
    pub fn is_ddl(&self) -> bool {
        matches!(self, StmtKind::Ddl(_))
    }
}

pub fn classify(stmt: &str) -> StmtKind {
    let words: Vec<String> = keywords(stmt).take(4).map(|w| w.to_ascii_uppercase()).collect();
    let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    match w(0) {
        "BEGIN" | "START" => StmtKind::Begin,
        "COMMIT" | "END" => StmtKind::Commit,
        "ROLLBACK" | "ABORT" if w(1) == "TO" => StmtKind::RollbackTo,
        "ROLLBACK" | "ABORT" => StmtKind::Rollback,
        "SAVEPOINT" => StmtKind::Savepoint,
        "RELEASE" => StmtKind::Release,
        "INSERT" => StmtKind::Dml(DmlVerb::Insert),
        "UPDATE" => StmtKind::Dml(DmlVerb::Update),
        "DELETE" => StmtKind::Dml(DmlVerb::Delete),
        "MERGE" => StmtKind::Dml(DmlVerb::Merge),
        "SELECT" | "WITH" | "TABLE" | "VALUES" | "EXPLAIN" | "SHOW" | "FETCH" | "UNION" | "INTERSECT" | "EXCEPT" => StmtKind::Query,
        "COPY" if words.iter().any(|x| x == "STDIN" || x == "STDOUT") => StmtKind::CopyStdio,
        "VACUUM" | "CLUSTER" | "CHECKPOINT" => StmtKind::NoTxnBlock(w(0).to_owned()),
        "ALTER" if w(1) == "SYSTEM" => StmtKind::NoTxnBlock("ALTER SYSTEM".into()),
        "DISCARD" if w(1) == "ALL" => StmtKind::NoTxnBlock("DISCARD ALL".into()),
        "CREATE" | "DROP" if w(1) == "DATABASE" || w(1) == "TABLESPACE" => {
            StmtKind::NoTxnBlock(format!("{} {}", w(0), w(1)))
        }
        "CREATE" | "DROP" | "REINDEX" if words.iter().any(|x| x == "CONCURRENTLY") => {
            StmtKind::NoTxnBlock(ddl_tag(&words))
        }
        "CREATE" | "ALTER" | "DROP" | "COMMENT" | "GRANT" | "REVOKE" | "REINDEX" | "RENAME" | "IMPORT" | "SECURITY" => {
            StmtKind::Ddl(ddl_tag(&words))
        }
        "TRUNCATE" => StmtKind::Other("TRUNCATE TABLE".into()),
        "LOCK" => StmtKind::Other("LOCK TABLE".into()),
        // A parenthesized query: `(select 1) union (select 2)`.
        "" if stmt.contains('(') => StmtKind::Query,
        other => StmtKind::Other(other.to_owned()),
    }
}

/// Postgres reports `CREATE OR REPLACE FUNCTION` as `CREATE FUNCTION` and `CREATE UNIQUE INDEX`
/// as `CREATE INDEX`: the verb plus the object word, skipping modifiers between them.
fn ddl_tag(words: &[String]) -> String {
    const MODIFIERS: [&str; 10] = [
        "OR", "REPLACE", "UNIQUE", "TEMP", "TEMPORARY", "UNLOGGED", "GLOBAL", "LOCAL", "RECURSIVE", "CONCURRENTLY",
    ];
    let verb = &words[0];
    let object = words[1..].iter().find(|w| !MODIFIERS.contains(&w.as_str()));
    match object {
        Some(object) if object == "MATERIALIZED" => format!("{verb} MATERIALIZED VIEW"),
        Some(object) if object == "FOREIGN" => format!("{verb} FOREIGN TABLE"),
        Some(object) => format!("{verb} {object}"),
        None => verb.clone(),
    }
}

/// Identifier-like words of a statement, skipping comments and anything inside parentheses.
fn keywords(stmt: &str) -> impl Iterator<Item = &str> {
    let bytes = stmt.as_bytes();
    let mut i = 0;
    let mut depth = 0usize;
    std::iter::from_fn(move || {
        while i < bytes.len() {
            let c = bytes[i];
            if c == b'-' && bytes.get(i + 1) == Some(&b'-') {
                i = stmt[i..].find('\n').map_or(bytes.len(), |n| i + n);
            } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
                i = stmt[i..].find("*/").map_or(bytes.len(), |n| i + n + 2);
            } else if c == b'(' {
                depth += 1;
                i += 1;
            } else if c == b')' {
                depth = depth.saturating_sub(1);
                i += 1;
            } else if depth == 0 && (c.is_ascii_alphabetic() || c == b'_') {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                return Some(&stmt[start..i]);
            } else {
                i += 1;
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_control() {
        assert_eq!(classify("BEGIN"), StmtKind::Begin);
        assert_eq!(classify("start transaction isolation level serializable"), StmtKind::Begin);
        assert_eq!(classify("commit"), StmtKind::Commit);
        assert_eq!(classify("END;"), StmtKind::Commit);
        assert_eq!(classify("rollback"), StmtKind::Rollback);
        assert_eq!(classify("abort work"), StmtKind::Rollback);
        assert_eq!(classify("rollback to savepoint s1"), StmtKind::RollbackTo);
        assert_eq!(classify("ROLLBACK TO s1"), StmtKind::RollbackTo);
        assert_eq!(classify("savepoint s1"), StmtKind::Savepoint);
        assert_eq!(classify("release savepoint s1"), StmtKind::Release);
    }

    #[test]
    fn comments_and_ctes_do_not_confuse_the_verb() {
        assert_eq!(classify("-- note\n/* more */ with x as (select 1) select * from x"), StmtKind::Query);
        assert_eq!(classify("with x as (insert into t values (1)) select 1"), StmtKind::Query);
        assert_eq!(classify("/* update */ select 1"), StmtKind::Query);
        assert_eq!(classify("explain analyze select 1"), StmtKind::Query);
        assert_eq!(classify("show search_path"), StmtKind::Query);
    }

    #[test]
    fn dml_and_ddl_tags() {
        assert_eq!(classify("insert into t values (1)"), StmtKind::Dml(DmlVerb::Insert));
        assert_eq!(classify("UPDATE t SET a = 1"), StmtKind::Dml(DmlVerb::Update));
        assert_eq!(classify("delete from t"), StmtKind::Dml(DmlVerb::Delete));
        assert_eq!(classify("merge into t using s on true when matched then delete"), StmtKind::Dml(DmlVerb::Merge));
        assert_eq!(classify("create table t (id int)"), StmtKind::Ddl("CREATE TABLE".into()));
        assert_eq!(classify("create temp table t (id int)"), StmtKind::Ddl("CREATE TABLE".into()));
        assert_eq!(classify("create or replace function f() returns int as $$ select 1 $$ language sql"), StmtKind::Ddl("CREATE FUNCTION".into()));
        assert_eq!(classify("create unique index i on t (a)"), StmtKind::Ddl("CREATE INDEX".into()));
        assert_eq!(classify("create materialized view v as select 1"), StmtKind::Ddl("CREATE MATERIALIZED VIEW".into()));
        assert_eq!(classify("alter table t add column b int"), StmtKind::Ddl("ALTER TABLE".into()));
        assert_eq!(classify("drop table if exists t"), StmtKind::Ddl("DROP TABLE".into()));
        assert_eq!(classify("comment on table t is 'x'"), StmtKind::Ddl("COMMENT ON".into()));
    }

    #[test]
    fn copy_stdio_and_non_transactional_statements() {
        assert_eq!(classify("copy t from stdin"), StmtKind::CopyStdio);
        assert_eq!(classify("COPY (select 1) TO STDOUT CSV"), StmtKind::CopyStdio);
        assert_eq!(classify("copy t from '/tmp/x.csv'"), StmtKind::Other("COPY".into()));
        assert_eq!(classify("copy public.orders to stdout"), StmtKind::CopyStdio);
        assert_eq!(classify("copy pg_temp.t from stdin"), StmtKind::CopyStdio);
        assert_eq!(classify("copy pg_temp.t (x, y) from stdin with (format csv)"), StmtKind::CopyStdio);
        assert_eq!(classify("COPY binary \"Shop\".\"Orders\" (id) TO STDOUT"), StmtKind::CopyStdio);
        assert_eq!(classify("copy (select 'x' from t) to stdout"), StmtKind::CopyStdio);
        assert_eq!(classify("copy \"stdin\" to stdout"), StmtKind::CopyStdio);
        assert_eq!(classify("copy public.orders to '/tmp/stdout.csv'"), StmtKind::Other("COPY".into()));
        assert_eq!(classify("copy pg_temp.t from '/tmp/stdin' with (format csv)"), StmtKind::Other("COPY".into()));
        assert_eq!(classify("copy public.orders to program 'cat'"), StmtKind::Other("COPY".into()));
        assert_eq!(classify("vacuum analyze t"), StmtKind::NoTxnBlock("VACUUM".into()));
        assert_eq!(classify("create database x"), StmtKind::NoTxnBlock("CREATE DATABASE".into()));
        assert_eq!(classify("create index concurrently i on t (a)"), StmtKind::NoTxnBlock("CREATE INDEX".into()));
        assert_eq!(classify("alter system set work_mem = '1MB'"), StmtKind::NoTxnBlock("ALTER SYSTEM".into()));
    }

    #[test]
    fn other_statements_carry_their_tag() {
        assert_eq!(classify("set search_path to lab"), StmtKind::Other("SET".into()));
        assert_eq!(classify("truncate t"), StmtKind::Other("TRUNCATE TABLE".into()));
        assert_eq!(classify("lock table t"), StmtKind::Other("LOCK TABLE".into()));
        assert_eq!(classify("do $$ begin end $$"), StmtKind::Other("DO".into()));
        assert_eq!(classify("call p()"), StmtKind::Other("CALL".into()));
        assert_eq!(classify("(select 1) union (select 2)"), StmtKind::Query);
        assert_eq!(classify(""), StmtKind::Other(String::new()));
    }
}
