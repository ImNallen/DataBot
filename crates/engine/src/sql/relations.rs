//! What one statement names and whether it only reads, off the token stream. Pure and
//! catalog-free: the assistant resolves the names against the database's catalog, so a
//! function, a CTE, or a column that is not a relation drops out there.

use super::history::{Token, history_is_write, tokens};
use super::split::split_statements;

/// A relation name as written. An unquoted part is folded to lower case, a quoted part is verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameRef {
    pub schema: Option<String>,
    pub name: String,
}

/// What follows a relation name decides whether it was one: `generate_series(` after FROM is a
/// function call, `t (a, b)` after INTO is a column list.
#[derive(Clone, Copy, PartialEq)]
enum Expect {
    No,
    /// After FROM, JOIN, or a comma in a FROM list.
    FromItem,
    /// After INTO, UPDATE, TABLE.
    Target,
}

#[derive(Clone, Copy)]
struct Level {
    expect: Expect,
    in_from: bool,
}

const CLAUSES: [&str; 17] = ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "FETCH", "FOR", "RETURNING", "SET", "VALUES", "SELECT", "ON"];

/// Statement verbs that read. `classify` also counts FETCH and set operations as queries for
/// transaction tracking; this list is what `run_query` accepts.
const READ_VERBS: [&str; 6] = ["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"];

/// Functions that act outside the transaction: backends, settings, session locks, files, other
/// connections, notifications. `READ ONLY` does not stop them.
const SIDE_EFFECT_NAMES: [&str; 12] = [
    "set_config",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_create_restore_point",
    "pg_promote",
    "pg_backup_start",
    "pg_backup_stop",
    "pg_notify",
    "pg_stat_file",
];
const SIDE_EFFECT_PREFIXES: [&str; 9] = ["dblink", "lo_", "pg_ls_", "pg_read_", "pg_logical_", "pg_replication_", "pg_drop_replication", "pg_create_physical_replication", "pg_create_logical_replication"];

fn part(t: Option<&Token<'_>>) -> Option<String> {
    match t? {
        Token::Word(w) => Some(w.to_ascii_lowercase()),
        Token::Quoted(q) => Some((*q).replace("\"\"", "\"")),
        _ => None,
    }
}

fn is_word(t: Option<&Token<'_>>, expected: &str) -> bool {
    matches!(t, Some(Token::Word(w)) if w.eq_ignore_ascii_case(expected))
}

/// The matching `)` of the `(` at `open`.
fn close_of(tokens: &[Token<'_>], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, t) in tokens.iter().enumerate().skip(open) {
        match t {
            Token::Open => depth += 1,
            Token::Close => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Names after FROM, JOIN, UPDATE, INTO, TABLE, USING, and in a FROM comma list, in first-use
/// order, minus the names `WITH … AS` declared before their use.
pub fn relation_names(sql: &str) -> Vec<NameRef> {
    let toks = tokens(sql);
    let first = match toks.first() {
        Some(Token::Word(w)) => w.to_ascii_uppercase(),
        _ => String::new(),
    };
    let mut levels = vec![Level { expect: Expect::No, in_from: false }];
    let mut ctes: Vec<(String, usize)> = Vec::new();
    let mut found: Vec<(NameRef, usize, Expect)> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let level = levels.last_mut().expect("level 0 is never popped");
        match &toks[i] {
            Token::Open => {
                level.expect = Expect::No;
                levels.push(Level { expect: Expect::No, in_from: false });
            }
            Token::Close => {
                if levels.len() > 1 {
                    levels.pop();
                }
            }
            Token::Comma => {
                if level.in_from && level.expect == Expect::No {
                    level.expect = Expect::FromItem;
                }
            }
            Token::Word(w) => {
                let up = w.to_ascii_uppercase();
                match up.as_str() {
                    "FROM" if is_word(i.checked_sub(1).and_then(|p| toks.get(p)), "DISTINCT") => {}
                    "FROM" | "JOIN" => {
                        level.expect = Expect::FromItem;
                        level.in_from = true;
                    }
                    "INTO" | "UPDATE" | "TABLE" => level.expect = Expect::Target,
                    "USING" if first == "DELETE" || first == "MERGE" => {
                        level.expect = Expect::FromItem;
                        level.in_from = true;
                    }
                    "AS" => {
                        let mut j = i + 1;
                        while is_word(toks.get(j), "NOT") || is_word(toks.get(j), "MATERIALIZED") {
                            j += 1;
                        }
                        if toks.get(j) == Some(&Token::Open)
                            && let Some(close) = close_of(&toks, j)
                        {
                            let before = i.saturating_sub(1);
                            let name_at = if toks[before] == Token::Close { toks[..before].iter().rposition(|t| *t == Token::Open).and_then(|o| o.checked_sub(1)) } else { Some(before) };
                            if let Some(name) = name_at.and_then(|n| part(toks.get(n))) {
                                ctes.push((name, close));
                            }
                        }
                    }
                    _ if CLAUSES.contains(&up.as_str()) => {
                        level.in_from = false;
                        level.expect = Expect::No;
                    }
                    "ONLY" | "LATERAL" if level.expect != Expect::No => {}
                    _ if level.expect != Expect::No => {
                        let expect = level.expect;
                        level.expect = Expect::No;
                        i = take_name(&toks, i, expect, &mut found);
                    }
                    _ => {}
                }
            }
            Token::Quoted(_) if level.expect != Expect::No => {
                let expect = level.expect;
                level.expect = Expect::No;
                i = take_name(&toks, i, expect, &mut found);
            }
            _ => {}
        }
        i += 1;
    }
    let mut out: Vec<NameRef> = Vec::new();
    for (name, at, expect) in found {
        let mut after = at + 1;
        while toks.get(after) == Some(&Token::Dot) {
            after += 2;
        }
        let function_call = expect == Expect::FromItem && toks.get(after) == Some(&Token::Open);
        let shadowed = name.schema.is_none() && ctes.iter().any(|(cte, close)| *cte == name.name && *close < at);
        if !function_call && !shadowed && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Reads a possibly dotted name starting at `i`; returns the index of its last token.
fn take_name(toks: &[Token<'_>], mut i: usize, expect: Expect, found: &mut Vec<(NameRef, usize, Expect)>) -> usize {
    let at = i;
    let mut parts = vec![part(toks.get(i)).expect("a word or a quoted identifier")];
    while toks.get(i + 1) == Some(&Token::Dot)
        && let Some(next) = part(toks.get(i + 2))
    {
        parts.push(next);
        i += 2;
    }
    let name = parts.pop().expect("one part");
    found.push((NameRef { schema: parts.pop(), name }, at, expect));
    i
}

/// Called functions that act outside the transaction, lowercased, each once, in call order.
pub fn side_effect_calls(sql: &str) -> Vec<String> {
    let toks = tokens(sql);
    let mut out = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        let name = match t {
            Token::Word(w) => w.to_ascii_lowercase(),
            Token::Quoted(q) => q.to_ascii_lowercase(),
            _ => continue,
        };
        if toks.get(i + 1) != Some(&Token::Open) {
            continue;
        }
        let denied = SIDE_EFFECT_NAMES.contains(&name.as_str()) || SIDE_EFFECT_PREFIXES.iter().any(|p| name.starts_with(p)) || (name.starts_with("pg_advisory_") || name.starts_with("pg_try_advisory_")) && !name.contains("_xact_");
        if denied && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// One statement whose kind reads only: SELECT, WITH without a modifying CTE, VALUES, TABLE, SHOW,
/// or EXPLAIN without ANALYZE of a write.
pub fn is_read_statement(sql: &str) -> bool {
    let spans = split_statements(sql);
    let [span] = spans.as_slice() else { return false };
    let stmt = span.text(sql);
    let toks = tokens(stmt);
    let leads_with_read = match toks.first() {
        Some(Token::Word(w)) => READ_VERBS.iter().any(|v| w.eq_ignore_ascii_case(v)),
        Some(Token::Open) => true,
        _ => false,
    };
    leads_with_read && !history_is_write(stmt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(sql: &str) -> Vec<String> {
        relation_names(sql)
            .into_iter()
            .map(|r| match r.schema {
                Some(s) => format!("{s}.{}", r.name),
                None => r.name,
            })
            .collect()
    }

    #[test]
    fn the_mockup_query_uses_orders_and_customers_not_its_aliases() {
        let sql = "select c.region, count(*) as orders, sum(o.total) as revenue\nfrom orders o join customers c on c.id = o.customer_id\nwhere o.status = 'paid' and o.created_at > now() - interval '90 days'\ngroup by c.region order by revenue desc";
        assert_eq!(names(sql), ["orders", "customers"]);
    }

    #[test]
    fn schema_qualified_quoted_and_comma_lists() {
        assert_eq!(names(r#"select * from public.orders o, "Order Items" i, shop."Odd""Name" n"#), ["public.orders", "Order Items", "shop.Odd\"Name"]);
        assert_eq!(names("select 1 from ONLY orders"), ["orders"]);
        assert_eq!(names("table lab.type_zoo"), ["lab.type_zoo"]);
    }

    #[test]
    fn functions_subselects_and_cte_names_are_not_relations() {
        assert_eq!(names("select * from generate_series(1, 3) g, orders"), ["orders"]);
        assert_eq!(names("select * from (select * from orders) q join customers using (id)"), ["orders", "customers"]);
        assert_eq!(names("with orders as (select * from orders where total > 1) select * from orders join customers on true"), ["orders", "customers"], "the inner FROM is the table, the outer one is the CTE");
        assert_eq!(names("with recent as (select * from orders) select * from recent"), ["orders"]);
        assert_eq!(names("with recent(id) as materialized (select id from orders) select * from recent r join customers c on c.id = r.id"), ["orders", "customers"]);
    }

    #[test]
    fn writes_and_distinct_from() {
        assert_eq!(names("insert into orders (id) values (1)"), ["orders"]);
        assert_eq!(names("update orders set total = 1 from customers c where c.id = orders.customer_id"), ["orders", "customers"]);
        assert_eq!(names("delete from orders using customers c where true"), ["orders", "customers"]);
        assert_eq!(names("select a is distinct from b from orders"), ["orders"]);
        assert_eq!(names("select * from a left outer join lateral (select 1) x on true cross join b"), ["a", "b"]);
    }

    #[test]
    fn strings_and_comments_hide_names() {
        assert_eq!(names("select 'from fake' from real -- from commented\n/* join nope */"), ["real"]);
        assert_eq!(names("select 1"), Vec::<String>::new());
    }

    #[test]
    fn side_effect_functions_are_named_once_each_and_xact_locks_are_fine() {
        assert_eq!(side_effect_calls("select set_config('a', 'b', false), pg_terminate_backend(pid), set_config('c', 'd', true) from pg_stat_activity"), ["set_config", "pg_terminate_backend"]);
        assert_eq!(side_effect_calls("select dblink_exec('dbname=x', 'delete from t')"), ["dblink_exec"]);
        assert_eq!(side_effect_calls(r#"select "PG_ADVISORY_LOCK"(1), pg_try_advisory_lock_shared(2)"#), ["pg_advisory_lock", "pg_try_advisory_lock_shared"]);
        assert_eq!(side_effect_calls("select pg_advisory_xact_lock(1), pg_notify('c', 'p'), lo_import('/tmp/x')"), ["pg_notify", "lo_import"]);
        assert_eq!(side_effect_calls("select 'set_config' as note, set_config_like from t"), Vec::<String>::new(), "a string or a column is not a call");
        assert_eq!(side_effect_calls("select pg_sleep(1), count(*) from orders"), Vec::<String>::new());
    }

    #[test]
    fn read_statements_are_single_select_like_statements_without_a_write() {
        for sql in ["select 1", "  -- note\n select * from orders;", "WITH x AS (select 1) select * from x", "(select 1) union (select 2)", "table orders", "values (1), (2)", "show search_path", "explain select 1", "explain (analyze false) delete from t", "explain analyze select pg_sleep(1)"] {
            assert!(is_read_statement(sql), "{sql}");
        }
        for sql in ["delete from t", "insert into t values (1)", "update t set a = 1", "with x as (delete from t returning *) select * from x", "explain analyze delete from t", "select 1; select 2", "commit", "set transaction_read_only = off", "copy orders to stdout", "fetch 1 from c", "", "-- only a comment", "create table t (id int)", "truncate t", "do $$ begin end $$"] {
            assert!(!is_read_statement(sql), "{sql}");
        }
    }
}
