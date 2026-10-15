use super::split::{dollar_tag, skip_block_comment, skip_dollar_quoted, skip_quoted};

#[derive(Debug, PartialEq)]
enum Token<'a> {
    Word(&'a str),
    Open,
    Close,
    Comma,
    Number(&'a str),
    Other,
}

fn tokens(sql: &str) -> Vec<Token<'_>> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(bytes.len(), |n| i + n)
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = skip_block_comment(bytes, i),
            b'\'' | b'"' => {
                out.push(Token::Other);
                i = skip_quoted(bytes, i, bytes[i]);
            }
            b'$' if dollar_tag(bytes, i).is_some() => {
                out.push(Token::Other);
                i = skip_dollar_quoted(bytes, i, dollar_tag(bytes, i).unwrap());
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                i += 1;
                while i < bytes.len()
                    && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
                {
                    i += 1;
                }
                out.push(Token::Word(&sql[start..i]));
            }
            c if c.is_ascii_digit() => {
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                out.push(Token::Number(&sql[start..i]));
            }
            c if c.is_ascii_whitespace() => i += 1,
            c => {
                out.push(match c {
                    b'(' => Token::Open,
                    b')' => Token::Close,
                    b',' => Token::Comma,
                    _ => Token::Other,
                });
                i += 1;
            }
        }
    }
    out
}

fn word(token: Option<&Token<'_>>, expected: &str) -> bool {
    matches!(token, Some(Token::Word(w)) if w.eq_ignore_ascii_case(expected))
}

fn closing(tokens: &[Token<'_>], open: usize) -> Option<usize> {
    let mut depth = 0;
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

fn writes(tokens: &[Token<'_>]) -> bool {
    let Some(Token::Word(first)) = tokens.first() else {
        return false;
    };
    match first.to_ascii_uppercase().as_str() {
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "TRUNCATE" | "CREATE" | "ALTER" | "DROP"
        | "COMMENT" | "GRANT" | "REVOKE" | "REINDEX" | "RENAME" | "IMPORT" | "SECURITY" => true,
        "WITH" => {
            let mut i = 1;
            if word(tokens.get(i), "RECURSIVE") {
                i += 1;
            }
            loop {
                i += 1;
                if tokens.get(i) == Some(&Token::Open) {
                    let Some(end) = closing(tokens, i) else {
                        return false;
                    };
                    i = end + 1;
                }
                if !word(tokens.get(i), "AS") {
                    return false;
                }
                i += 1;
                if word(tokens.get(i), "NOT") {
                    i += 1;
                }
                if word(tokens.get(i), "MATERIALIZED") {
                    i += 1;
                }
                if tokens.get(i) != Some(&Token::Open) {
                    return false;
                }
                let Some(end) = closing(tokens, i) else {
                    return false;
                };
                if writes(&tokens[i + 1..end]) {
                    return true;
                }
                i = end + 1;
                if tokens.get(i) != Some(&Token::Comma) {
                    return writes(&tokens[i..]);
                }
                i += 1;
            }
        }
        "EXPLAIN" => {
            let mut i = 1;
            let mut analyze = false;
            if tokens.get(i) == Some(&Token::Open) {
                let Some(end) = closing(tokens, i) else {
                    return false;
                };
                for n in i + 1..end {
                    if word(tokens.get(n), "ANALYZE") || word(tokens.get(n), "ANALYSE") {
                        analyze = !word(tokens.get(n + 1), "FALSE")
                            && !word(tokens.get(n + 1), "OFF")
                            && tokens.get(n + 1) != Some(&Token::Number("0"));
                    }
                }
                i = end + 1;
            } else {
                while word(tokens.get(i), "ANALYZE")
                    || word(tokens.get(i), "ANALYSE")
                    || word(tokens.get(i), "VERBOSE")
                {
                    analyze |= word(tokens.get(i), "ANALYZE") || word(tokens.get(i), "ANALYSE");
                    i += 1;
                }
            }
            analyze && writes(&tokens[i..])
        }
        _ => false,
    }
}

/// History metadata describes recognizable writes, independently of transaction classification.
pub(crate) fn history_is_write(sql: &str) -> bool {
    writes(&tokens(sql))
}

fn excerpt(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        if out.chars().count() >= limit {
            out.push('…');
            break;
        }
    }
    out
}

pub(crate) fn history_text(sql: &str) -> (String, String) {
    let mut rest = sql.trim_start();
    let mut title = None;
    loop {
        if let Some(comment) = rest.strip_prefix("--") {
            let end = comment.find('\n').unwrap_or(comment.len());
            if title.is_none() && !comment[..end].trim().is_empty() {
                title = Some(excerpt(comment[..end].trim(), 90));
            }
            rest = comment[end..].trim_start();
        } else if rest.starts_with("/*") {
            let end = skip_block_comment(rest.as_bytes(), 0);
            let content_end = if rest[..end].ends_with("*/") {
                end - 2
            } else {
                end
            };
            if title.is_none() {
                title = Some(excerpt(rest[2..content_end].trim(), 90));
            }
            rest = rest[end..].trim_start();
        } else {
            break;
        }
    }
    let sql_excerpt = excerpt(rest, 180);
    let title = title
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| excerpt(rest, 72));
    (
        if title.is_empty() {
            "SQL statement".into()
        } else {
            title
        },
        sql_excerpt,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_writes_without_changing_runner_classification() {
        for sql in [
            "insert into t values (1) returning *",
            "update t set x = 1 returning *",
            "delete from t returning *",
            "merge into t using s on true when matched then delete",
            "truncate t",
            "create table t (id int)",
            "drop table t",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "with x(a) as materialized (select 1), y as (update t set x=2 returning *) select * from y",
            "with x as (select 1) insert into t select * from x",
            "explain analyze update t set x=1",
            "explain (analyze true, buffers) delete from t",
            "explain (analyze 1) delete from t",
        ] {
            assert!(history_is_write(sql), "{sql}");
        }
        assert_eq!(
            super::super::classify("with x as (delete from t returning *) select * from x"),
            super::super::StmtKind::Query
        );
    }

    #[test]
    fn ignores_quoted_words_comments_and_unexecuted_explain() {
        for sql in [
            "select 'update'",
            "/* outer /* update */ delete */ select 1 -- insert",
            "select $$ update t $$",
            "select $tag$ delete from t $tag$",
            "select E'it\\'s update'",
            "select \"update\" from t",
            "with x as (select 'delete') select * from x",
            "with \"update\" as (select 1) select * from \"update\"",
            "select (select 'update')",
            "explain update t set x=1",
            "explain (analyze false) delete from t",
            "explain (analyze off) delete from t",
            "explain (analyze 0) delete from t",
            "explain analyze select pg_sleep(1)",
        ] {
            assert!(!history_is_write(sql), "{sql}");
        }
    }

    #[test]
    fn titles_use_leading_comments_and_excerpts_are_single_line() {
        assert_eq!(
            history_text("-- Revenue by region\nSELECT region,\n count(*) FROM orders"),
            (
                "Revenue by region".into(),
                "SELECT region, count(*) FROM orders".into()
            )
        );
        assert_eq!(
            history_text("/* inventory */ update t set x=1").0,
            "inventory"
        );
        assert_eq!(history_text("select 1").0, "select 1");
        assert_eq!(history_text("/*🦀"), ("🦀".into(), "".into()));
        assert_eq!(history_text("/*é"), ("é".into(), "".into()));
        assert_eq!(history_text("/*"), ("SQL statement".into(), "".into()));
        assert!(history_text(&"界".repeat(500)).1.chars().count() <= 181);
    }
}
