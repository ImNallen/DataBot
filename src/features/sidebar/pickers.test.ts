import { describe, expect, it } from "vitest";
import type { Catalog, ConnectionConfig, DatabaseState, InstanceState, SchemaInfo } from "../../ipc/bindings";
import { countText, databaseCount, databasePicker, namesToProbe, pickerBox, schemaCount, schemaPicker } from "./pickers";

const config: ConnectionConfig = {
  id: "c1",
  name: "prod-postgres",
  host: "localhost",
  port: 5432,
  database: "shop",
  user: "u",
  sslMode: "Prefer",
  caCertPath: null,
  hasPassword: false,
  color: null,
};

const db = (name: string, over: Partial<DatabaseState> = {}): DatabaseState => ({
  name,
  system: false,
  access: "Ok",
  shown: false,
  showSystemSchemas: false,
  shownSchemas: [],
  schemaCount: { kind: "Unknown" },
  catalog: { kind: "Idle" },
  ...over,
});

const instance = (databases: DatabaseState[], showSystemDatabases = false): InstanceState => ({ home: "shop", showSystemDatabases, databases });

const prod = instance([
  db("legacy_crm", { schemaCount: { kind: "Known", count: 2 } }),
  db("postgres", { schemaCount: { kind: "Known", count: 1 } }),
  db("reporting", { shown: true, schemaCount: { kind: "Probing" } }),
  db("secret", { access: "NoPrivilege" }),
  db("shop", { shown: true, schemaCount: { kind: "Known", count: 4 } }),
  db("template1", { system: true, access: "NoConnections" }),
  db("vault", { schemaCount: { kind: "Unavailable", message: "permission denied for database vault" } }),
]);

const schema = (name: string, tableCount: number, system = false): SchemaInfo => ({ name, system, tableCount, relations: [], functions: [] });

const shopCatalog: Catalog = {
  db: { connectionId: "c1", database: "shop" },
  version: 3,
  defaultSchema: "public",
  schemas: [schema("analytics_tmp", 1), schema("audit", 2), schema("billing", 3), schema("information_schema", 4, true), schema("pg_catalog", 64, true), schema("public", 13)],
};

const shopState = db("shop", { shown: true, shownSchemas: ["audit", "pg_catalog", "public"], catalog: { kind: "Ready", version: 3 } });

describe("databaseCount", () => {
  it("counts the databases the user can show, leaving out system ones until they are listed", () => {
    expect(databaseCount(prod)).toEqual({ shown: 2, total: 5, warn: false });
    const listed = instance([db("shop", { shown: true }), db("template1", { system: true, shown: true })], true);
    expect(databaseCount(listed)).toEqual({ shown: 2, total: 2, warn: false });
  });

  it("warns when nothing is shown out of something", () => {
    expect(databaseCount(instance([db("a"), db("b")]))).toEqual({ shown: 0, total: 2, warn: true });
    expect(databaseCount(instance([]))).toEqual({ shown: 0, total: 0, warn: false });
  });
});

describe("schemaCount", () => {
  it("is null until the catalog is in", () => {
    expect(schemaCount(shopState, undefined)).toBeNull();
  });

  it("counts shown user schemas, and system ones only while they are listed", () => {
    expect(schemaCount(shopState, shopCatalog)).toEqual({ shown: 2, total: 4, warn: false });
    expect(schemaCount({ ...shopState, showSystemSchemas: true }, shopCatalog)).toEqual({ shown: 3, total: 6, warn: false });
    expect(schemaCount({ ...shopState, shownSchemas: [] }, shopCatalog)).toEqual({ shown: 0, total: 4, warn: true });
  });
});

describe("countText", () => {
  it("reads shown over total", () => {
    expect(countText({ shown: 2, total: 4, warn: false })).toBe("2/4");
  });
});

describe("databasePicker", () => {
  it("lists the server's databases with their schema counts and access", () => {
    const m = databasePicker(config, prod, "");
    expect(m.title).toBe("Databases in prod-postgres");
    expect(m.subtitle).toBe("2 of 5 databases shown");
    expect(m.placeholder).toBe("Find a database");
    expect(m.footnote).toBe("Adding a database also shows its default schema");
    expect(m.systemLabel).toBe("Show system databases");
    expect(m.showSystem).toBe(false);
    expect(m.items).toEqual([
      { name: "legacy_crm", checked: false, isDefault: false, system: false, disabled: false, trailing: "2 schemas" },
      { name: "postgres", checked: false, isDefault: false, system: false, disabled: false, trailing: "1 schema" },
      { name: "reporting", checked: true, isDefault: false, system: false, disabled: false, trailing: "…" },
      { name: "secret", checked: false, isDefault: false, system: false, disabled: true, trailing: "no access", trailingTitle: "No CONNECT privilege" },
      { name: "shop", checked: true, isDefault: true, system: false, disabled: false, trailing: "4 schemas" },
      {
        name: "vault",
        checked: false,
        isDefault: false,
        system: false,
        disabled: false,
        trailing: "no access",
        trailingTitle: "permission denied for database vault",
      },
    ]);
  });

  it("lists system databases only while they are shown, and says why one is closed", () => {
    const m = databasePicker(config, { ...prod, showSystemDatabases: true }, "templ");
    expect(m.showSystem).toBe(true);
    expect(m.items).toEqual([
      { name: "template1", checked: false, isDefault: false, system: true, disabled: true, trailing: "no access", trailingTitle: "Connections are not allowed" },
    ]);
  });

  it("filters by a case-insensitive substring and keeps the subtitle on the whole list", () => {
    const m = databasePicker(config, prod, " CR ");
    expect(m.items.map((i) => i.name)).toEqual(["legacy_crm", "secret"]);
    expect(m.subtitle).toBe("2 of 5 databases shown");
  });

  it("says database for a server with one", () => {
    expect(databasePicker(config, instance([db("shop", { shown: true })]), "").subtitle).toBe("1 of 1 database shown");
  });

  it("builds the engine's intents", () => {
    const m = databasePicker(config, prod, "");
    expect(m.preset("DefaultOnly")).toEqual({ kind: "Databases", preset: "DefaultOnly" });
    expect(m.toggle("legacy_crm", true)).toEqual({ kind: "Database", name: "legacy_crm", shown: true });
    expect(m.setShowSystem(true)).toEqual({ kind: "ShowSystemDatabases", show: true });
  });
});

describe("schemaPicker", () => {
  it("lists the database's schemas with their table counts", () => {
    const m = schemaPicker(shopState, shopCatalog, "");
    expect(m.title).toBe("Schemas in shop");
    expect(m.subtitle).toBe("2 of 4 schemas shown");
    expect(m.placeholder).toBe("Find a schema");
    expect(m.footnote).toBeNull();
    expect(m.systemLabel).toBe("Show system schemas");
    expect(m.items).toEqual([
      { name: "analytics_tmp", checked: false, isDefault: false, trailing: "1 table", disabled: false, system: false },
      { name: "audit", checked: true, isDefault: false, trailing: "2 tables", disabled: false, system: false },
      { name: "billing", checked: false, isDefault: false, trailing: "3 tables", disabled: false, system: false },
      { name: "public", checked: true, isDefault: true, trailing: "13 tables", disabled: false, system: false },
    ]);
  });

  it("lists system schemas while they are shown, filtered like the database picker", () => {
    const m = schemaPicker({ ...shopState, showSystemSchemas: true }, shopCatalog, "PG_");
    expect(m.showSystem).toBe(true);
    expect(m.subtitle).toBe("3 of 6 schemas shown");
    expect(m.items).toEqual([{ name: "pg_catalog", checked: true, isDefault: false, trailing: "64 tables", disabled: false, system: true }]);
  });

  it("builds the engine's intents for its database", () => {
    const m = schemaPicker(shopState, shopCatalog, "");
    expect(m.preset("None")).toEqual({ kind: "Schemas", database: "shop", preset: "None" });
    expect(m.toggle("billing", true)).toEqual({ kind: "Schema", database: "shop", name: "billing", shown: true });
    expect(m.setShowSystem(false)).toEqual({ kind: "ShowSystemSchemas", database: "shop", show: false });
  });
});

describe("namesToProbe", () => {
  it("asks only for visible, reachable databases whose count is unknown", () => {
    const more = instance([...prod.databases, db("archive"), db("zeta")]);
    const visible = databasePicker(config, more, "").items.filter((i) => i.name !== "zeta");
    expect(namesToProbe(more, visible)).toEqual(["archive"]);
    expect(namesToProbe(more, databasePicker(config, more, "").items)).toEqual(["archive", "zeta"]);
  });
});

describe("pickerBox", () => {
  const window_ = { width: 1280, height: 577 };

  it("widens past a 256 px sidebar's 240 px row to 288 px, from the row's left edge", () => {
    expect(pickerBox({ left: 8, bottom: 122, width: 240 }, window_)).toEqual({ top: 126, left: 8, width: 288, maxHeight: 443 });
  });

  it("matches a row wider than 288 px", () => {
    expect(pickerBox({ left: 8, bottom: 122, width: 400 }, window_)).toEqual({ top: 126, left: 8, width: 400, maxHeight: 443 });
  });

  it("stays inside a narrow window", () => {
    expect(pickerBox({ left: 8, bottom: 122, width: 240 }, { width: 280, height: 577 })).toEqual({ top: 126, left: 8, width: 264, maxHeight: 443 });
    expect(pickerBox({ left: 120, bottom: 122, width: 240 }, { width: 400, height: 577 })).toEqual({ top: 126, left: 104, width: 288, maxHeight: 443 });
  });
});
