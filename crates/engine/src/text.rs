use tokio_postgres::types::{Kind, Type};

use crate::model::{DocOffset, DocRange, PgTypeRef, TypeCategory};
use crate::sql::{DmlVerb, StmtKind, StmtSpan};

pub struct OffsetMap<'a> {
    text: &'a str,
}

impl<'a> OffsetMap<'a> {
    pub fn new(text: &'a str) -> Self {
        Self { text }
    }

    pub fn to_utf16(&self, byte: usize) -> DocOffset {
        let byte = byte.min(self.text.len());
        DocOffset(self.text[..byte].encode_utf16().count() as u32)
    }

    pub fn from_utf16(&self, off: DocOffset) -> usize {
        let mut units = 0u32;
        for (byte, ch) in self.text.char_indices() {
            if units + ch.len_utf16() as u32 > off.0 {
                return byte;
            }
            units += ch.len_utf16() as u32;
        }
        self.text.len()
    }

    pub fn range(&self, span: &StmtSpan) -> DocRange {
        DocRange {
            from: self.to_utf16(span.start),
            to: self.to_utf16(span.end),
        }
    }

    /// PG `ErrorPosition::Original(n)` is a 1-based character index within the statement.
    pub fn pg_position(&self, stmt: &StmtSpan, n: u32) -> DocOffset {
        let byte = stmt
            .text(self.text)
            .char_indices()
            .nth((n.max(1) - 1) as usize)
            .map_or(stmt.end, |(b, _)| stmt.start + b);
        self.to_utf16(byte)
    }
}

pub fn type_ref(t: &Type) -> PgTypeRef {
    PgTypeRef {
        oid: t.oid(),
        display: type_display(t),
        category: type_category(t),
    }
}

fn type_display(t: &Type) -> String {
    match t.kind() {
        Kind::Array(elem) => format!("{}[]", type_display(elem)),
        _ if t.schema() == "pg_catalog" => builtin_name(t.name()).to_owned(),
        _ if t.schema() == "public" => t.name().to_owned(),
        _ => format!("{}.{}", t.schema(), t.name()),
    }
}

fn builtin_name(internal: &str) -> &str {
    match internal {
        "int8" => "bigint",
        "int4" => "integer",
        "int2" => "smallint",
        "float4" => "real",
        "float8" => "double precision",
        "bool" => "boolean",
        "bpchar" => "char",
        other => other,
    }
}

fn type_category(t: &Type) -> TypeCategory {
    match t.kind() {
        Kind::Array(_) => TypeCategory::Array,
        Kind::Enum(_) => TypeCategory::Enum,
        Kind::Composite(_) => TypeCategory::Composite,
        Kind::Range(_) | Kind::Multirange(_) => TypeCategory::Range,
        Kind::Domain(inner) => type_category(inner),
        Kind::Simple | Kind::Pseudo => match *t {
            Type::INT2 | Type::INT4 | Type::INT8 | Type::FLOAT4 | Type::FLOAT8 | Type::NUMERIC | Type::MONEY | Type::OID => {
                TypeCategory::Numeric
            }
            Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::CHAR | Type::XML => TypeCategory::Text,
            Type::BOOL => TypeCategory::Bool,
            Type::DATE | Type::TIME | Type::TIMETZ | Type::TIMESTAMP | Type::TIMESTAMPTZ | Type::INTERVAL => TypeCategory::Temporal,
            Type::JSON | Type::JSONB => TypeCategory::Json,
            Type::BYTEA => TypeCategory::Binary,
            Type::UUID => TypeCategory::Uuid,
            Type::INET | Type::CIDR | Type::MACADDR | Type::MACADDR8 => TypeCategory::Network,
            _ => TypeCategory::Other,
        },
        _ => TypeCategory::Other,
    }
}

/// tokio-postgres exposes only the row count of a command completion, so the tag is rebuilt
/// from the classified verb the way Postgres would print it.
pub fn synthesize_tag(kind: &StmtKind, rows: u64) -> String {
    match kind {
        StmtKind::Begin => "BEGIN".into(),
        StmtKind::Commit => "COMMIT".into(),
        StmtKind::Rollback | StmtKind::RollbackTo => "ROLLBACK".into(),
        StmtKind::Savepoint => "SAVEPOINT".into(),
        StmtKind::Release => "RELEASE".into(),
        StmtKind::Ddl(tag) | StmtKind::NoTxnBlock(tag) | StmtKind::Other(tag) => tag.clone(),
        StmtKind::Dml(DmlVerb::Insert) => format!("INSERT 0 {rows}"),
        StmtKind::Dml(DmlVerb::Update) => format!("UPDATE {rows}"),
        StmtKind::Dml(DmlVerb::Delete) => format!("DELETE {rows}"),
        StmtKind::Dml(DmlVerb::Merge) => format!("MERGE {rows}"),
        StmtKind::Query => format!("SELECT {rows}"),
        StmtKind::CopyStdio => "COPY".into(),
    }
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn browse_sql(schema: &str, table: &str, pk: &[String], limit: u32, offset: u64) -> String {
    let mut sql = format!("SELECT * FROM {}.{}", quote_ident(schema), quote_ident(table));
    if !pk.is_empty() {
        let cols: Vec<String> = pk.iter().map(|c| quote_ident(c)).collect();
        sql.push_str(&format!(" ORDER BY {}", cols.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_round_trip_past_emoji_and_cjk() {
        let text = "select '😀漢'; select x";
        let map = OffsetMap::new(text);
        let x = text.find("select x").unwrap();
        assert_eq!(map.to_utf16(x), DocOffset(14));
        assert_eq!(map.from_utf16(DocOffset(14)), x);
        assert_eq!(map.from_utf16(DocOffset(9)), 8, "inside the surrogate pair snaps to its start");
        assert_eq!(map.from_utf16(DocOffset(999)), text.len());
        assert_eq!(map.to_utf16(999), DocOffset(text.encode_utf16().count() as u32));
    }

    #[test]
    fn pg_position_is_one_based_chars_within_the_statement() {
        let text = "select 1;\nselect '😀', nope from t";
        let spans = crate::sql::split_statements(text);
        let map = OffsetMap::new(text);
        let stmt = spans[1].text(text);
        let nope_char = stmt[..stmt.find("nope").unwrap()].chars().count() as u32 + 1;
        let doc = map.pg_position(&spans[1], nope_char);
        let expected = text[..text.find("nope").unwrap()].encode_utf16().count() as u32;
        assert_eq!(doc, DocOffset(expected));
        assert_eq!(map.pg_position(&spans[0], 1), DocOffset(0));
        assert_eq!(map.pg_position(&spans[0], 0), DocOffset(0));
        assert_eq!(map.pg_position(&spans[0], 500), map.to_utf16(spans[0].end));
    }

    #[test]
    fn builtin_and_array_names() {
        let r = type_ref(&Type::INT8);
        assert_eq!((r.oid, r.display.as_str(), r.category), (20, "bigint", TypeCategory::Numeric));
        assert_eq!(type_ref(&Type::INT4_ARRAY).display, "integer[]");
        assert_eq!(type_ref(&Type::INT4_ARRAY).category, TypeCategory::Array);
        assert_eq!(type_ref(&Type::TIMESTAMPTZ).display, "timestamptz");
        assert_eq!(type_ref(&Type::TIMESTAMPTZ).category, TypeCategory::Temporal);
        assert_eq!(type_ref(&Type::TEXT).category, TypeCategory::Text);
        assert_eq!(type_ref(&Type::BPCHAR).display, "char");
        assert_eq!(type_ref(&Type::NUMERIC).category, TypeCategory::Numeric);
        assert_eq!(type_ref(&Type::JSONB).category, TypeCategory::Json);
        assert_eq!(type_ref(&Type::BYTEA).category, TypeCategory::Binary);
        assert_eq!(type_ref(&Type::UUID).category, TypeCategory::Uuid);
        assert_eq!(type_ref(&Type::INET).category, TypeCategory::Network);
        assert_eq!(type_ref(&Type::INT4_RANGE).category, TypeCategory::Range);
        assert_eq!(type_ref(&Type::POINT).category, TypeCategory::Other);
        assert_eq!(type_ref(&Type::BOOL).display, "boolean");
    }

    #[test]
    fn user_types_show_schema_outside_public() {
        let public_enum = Type::new("mood".into(), 70000, Kind::Enum(vec![]), "public".into());
        assert_eq!(type_ref(&public_enum).display, "mood");
        assert_eq!(type_ref(&public_enum).category, TypeCategory::Enum);
        let lab_enum = Type::new("mood".into(), 70001, Kind::Enum(vec![]), "lab".into());
        assert_eq!(type_ref(&lab_enum).display, "lab.mood");
        let arr = Type::new("_mood".into(), 70002, Kind::Array(lab_enum), "lab".into());
        assert_eq!(type_ref(&arr).display, "lab.mood[]");
        let domain = Type::new("posint".into(), 70003, Kind::Domain(Type::INT4), "public".into());
        assert_eq!(type_ref(&domain).category, TypeCategory::Numeric);
    }

    #[test]
    fn tags() {
        assert_eq!(synthesize_tag(&StmtKind::Dml(DmlVerb::Insert), 3), "INSERT 0 3");
        assert_eq!(synthesize_tag(&StmtKind::Dml(DmlVerb::Update), 3), "UPDATE 3");
        assert_eq!(synthesize_tag(&StmtKind::Query, 6), "SELECT 6");
        assert_eq!(synthesize_tag(&StmtKind::Ddl("CREATE TABLE".into()), 0), "CREATE TABLE");
        assert_eq!(synthesize_tag(&StmtKind::Begin, 0), "BEGIN");
        assert_eq!(synthesize_tag(&StmtKind::Other("SET".into()), 0), "SET");
    }

    #[test]
    fn browse_sql_quotes_identifiers_and_orders_by_pk() {
        assert_eq!(
            browse_sql("public", "orders", &["id".into()], 500, 1000),
            r#"SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 500 OFFSET 1000"#
        );
        assert_eq!(
            browse_sql("we\"ird", "T;x", &["a\"b".into(), "c".into()], 10, 0),
            r#"SELECT * FROM "we""ird"."T;x" ORDER BY "a""b", "c" LIMIT 10 OFFSET 0"#
        );
        assert_eq!(browse_sql("s", "t", &[], 5, 0), r#"SELECT * FROM "s"."t" LIMIT 5 OFFSET 0"#);
    }
}
