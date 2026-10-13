#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StmtSpan {
    pub start: usize,
    pub end: usize,
}

impl StmtSpan {
    pub fn text<'a>(&self, sql: &'a str) -> &'a str {
        &sql[self.start..self.end]
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ByteTarget {
    Cursor(usize),
    Selection { from: usize, to: usize },
    All,
}

pub fn split_statements(sql: &str) -> Vec<StmtSpan> {
    let bytes = sql.as_bytes();
    let mut spans = Vec::new();
    let mut stmt_start = 0;
    let mut body_depth = 0usize;
    let mut last_word: Option<&str> = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(bytes.len(), |n| i + n);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = skip_block_comment(bytes, i),
            b'\'' => i = skip_quoted(bytes, i, b'\''),
            b'"' => i = skip_quoted(bytes, i, b'"'),
            b'$' => match dollar_tag(bytes, i) {
                Some(tag_len) => i = skip_dollar_quoted(bytes, i, tag_len),
                None => i += 1,
            },
            b';' if body_depth == 0 => {
                push_trimmed(&mut spans, sql, stmt_start, i);
                stmt_start = i + 1;
                i += 1;
                last_word = None;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let end = word_end(bytes, i);
                let word = &sql[i..end];
                if word.eq_ignore_ascii_case("ATOMIC") && last_word.is_some_and(|w| w.eq_ignore_ascii_case("BEGIN")) {
                    body_depth += 1;
                } else if body_depth > 0 && word.eq_ignore_ascii_case("CASE") {
                    body_depth += 1;
                } else if body_depth > 0 && word.eq_ignore_ascii_case("END") {
                    body_depth -= 1;
                }
                last_word = Some(word);
                i = end;
            }
            _ => i += 1,
        }
    }
    push_trimmed(&mut spans, sql, stmt_start, bytes.len());
    spans
}

pub fn pick(spans: &[StmtSpan], sql: &str, target: ByteTarget) -> Vec<StmtSpan> {
    match target {
        ByteTarget::All => spans.to_vec(),
        ByteTarget::Selection { from, to } if from < to => split_statements(&sql[from..to])
            .into_iter()
            .map(|s| StmtSpan {
                start: s.start + from,
                end: s.end + from,
            })
            .collect(),
        ByteTarget::Selection { from, .. } => pick(spans, sql, ByteTarget::Cursor(from)),
        ByteTarget::Cursor(off) => {
            let under = spans.iter().find(|s| s.start <= off && off <= terminator_end(sql, s));
            let previous = || spans.iter().rev().find(|s| s.end <= off);
            let next = || spans.iter().find(|s| s.start > off);
            under.or_else(previous).or_else(next).into_iter().copied().collect()
        }
    }
}

fn terminator_end(sql: &str, span: &StmtSpan) -> usize {
    let rest = &sql[span.end..];
    let ws = rest.len() - rest.trim_start().len();
    if rest[ws..].starts_with(';') { span.end + ws + 1 } else { span.end }
}

fn push_trimmed(spans: &mut Vec<StmtSpan>, sql: &str, start: usize, end: usize) {
    let text = &sql[start..end];
    let leading = text.len() - text.trim_start().len();
    let trimmed = text.trim();
    if trimmed.is_empty() || is_only_comments(trimmed) {
        return;
    }
    spans.push(StmtSpan {
        start: start + leading,
        end: start + leading + trimmed.len(),
    });
}

fn is_only_comments(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = text[i..].find('\n').map_or(bytes.len(), |n| i + n);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = skip_block_comment(bytes, i),
            c if c.is_ascii_whitespace() => i += 1,
            _ => return false,
        }
    }
    true
}

fn word_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    i
}

fn skip_block_comment(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            depth += 1;
            i += 2;
        } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    bytes.len()
}

fn skip_quoted(bytes: &[u8], i: usize, quote: u8) -> usize {
    let escapes = quote == b'\'' && i > 0 && (bytes[i - 1] == b'E' || bytes[i - 1] == b'e')
        && (i < 2 || !(bytes[i - 2].is_ascii_alphanumeric() || bytes[i - 2] == b'_'));
    let mut j = i + 1;
    while j < bytes.len() {
        if escapes && bytes[j] == b'\\' {
            j += 2;
        } else if bytes[j] == quote {
            if bytes.get(j + 1) == Some(&quote) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    bytes.len()
}

fn dollar_tag(bytes: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if j < bytes.len() && bytes[j].is_ascii_digit() {
        return None; // a positional parameter such as `$1`
    }
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
        j += 1;
    }
    (bytes.get(j) == Some(&b'$')).then_some(j + 1 - i)
}

fn skip_dollar_quoted(bytes: &[u8], i: usize, tag_len: usize) -> usize {
    let tag = &bytes[i..i + tag_len];
    let mut j = i + tag_len;
    while j + tag_len <= bytes.len() {
        if &bytes[j..j + tag_len] == tag {
            return j + tag_len;
        }
        j += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<&str> {
        split_statements(sql).iter().map(|s| s.text(sql)).collect()
    }

    #[test]
    fn splits_on_semicolons_and_trims() {
        assert_eq!(texts("select 1;\n  select 2  ;;\n"), vec!["select 1", "select 2"]);
        assert_eq!(texts("select 1"), vec!["select 1"]);
        assert_eq!(texts("  \n "), Vec::<&str>::new());
    }

    #[test]
    fn quotes_hide_semicolons() {
        assert_eq!(texts("select 'a;b'; select \"c;d\""), vec!["select 'a;b'", "select \"c;d\""]);
        assert_eq!(texts("select 'it''s;'; select 2"), vec!["select 'it''s;'", "select 2"]);
        assert_eq!(texts(r"select E'\';'; select 2"), vec![r"select E'\';'", "select 2"]);
        assert_eq!(texts(r"select e'a\\'; select 2"), vec![r"select e'a\\'", "select 2"]);
    }

    #[test]
    fn dollar_quotes_hide_semicolons_and_parameters_do_not() {
        let sql = "create function f() returns int language sql as $$ select 1; $$; select $1;";
        assert_eq!(
            texts(sql),
            vec!["create function f() returns int language sql as $$ select 1; $$", "select $1"]
        );
        let tagged = "do $body$ begin perform 1; end $body$; select 2";
        assert_eq!(texts(tagged), vec!["do $body$ begin perform 1; end $body$", "select 2"]);
    }

    #[test]
    fn comments_hide_semicolons_and_comment_only_chunks_vanish() {
        assert_eq!(texts("select 1 -- a;b\n; select 2"), vec!["select 1 -- a;b", "select 2"]);
        assert_eq!(texts("select /* x; /* nested; */ y */ 1; select 2"), vec!["select /* x; /* nested; */ y */ 1", "select 2"]);
        assert_eq!(texts("-- only a comment\n/* and another */"), Vec::<&str>::new());
        assert_eq!(texts("select 1; -- trailing"), vec!["select 1"]);
    }

    #[test]
    fn begin_atomic_bodies_keep_their_semicolons() {
        let sql = "create function f(x int) returns int begin atomic select case when x > 1 then 1 else 0 end; return x; end; select 2";
        assert_eq!(
            texts(sql),
            vec![
                "create function f(x int) returns int begin atomic select case when x > 1 then 1 else 0 end; return x; end",
                "select 2"
            ]
        );
    }

    #[test]
    fn plain_begin_still_splits() {
        assert_eq!(texts("begin; insert into t values (1); commit"), vec!["begin", "insert into t values (1)", "commit"]);
    }

    #[test]
    fn cursor_picks_the_statement_under_it_or_the_previous_one() {
        let sql = "select 1;\n\nselect 2;\n\n";
        let spans = split_statements(sql);
        let at = |off: usize| pick(&spans, sql, ByteTarget::Cursor(off)).iter().map(|s| s.text(sql)).collect::<Vec<_>>();
        assert_eq!(at(0), vec!["select 1"]);
        assert_eq!(at(8), vec!["select 1"]);
        assert_eq!(at(10), vec!["select 1"]);
        assert_eq!(at(13), vec!["select 2"]);
        assert_eq!(at(sql.len()), vec!["select 2"]);
    }

    #[test]
    fn cursor_before_everything_picks_the_first_statement() {
        let sql = "\n\n  select 1";
        let spans = split_statements(sql);
        assert_eq!(pick(&spans, sql, ByteTarget::Cursor(0)), vec![spans[0]]);
        assert!(pick(&[], "", ByteTarget::Cursor(0)).is_empty());
    }

    #[test]
    fn selection_runs_exactly_the_selected_text() {
        let sql = "select 1; select 2; select 3";
        let spans = split_statements(sql);
        let picked = pick(&spans, sql, ByteTarget::Selection { from: 10, to: 28 });
        assert_eq!(picked.iter().map(|s| s.text(sql)).collect::<Vec<_>>(), vec!["select 2", "select 3"]);
        let partial = pick(&spans, sql, ByteTarget::Selection { from: 7, to: 8 });
        assert_eq!(partial.iter().map(|s| s.text(sql)).collect::<Vec<_>>(), vec!["1"]);
        assert_eq!(pick(&spans, sql, ByteTarget::Selection { from: 5, to: 5 }), vec![spans[0]]);
        assert_eq!(pick(&spans, sql, ByteTarget::All), spans);
    }
}
