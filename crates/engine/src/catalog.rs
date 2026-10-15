use std::collections::HashMap;

use tokio_postgres::Client;

use crate::connection::PgDatabase;
use crate::model::{Catalog, ColumnInfo, DatabaseRef, DbAccess, FnKind, FunctionInfo, RelKind, Relation, SchemaInfo};
use crate::text;

/// Postgres reserves the `pg_` prefix for its own schemas. `view::is_system_schema` is the same
/// rule in Rust.
const SYSTEM_SCHEMA: &str = "(n.nspname = 'information_schema' OR n.nspname LIKE 'pg\\_%')";
/// Toast and temp schemas are listed nowhere.
const UNLISTED_SCHEMA: &str = "(n.nspname = 'pg_toast' OR n.nspname LIKE 'pg\\_temp\\_%' OR n.nspname LIKE 'pg\\_toast\\_temp\\_%')";
/// Relations and columns: every user schema, plus the system schemas named in `$1`.
const RELATION_SCHEMA_FILTER: &str = "NOT (n.nspname = 'pg_toast' OR n.nspname LIKE 'pg\\_temp\\_%' OR n.nspname LIKE 'pg\\_toast\\_temp\\_%')
    AND (NOT (n.nspname = 'information_schema' OR n.nspname LIKE 'pg\\_%') OR n.nspname = ANY($1))";
/// Functions: user schemas only. `pg_catalog` alone has about 3,000.
const FUNCTION_SCHEMA_FILTER: &str = "NOT (n.nspname = 'information_schema' OR n.nspname LIKE 'pg\\_%')";

/// Every database on the server, plus the server's spelling of the one this session is on.
pub async fn list_databases(client: &Client) -> Result<(Vec<PgDatabase>, String), tokio_postgres::Error> {
    let rows = client
        .query(
            "SELECT datname, datistemplate OR NOT datallowconn, datallowconn, has_database_privilege(datname, 'CONNECT'),
                    datname = current_database()
             FROM pg_database ORDER BY datname",
            &[],
        )
        .await?;
    let mut home = String::new();
    let databases = rows
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            if r.get::<_, bool>(4) {
                home = name.clone();
            }
            let access = if !r.get::<_, bool>(2) {
                DbAccess::NoConnections
            } else if !r.get::<_, bool>(3) {
                DbAccess::NoPrivilege
            } else {
                DbAccess::Ok
            };
            PgDatabase { name, system: r.get(1), access }
        })
        .collect();
    Ok((databases, home))
}

/// The non-system schema count, run on a short-lived probe session.
pub async fn count_schemas(client: &Client) -> Result<u32, tokio_postgres::Error> {
    let row = client.query_one(&format!("SELECT count(*) FROM pg_namespace n WHERE NOT {SYSTEM_SCHEMA}"), &[]).await?;
    Ok(row.get::<_, i64>(0) as u32)
}

/// The first non-system schema of the search path that exists, else `public`, else the first
/// non-system schema by name. A search path that starts with `pg_catalog` must not make the
/// default a system schema: "Default only" would then show a schema the picker hides.
fn default_schema(search_path: &[String], schemas: &[SchemaInfo]) -> Option<String> {
    let user = |name: &str| schemas.iter().find(|s| s.name == name && !s.system);
    search_path
        .iter()
        .find_map(|s| user(s))
        .or_else(|| user("public"))
        .or_else(|| schemas.iter().find(|s| !s.system))
        .map(|s| s.name.clone())
}

/// Five queries on one database's metadata session. Every schema is listed with its `system` flag
/// and table count; relations and columns load for user schemas and for the system schemas in
/// `extra_schemas`; functions load for user schemas only.
pub async fn load(client: &Client, db: DatabaseRef, version: u64, extra_schemas: &[String]) -> Result<Catalog, tokio_postgres::Error> {
    let schema_rows = client
        .query(
            &format!(
                "SELECT n.nspname, {SYSTEM_SCHEMA},
                        (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'f'))::int4
                 FROM pg_namespace n WHERE NOT {UNLISTED_SCHEMA} ORDER BY n.nspname"
            ),
            &[],
        )
        .await?;
    let mut schemas: Vec<SchemaInfo> = schema_rows
        .iter()
        .map(|r| SchemaInfo { name: r.get(0), system: r.get(1), table_count: r.get::<_, i32>(2) as u32, relations: Vec::new(), functions: Vec::new() })
        .collect();
    let schema_index: HashMap<String, usize> = schemas.iter().enumerate().map(|(i, s)| (s.name.clone(), i)).collect();

    let search_path: Vec<String> = client.query_one("SELECT current_schemas(false)::text[]", &[]).await?.get(0);
    let default_schema = default_schema(&search_path, &schemas);

    let relation_rows = client
        .query(
            &format!(
                "SELECT c.oid, n.nspname, c.relname, c.relkind::text, c.reltuples::float8
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {RELATION_SCHEMA_FILTER}
                 ORDER BY c.relname"
            ),
            &[&extra_schemas],
        )
        .await?;
    let mut relation_index: HashMap<u32, (usize, usize)> = HashMap::new();
    for r in &relation_rows {
        let oid: u32 = r.get(0);
        let schema: String = r.get(1);
        let kind = match r.get::<_, String>(3).as_str() {
            "p" => RelKind::PartitionedTable,
            "v" => RelKind::View,
            "m" => RelKind::MaterializedView,
            "f" => RelKind::ForeignTable,
            _ => RelKind::Table,
        };
        let reltuples: f64 = r.get(4);
        let Some(&si) = schema_index.get(&schema) else { continue };
        relation_index.insert(oid, (si, schemas[si].relations.len()));
        schemas[si].relations.push(Relation {
            oid,
            name: r.get(2),
            kind,
            row_estimate: (reltuples >= 0.0).then_some(reltuples.round() as i64),
            columns: Vec::new(),
        });
    }

    let column_rows = client
        .query(
            &format!(
                "SELECT a.attrelid, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)),
                        EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)),
                        t.oid, t.typtype, t.typcategory
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_type declared ON declared.oid = a.atttypid
                 JOIN pg_type t ON t.oid = CASE WHEN declared.typtype = 'd' THEN declared.typbasetype ELSE declared.oid END
                 WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {RELATION_SCHEMA_FILTER}
                 ORDER BY a.attrelid, a.attnum"
            ),
            &[&extra_schemas],
        )
        .await?;
    for r in &column_rows {
        let Some(&(si, ri)) = relation_index.get(&r.get::<_, u32>(0)) else { continue };
        schemas[si].relations[ri].columns.push(ColumnInfo {
            attnum: r.get(1),
            name: r.get(2),
            type_display: r.get(3),
            category: text::catalog_category(r.get(7), r.get(8), r.get(9)),
            not_null: r.get(4),
            pk: r.get(5),
            fk: r.get(6),
        });
    }

    let function_rows = client
        .query(
            &format!(
                "SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                        coalesce(pg_get_function_result(p.oid), ''), p.prokind::text
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE {FUNCTION_SCHEMA_FILTER}
                 ORDER BY p.proname, p.oid"
            ),
            &[],
        )
        .await?;
    for r in &function_rows {
        let Some(&si) = schema_index.get(&r.get::<_, String>(1)) else { continue };
        let kind = match r.get::<_, String>(5).as_str() {
            "p" => FnKind::Procedure,
            "a" => FnKind::Aggregate,
            "w" => FnKind::Window,
            _ => FnKind::Function,
        };
        schemas[si].functions.push(FunctionInfo {
            oid: r.get(0),
            name: r.get(2),
            args: r.get(3),
            returns: r.get(4),
            kind,
        });
    }

    Ok(Catalog { db, version, default_schema, schemas })
}

impl Catalog {
    pub fn relation(&self, schema: &str, table: &str) -> Option<&Relation> {
        self.schemas.iter().find(|s| s.name == schema)?.relations.iter().find(|r| r.name == table)
    }
}

impl Relation {
    pub fn pk_columns(&self) -> Vec<String> {
        self.columns.iter().filter(|c| c.pk).map(|c| c.name.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(name: &str, system: bool) -> SchemaInfo {
        SchemaInfo { name: name.into(), system, table_count: 0, relations: Vec::new(), functions: Vec::new() }
    }

    fn path(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn the_default_schema_is_never_a_system_schema() {
        let schemas = [schema("audit", false), schema("information_schema", true), schema("pg_catalog", true), schema("public", false)];
        assert_eq!(default_schema(&path(&["pg_catalog", "public"]), &schemas).as_deref(), Some("public"));
        assert_eq!(default_schema(&path(&["pg_catalog", "audit"]), &schemas).as_deref(), Some("audit"));
        assert_eq!(default_schema(&path(&["missing"]), &schemas).as_deref(), Some("public"), "a search path with nothing to show falls back to public");
        let no_public = [schema("audit", false), schema("pg_catalog", true)];
        assert_eq!(default_schema(&path(&["pg_catalog"]), &no_public).as_deref(), Some("audit"), "then the first user schema");
        assert_eq!(default_schema(&path(&["pg_catalog"]), &[schema("pg_catalog", true)]), None, "a database with only system schemas has no default");
    }
}
