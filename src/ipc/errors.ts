import type { ApplyError, ConfigureError, ConnectError, DisconnectError, ExportError, RunError, TxnError } from "./bindings";

export function connectErrorText(e: ConnectError): string {
  switch (e.kind) {
    case "Network":
    case "Tls":
    case "Auth":
    case "Keychain":
    case "Server":
      return e.message;
    case "MissingPassword":
      return "No password is saved for this connection. Edit the connection to set one.";
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function runErrorText(e: RunError): string {
  switch (e.kind) {
    case "Busy":
      return "This tab is still running. Cancel it first.";
    case "NoStatement":
      return "No statement at the cursor.";
    case "NotConfigured":
      return "Choose a connection for this tab.";
    case "Unsupported":
      return `${e.what} is not supported.`;
    case "Connect":
      return connectErrorText(e.error);
    case "BadFilter":
      return "WHERE and ORDER BY each take one expression, without a semicolon.";
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function applyErrorText(e: ApplyError): string {
  switch (e.kind) {
    case "Busy":
      return "This tab is still running. Cancel it first.";
    case "NotConfigured":
      return "Choose a connection for this tab.";
    case "Connect":
      return connectErrorText(e.error);
    case "TransactionAborted":
      return "This tab's transaction failed. Roll it back, then submit again.";
    case "NoPrimaryKey":
      return "Editing rows needs the table's primary key.";
    case "Failed":
    case "Transaction":
      return `Nothing was saved. ${e.error.message}`;
    case "RowMismatch": {
      const verb = e.change.kind === "Delete" ? "delete" : "update";
      return e.rows === 0
        ? `Nothing was saved. A row to ${verb} no longer exists. Reload and try again.`
        : `Nothing was saved. A row to ${verb} matched ${e.rows} rows.`;
    }
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function txnErrorText(e: TxnError): string {
  switch (e.kind) {
    case "Busy":
      return "Wait for the run to finish, or cancel it.";
    case "NoTransaction":
      return "There is no open transaction.";
    case "RolledBack":
      return "The transaction had failed, so it was rolled back instead.";
    case "Query":
      return e.message;
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function configureErrorText(e: ConfigureError): string {
  switch (e.kind) {
    case "TransactionOpen":
      return "Commit or roll back the open transaction first.";
    case "Busy":
      return "Wait for the run to finish, or cancel it.";
    case "UnknownConnection":
      return "That connection no longer exists.";
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function disconnectErrorText(e: DisconnectError): string {
  switch (e.kind) {
    case "OpenTransactions":
      return `${e.tabs.length} ${e.tabs.length === 1 ? "tab has" : "tabs have"} an open transaction.`;
    case "Store":
      return e.message;
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

export function exportErrorText(e: ExportError): string {
  return e.kind === "Gone" ? "This result is gone. Run the query again to export it." : e.message;
}
