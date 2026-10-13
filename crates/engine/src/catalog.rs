//! The 4 catalog queries that build a `Catalog` snapshot per connection.

use std::collections::HashMap;

use tokio_postgres::Client;

use crate::model::{Catalog, ColumnInfo, ConnectionId, FnKind, FunctionInfo, RelKind, Relation, SchemaInfo};

/// Visible user schemas: everything except the system and temp namespaces.
const SCHEMA_FILTER: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'";

pub async fn load(
    client: &Client,
    connection_id: ConnectionId,
    version: u64,
    database: String,
) -> Result<Catalog, tokio_postgres::Error> {
    let schema_rows = client
        .query(&format!("SELECT n.nspname FROM pg_namespace n WHERE {SCHEMA_FILTER} ORDER BY n.nspname"), &[])
        .await?;
    let mut schemas: Vec<SchemaInfo> = schema_rows
        .iter()
        .map(|r| SchemaInfo { name: r.get(0), relations: Vec::new(), functions: Vec::new() })
        .collect();
    let schema_index: HashMap<String, usize> = schemas.iter().enumerate().map(|(i, s)| (s.name.clone(), i)).collect();

    let relation_rows = client
        .query(
            &format!(
                "SELECT c.oid, n.nspname, c.relname, c.relkind::text, c.reltuples::float8
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {SCHEMA_FILTER}
                 ORDER BY c.relname"
            ),
            &[],
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
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey))
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {SCHEMA_FILTER}
                 ORDER BY a.attrelid, a.attnum"
            ),
            &[],
        )
        .await?;
    for r in &column_rows {
        let Some(&(si, ri)) = relation_index.get(&r.get::<_, u32>(0)) else { continue };
        schemas[si].relations[ri].columns.push(ColumnInfo {
            attnum: r.get(1),
            name: r.get(2),
            type_display: r.get(3),
            not_null: r.get(4),
            pk: r.get(5),
        });
    }

    let function_rows = client
        .query(
            &format!(
                "SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                        coalesce(pg_get_function_result(p.oid), ''), p.prokind::text
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE {SCHEMA_FILTER}
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

    Ok(Catalog { connection_id, version, database, schemas })
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
