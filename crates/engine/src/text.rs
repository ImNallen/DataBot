use tokio_postgres::types::{Kind, Type};

use crate::model::{CellWrite, ColumnFilter, DocOffset, DocRange, FilterOp, PgTypeRef, ScriptOutline, TableQuery, TypeCategory};
use crate::sql::{self, ByteTarget, DmlVerb, StmtKind, StmtSpan};

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

/// `at_cursor` comes from `sql::pick`, so it names the statement a `Cursor` run would execute.
pub fn script_outline(text: &str, cursor: DocOffset) -> ScriptOutline {
    let map = OffsetMap::new(text);
    let spans = sql::split_statements(text);
    let picked = sql::pick(&spans, text, ByteTarget::Cursor(map.from_utf16(cursor)));
    ScriptOutline {
        statements: spans.iter().map(|s| map.range(s)).collect(),
        at_cursor: picked.first().and_then(|p| spans.iter().position(|s| s == p)).and_then(|i| u16::try_from(i).ok()),
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

/// The category of a type the catalog names by OID, with `typtype` and `typcategory` from `pg_type`.
/// The catalog resolves a domain to its base type first. User types carry no element or member
/// types here because the category never needs them.
pub fn catalog_category(oid: u32, typtype: i8, typcategory: i8) -> TypeCategory {
    let kind = match (typtype as u8, typcategory as u8) {
        (b'e', _) => Kind::Enum(Vec::new()),
        (b'c', _) => Kind::Composite(Vec::new()),
        (b'r', _) => Kind::Range(Type::UNKNOWN),
        (b'm', _) => Kind::Multirange(Type::UNKNOWN),
        (_, b'A') => Kind::Array(Type::UNKNOWN),
        _ => return Type::from_oid(oid).map_or(TypeCategory::Other, |t| type_category(&t)),
    };
    type_category(&Type::new(String::new(), oid, kind, String::new()))
}

fn type_category(t: &Type) -> TypeCategory {
    match t.kind() {
        Kind::Array(_) => TypeCategory::Array,
        Kind::Enum(_) => TypeCategory::Enum,
        Kind::Composite(_) => TypeCategory::Composite,
        Kind::Range(_) | Kind::Multirange(_) => TypeCategory::Range,
        Kind::Domain(inner) => type_category(inner),
        Kind::Simple | Kind::Pseudo => match *t {
            Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => TypeCategory::Integer,
            Type::FLOAT4 | Type::FLOAT8 | Type::NUMERIC | Type::MONEY => TypeCategory::Numeric,
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

pub fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn like_pattern(value: &str, prefix_only: bool) -> String {
    let escaped = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    quote_literal(&if prefix_only { format!("{escaped}%") } else { format!("%{escaped}%") })
}

fn filter_sql(f: &ColumnFilter) -> String {
    let col = quote_ident(&f.column);
    let lit = || quote_literal(&f.value);
    match f.op {
        FilterOp::Eq => format!("{col} = {}", lit()),
        FilterOp::Ne => format!("{col} <> {}", lit()),
        FilterOp::Lt => format!("{col} < {}", lit()),
        FilterOp::Le => format!("{col} <= {}", lit()),
        FilterOp::Gt => format!("{col} > {}", lit()),
        FilterOp::Ge => format!("{col} >= {}", lit()),
        FilterOp::Contains => format!("{col}::text ILIKE {}", like_pattern(&f.value, false)),
        FilterOp::StartsWith => format!("{col}::text ILIKE {}", like_pattern(&f.value, true)),
        FilterOp::IsNull => format!("{col} IS NULL"),
        FilterOp::NotNull => format!("{col} IS NOT NULL"),
    }
}

fn where_sql(q: &TableQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !q.r#where.trim().is_empty() {
        parts.push(format!("({}\n)", q.r#where.trim()));
    }
    parts.extend(q.filters.iter().map(filter_sql));
    if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) }
}

fn from_sql(schema: &str, table: &str, q: &TableQuery) -> String {
    format!("FROM {}.{}{}", quote_ident(schema), quote_ident(table), where_sql(q))
}

pub fn browse_sql(schema: &str, table: &str, pk: &[String], q: &TableQuery, limit: u32, offset: u64) -> String {
    let mut sql = format!("SELECT * {}", from_sql(schema, table, q));
    let mut order: Vec<String> = Vec::new();
    if !q.order_by.trim().is_empty() {
        order.push(format!("{}\n", q.order_by.trim()));
    }
    let tiebreak_so_pages_never_overlap = pk.iter().map(|c| quote_ident(c));
    order.extend(tiebreak_so_pages_never_overlap);
    if !order.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
    sql
}

pub fn count_sql(schema: &str, table: &str, q: &TableQuery) -> String {
    format!("SELECT count(*) {}", from_sql(schema, table, q))
}

fn value_sql(value: &Option<String>) -> String {
    value.as_deref().map_or_else(|| "NULL".into(), quote_literal)
}

fn key_sql(key: &[CellWrite]) -> String {
    key.iter()
        .map(|k| match &k.value {
            Some(v) => format!("{} = {}", quote_ident(&k.column), quote_literal(v)),
            None => format!("{} IS NULL", quote_ident(&k.column)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn target(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

pub fn insert_sql(schema: &str, table: &str, cells: &[CellWrite]) -> String {
    if cells.is_empty() {
        return format!("INSERT INTO {} DEFAULT VALUES", target(schema, table));
    }
    let cols: Vec<String> = cells.iter().map(|c| quote_ident(&c.column)).collect();
    let vals: Vec<String> = cells.iter().map(|c| value_sql(&c.value)).collect();
    format!("INSERT INTO {} ({}) VALUES ({})", target(schema, table), cols.join(", "), vals.join(", "))
}

pub fn update_sql(schema: &str, table: &str, key: &[CellWrite], set: &[CellWrite]) -> String {
    let assigns: Vec<String> = set.iter().map(|c| format!("{} = {}", quote_ident(&c.column), value_sql(&c.value))).collect();
    format!("UPDATE {} SET {} WHERE {}", target(schema, table), assigns.join(", "), key_sql(key))
}

pub fn delete_sql(schema: &str, table: &str, key: &[CellWrite]) -> String {
    format!("DELETE FROM {} WHERE {}", target(schema, table), key_sql(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(from: u32, to: u32) -> DocRange {
        DocRange { from: DocOffset(from), to: DocOffset(to) }
    }

    #[test]
    fn script_outline_lists_every_statement_and_preselects_the_one_under_the_cursor() {
        let text = "select 1 as one;\nselect * from public.orders limit 3;\nselect 'third' as three;";
        assert_eq!(
            script_outline(text, DocOffset(30)),
            ScriptOutline { statements: vec![r(0, 15), r(17, 52), r(54, 77)], at_cursor: Some(1) }
        );
    }

    #[test]
    fn script_outline_at_trailing_whitespace_picks_the_previous_statement() {
        let text = "select 1;   \n\nselect 2";
        assert_eq!(script_outline(text, DocOffset(11)), ScriptOutline { statements: vec![r(0, 8), r(14, 22)], at_cursor: Some(0) });
    }

    #[test]
    fn script_outline_splits_the_users_doc_at_its_blank_line() {
        let text = "SELECT * FROM public.addresses\nWHERE id > 5\nAND id < 10\nORDER BY id DESC\n\nselect * from public.categories";
        assert_eq!(script_outline(text, DocOffset(80)), ScriptOutline { statements: vec![r(0, 72), r(74, 105)], at_cursor: Some(1) });
        assert_eq!(script_outline(text, DocOffset(35)).at_cursor, Some(0));
    }

    #[test]
    fn script_outline_of_a_doc_without_statements_is_empty() {
        let none = ScriptOutline { statements: vec![], at_cursor: None };
        assert_eq!(script_outline("", DocOffset(0)), none);
        assert_eq!(script_outline("  -- nothing\n/* here */\n", DocOffset(5)), none);
    }

    #[test]
    fn script_outline_ranges_and_cursor_are_utf16() {
        let text = "-- 😀é\nselect 1;\nselect 2;";
        assert_eq!(script_outline(text, DocOffset(18)), ScriptOutline { statements: vec![r(0, 15), r(17, 25)], at_cursor: Some(1) });
    }

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
        assert_eq!((r.oid, r.display.as_str(), r.category), (20, "bigint", TypeCategory::Integer));
        assert_eq!(type_ref(&Type::INT4_ARRAY).display, "integer[]");
        assert_eq!(type_ref(&Type::INT4_ARRAY).category, TypeCategory::Array);
        assert_eq!(type_ref(&Type::TIMESTAMPTZ).display, "timestamptz");
        assert_eq!(type_ref(&Type::TIMESTAMPTZ).category, TypeCategory::Temporal);
        assert_eq!(type_ref(&Type::TEXT).category, TypeCategory::Text);
        assert_eq!(type_ref(&Type::BPCHAR).display, "char");
        assert_eq!(type_ref(&Type::NUMERIC).category, TypeCategory::Numeric);
        assert_eq!(type_ref(&Type::OID).category, TypeCategory::Integer);
        assert_eq!(type_ref(&Type::FLOAT8).category, TypeCategory::Numeric);
        assert_eq!(type_ref(&Type::JSONB).category, TypeCategory::Json);
        assert_eq!(type_ref(&Type::BYTEA).category, TypeCategory::Binary);
        assert_eq!(type_ref(&Type::UUID).category, TypeCategory::Uuid);
        assert_eq!(type_ref(&Type::INET).category, TypeCategory::Network);
        assert_eq!(type_ref(&Type::INT4_RANGE).category, TypeCategory::Range);
        assert_eq!(type_ref(&Type::POINT).category, TypeCategory::Other);
        assert_eq!(type_ref(&Type::BOOL).display, "boolean");
    }

    #[test]
    fn catalog_types_share_the_result_categories() {
        let (base, enumerated, composite, range, array) = (b'b' as i8, b'e' as i8, b'c' as i8, b'r' as i8, b'A' as i8);
        assert_eq!(catalog_category(20, base, b'N' as i8), TypeCategory::Integer);
        assert_eq!(catalog_category(1700, base, b'N' as i8), TypeCategory::Numeric);
        assert_eq!(catalog_category(25, base, b'S' as i8), TypeCategory::Text);
        assert_eq!(catalog_category(70000, enumerated, b'E' as i8), TypeCategory::Enum);
        assert_eq!(catalog_category(70001, composite, b'C' as i8), TypeCategory::Composite);
        assert_eq!(catalog_category(70002, range, b'R' as i8), TypeCategory::Range);
        assert_eq!(catalog_category(70003, base, array), TypeCategory::Array);
        assert_eq!(catalog_category(70004, base, b'U' as i8), TypeCategory::Other);
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
        assert_eq!(type_ref(&domain).category, TypeCategory::Integer);
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
        let none = TableQuery::default();
        assert_eq!(
            browse_sql("public", "orders", &["id".into()], &none, 500, 1000),
            r#"SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 500 OFFSET 1000"#
        );
        assert_eq!(
            browse_sql("we\"ird", "T;x", &["a\"b".into(), "c".into()], &none, 10, 0),
            r#"SELECT * FROM "we""ird"."T;x" ORDER BY "a""b", "c" LIMIT 10 OFFSET 0"#
        );
        assert_eq!(browse_sql("s", "t", &[], &none, 5, 0), r#"SELECT * FROM "s"."t" LIMIT 5 OFFSET 0"#);
    }

    fn filter(column: &str, op: FilterOp, value: &str) -> ColumnFilter {
        ColumnFilter { column: column.into(), op, value: value.into() }
    }

    #[test]
    fn browse_sql_puts_the_order_by_text_before_the_pk_tiebreak() {
        let q = TableQuery { order_by: " lower(name) DESC NULLS LAST ".into(), ..Default::default() };
        assert_eq!(
            browse_sql("public", "customers", &["id".into(), "tenant".into()], &q, 50, 0),
            "SELECT * FROM \"public\".\"customers\" ORDER BY lower(name) DESC NULLS LAST\n, \"id\", \"tenant\" LIMIT 50 OFFSET 0"
        );
    }

    #[test]
    fn browse_sql_ands_the_where_text_with_column_filters() {
        let q = TableQuery {
            r#where: " created_at > now() - interval '7 days' ".into(),
            filters: vec![filter("region", FilterOp::Eq, "O'Hare"), filter("email", FilterOp::NotNull, "")],
            ..Default::default()
        };
        assert_eq!(
            browse_sql("public", "customers", &[], &q, 10, 0),
            "SELECT * FROM \"public\".\"customers\" WHERE (created_at > now() - interval '7 days'\n) AND \"region\" = 'O''Hare' AND \"email\" IS NOT NULL LIMIT 10 OFFSET 0"
        );
        assert_eq!(
            count_sql("public", "customers", &q),
            "SELECT count(*) FROM \"public\".\"customers\" WHERE (created_at > now() - interval '7 days'\n) AND \"region\" = 'O''Hare' AND \"email\" IS NOT NULL"
        );
    }

    #[test]
    fn every_filter_op_compiles_and_like_patterns_escape_wildcards() {
        let ops = [
            (FilterOp::Eq, r#""n" = '5'"#),
            (FilterOp::Ne, r#""n" <> '5'"#),
            (FilterOp::Lt, r#""n" < '5'"#),
            (FilterOp::Le, r#""n" <= '5'"#),
            (FilterOp::Gt, r#""n" > '5'"#),
            (FilterOp::Ge, r#""n" >= '5'"#),
            (FilterOp::Contains, r#""n"::text ILIKE '%5%'"#),
            (FilterOp::StartsWith, r#""n"::text ILIKE '5%'"#),
            (FilterOp::IsNull, r#""n" IS NULL"#),
            (FilterOp::NotNull, r#""n" IS NOT NULL"#),
        ];
        for (op, sql) in ops {
            assert_eq!(filter_sql(&filter("n", op, "5")), sql, "{op:?}");
        }
        assert_eq!(filter_sql(&filter("n", FilterOp::Contains, r"50%_a\b")), r#""n"::text ILIKE '%50\%\_a\\b%'"#);
    }

    fn cell(column: &str, value: Option<&str>) -> CellWrite {
        CellWrite { column: column.into(), value: value.map(Into::into) }
    }

    #[test]
    fn edit_sql_quotes_names_and_values_and_writes_null() {
        assert_eq!(
            insert_sql("public", "customers", &[cell("name", Some("O'Neil")), cell("region", None)]),
            r#"INSERT INTO "public"."customers" ("name", "region") VALUES ('O''Neil', NULL)"#
        );
        assert_eq!(insert_sql("public", "customers", &[]), r#"INSERT INTO "public"."customers" DEFAULT VALUES"#);
        assert_eq!(
            update_sql("public", "line items", &[cell("order_id", Some("7")), cell("sku", Some("A-1"))], &[cell("qty", Some("3")), cell("note", None)]),
            r#"UPDATE "public"."line items" SET "qty" = '3', "note" = NULL WHERE "order_id" = '7' AND "sku" = 'A-1'"#
        );
        assert_eq!(delete_sql("public", "customers", &[cell("id", Some("42"))]), r#"DELETE FROM "public"."customers" WHERE "id" = '42'"#);
    }
}
