import type { ConnectionConfig, ConnectionState, DatabaseState } from "../ipc/bindings";

export const connectionConfig = (id: string, name: string): ConnectionConfig => ({
  id,
  name,
  host: "localhost",
  port: 5432,
  database: "shop",
  user: "u",
  sslMode: "Prefer",
  caCertPath: null,
  hasPassword: false,
  color: null,
});

export const databaseState = (name: string, shown: boolean, shownSchemas: string[]): DatabaseState => ({
  name,
  system: false,
  access: "Ok",
  shown,
  showSystemSchemas: false,
  shownSchemas,
  schemaCount: { kind: "Unknown" },
  catalog: { kind: "Ready", version: 1 },
});

export const connectedState = (id: string, databases: DatabaseState[]): ConnectionState => ({
  id,
  rev: 1,
  status: { kind: "Connected", server: { version: "16.4", versionNum: 160004, encoding: "UTF8" }, instance: { home: "shop", showSystemDatabases: false, databases } },
});
