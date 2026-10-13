use std::io::{self, Write};
use std::sync::RwLock;

use crate::model::{ColumnMeta, ResultMeta, ResultRef, RowPage, TruncateReason};

pub const CELL_CHAR_LIMIT: usize = 2_000;
pub const PAGE_LEN_MAX: u32 = 2_000;

const NULL: u32 = u32::MAX;

pub struct ResultSet {
    pub r#ref: ResultRef,
    pub columns: Vec<ColumnMeta>,
    data: RwLock<Arena>,
}

struct Arena {
    text: String,
    cells: Vec<(u32, u32)>,
    ncols: usize,
    rows_seen: u64,
    truncated: Option<TruncateReason>,
    elapsed_ms: u32,
}

pub struct Caps {
    pub max_rows: u32,
    pub max_bytes: u64,
}

impl ResultSet {
    pub fn new(r#ref: ResultRef, columns: Vec<ColumnMeta>) -> Self {
        let ncols = columns.len();
        Self {
            r#ref,
            columns,
            data: RwLock::new(Arena {
                text: String::new(),
                cells: Vec::new(),
                ncols,
                rows_seen: 0,
                truncated: None,
                elapsed_ms: 0,
            }),
        }
    }

    pub fn push_row<'a>(&self, cells: impl Iterator<Item = Option<&'a str>>, caps: &Caps) {
        let mut a = self.data.write().unwrap();
        a.rows_seen += 1;
        if a.truncated.is_some() {
            return;
        }
        if a.row_count() >= caps.max_rows {
            a.truncated = Some(TruncateReason::RowLimit);
            return;
        }
        let start_text = a.text.len();
        let start_cells = a.cells.len();
        for cell in cells {
            match cell {
                None => a.cells.push((0, NULL)),
                Some(s) => {
                    let start = a.text.len() as u32;
                    a.text.push_str(s);
                    a.cells.push((start, s.len() as u32));
                }
            }
        }
        if a.text.len() as u64 > caps.max_bytes || a.text.len() >= NULL as usize {
            a.text.truncate(start_text);
            a.cells.truncate(start_cells);
            a.truncated = Some(TruncateReason::ByteLimit);
        }
    }

    pub fn set_elapsed(&self, elapsed_ms: u32) {
        self.data.write().unwrap().elapsed_ms = elapsed_ms;
    }

    pub fn meta(&self) -> ResultMeta {
        let a = self.data.read().unwrap();
        ResultMeta {
            r#ref: self.r#ref,
            columns: self.columns.clone(),
            row_count: a.row_count(),
            rows_seen: a.rows_seen,
            truncated: a.truncated,
            elapsed_ms: a.elapsed_ms,
        }
    }

    pub fn page(&self, start: u32, len: u32) -> Option<RowPage> {
        let a = self.data.read().unwrap();
        let count = a.row_count();
        if start > count {
            return None;
        }
        let end = start.saturating_add(len.min(PAGE_LEN_MAX)).min(count);
        let mut cut = Vec::new();
        let rows = (start..end)
            .map(|r| {
                (0..a.ncols)
                    .map(|c| {
                        let value = a.cell(r as usize, c)?;
                        if value.chars().count() > CELL_CHAR_LIMIT {
                            cut.push((r, c as u16));
                            let keep = value.char_indices().nth(CELL_CHAR_LIMIT).map_or(value.len(), |(b, _)| b);
                            Some(value[..keep].to_owned())
                        } else {
                            Some(value.to_owned())
                        }
                    })
                    .collect()
            })
            .collect();
        Some(RowPage { start, rows, cut })
    }

    pub fn cell(&self, row: u32, col: u16) -> Option<Option<String>> {
        let a = self.data.read().unwrap();
        if row >= a.row_count() || col as usize >= a.ncols {
            return None;
        }
        Some(a.cell(row as usize, col as usize).map(str::to_owned))
    }

    pub fn write_csv(&self, out: &mut impl Write) -> io::Result<CsvSummary> {
        let a = self.data.read().unwrap();
        let mut w = CountingWriter { inner: out, bytes: 0 };
        write_record(&mut w, self.columns.iter().map(|c| Some(c.name.as_str())))?;
        let rows = a.row_count();
        for r in 0..rows as usize {
            write_record(&mut w, (0..a.ncols).map(|c| a.cell(r, c)))?;
        }
        w.flush()?;
        Ok(CsvSummary {
            rows: rows as u64,
            bytes: w.bytes,
            truncated: a.truncated.is_some(),
        })
    }
}

pub struct CsvSummary {
    pub rows: u64,
    pub bytes: u64,
    pub truncated: bool,
}

impl Arena {
    fn row_count(&self) -> u32 {
        if self.ncols == 0 { 0 } else { (self.cells.len() / self.ncols) as u32 }
    }

    fn cell(&self, row: usize, col: usize) -> Option<&str> {
        let (start, len) = self.cells[row * self.ncols + col];
        (len != NULL).then(|| &self.text[start as usize..(start + len) as usize])
    }
}

fn write_record<'a>(w: &mut impl Write, cells: impl Iterator<Item = Option<&'a str>>) -> io::Result<()> {
    for (i, cell) in cells.enumerate() {
        if i > 0 {
            w.write_all(b",")?;
        }
        match cell {
            None => {}
            Some(s) if s.is_empty() || s.contains(['"', ',', '\r', '\n']) => {
                w.write_all(b"\"")?;
                w.write_all(s.replace('"', "\"\"").as_bytes())?;
                w.write_all(b"\"")?;
            }
            Some(s) => w.write_all(s.as_bytes())?,
        }
    }
    w.write_all(b"\r\n")
}

struct CountingWriter<'a, W: Write> {
    inner: &'a mut W,
    bytes: u64,
}

impl<W: Write> Write for CountingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PgTypeRef, RunId, TabId, TypeCategory};

    fn set(ncols: usize) -> ResultSet {
        let columns = (0..ncols)
            .map(|i| ColumnMeta {
                name: format!("c{i}"),
                r#type: PgTypeRef { oid: 25, display: "text".into(), category: TypeCategory::Text },
                source: None,
            })
            .collect();
        ResultSet::new(ResultRef { tab_id: TabId(uuid::Uuid::nil()), run_id: RunId(1), index: 0 }, columns)
    }

    const NO_CAPS: Caps = Caps { max_rows: u32::MAX, max_bytes: u64::MAX };

    #[test]
    fn pages_and_cells_follow_the_arena() {
        let rs = set(2);
        rs.push_row([Some("a"), None].into_iter(), &NO_CAPS);
        rs.push_row([Some(""), Some("b,c")].into_iter(), &NO_CAPS);
        rs.push_row([Some("x"), Some("y")].into_iter(), &NO_CAPS);
        let page = rs.page(1, 10).unwrap();
        assert_eq!(page.start, 1);
        assert_eq!(page.rows, vec![vec![Some("".to_owned()), Some("b,c".to_owned())], vec![Some("x".into()), Some("y".into())]]);
        assert_eq!(rs.page(0, 1).unwrap().rows, vec![vec![Some("a".to_owned()), None]]);
        assert_eq!(rs.page(3, 5).unwrap().rows.len(), 0);
        assert!(rs.page(4, 5).is_none());
        assert_eq!(rs.cell(0, 1), Some(None));
        assert_eq!(rs.cell(1, 1), Some(Some("b,c".into())));
        assert!(rs.cell(3, 0).is_none());
        assert!(rs.cell(0, 2).is_none());
        assert_eq!(rs.meta().row_count, 3);
    }

    #[test]
    fn long_cells_are_cut_in_pages_but_whole_in_cell() {
        let rs = set(1);
        let long = "é".repeat(CELL_CHAR_LIMIT + 5);
        rs.push_row([Some(long.as_str())].into_iter(), &NO_CAPS);
        let page = rs.page(0, 1).unwrap();
        assert_eq!(page.cut, vec![(0, 0)]);
        assert_eq!(page.rows[0][0].as_ref().unwrap().chars().count(), CELL_CHAR_LIMIT);
        assert_eq!(rs.cell(0, 0), Some(Some(long)));
    }

    #[test]
    fn row_cap_drains_and_counts() {
        let rs = set(1);
        let caps = Caps { max_rows: 2, max_bytes: u64::MAX };
        for i in 0..5 {
            rs.push_row([Some(i.to_string().as_str())].into_iter(), &caps);
        }
        let meta = rs.meta();
        assert_eq!((meta.row_count, meta.rows_seen, meta.truncated), (2, 5, Some(TruncateReason::RowLimit)));
    }

    #[test]
    fn byte_cap_drops_the_row_that_crossed_it() {
        let rs = set(1);
        let caps = Caps { max_rows: u32::MAX, max_bytes: 5 };
        rs.push_row([Some("abc")].into_iter(), &caps);
        rs.push_row([Some("defg")].into_iter(), &caps);
        rs.push_row([Some("h")].into_iter(), &caps);
        let meta = rs.meta();
        assert_eq!((meta.row_count, meta.rows_seen, meta.truncated), (1, 3, Some(TruncateReason::ByteLimit)));
        assert_eq!(rs.cell(0, 0), Some(Some("abc".into())));
    }

    #[test]
    fn csv_quotes_like_copy_csv() {
        let rs = set(3);
        rs.push_row([Some("plain"), None, Some("")].into_iter(), &NO_CAPS);
        rs.push_row([Some("a,b"), Some("say \"hi\""), Some("line\nbreak")].into_iter(), &NO_CAPS);
        let mut out = Vec::new();
        let summary = rs.write_csv(&mut out).unwrap();
        let csv = String::from_utf8(out).unwrap();
        assert_eq!(csv, "c0,c1,c2\r\nplain,,\"\"\r\n\"a,b\",\"say \"\"hi\"\"\",\"line\nbreak\"\r\n");
        assert_eq!((summary.rows, summary.bytes, summary.truncated), (2, csv.len() as u64, false));
    }
}
