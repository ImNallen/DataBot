import { commands, type ConnectionId } from "../../ipc/bindings";
import { connectErrorText, disconnectErrorText } from "../../ipc/errors";
import { useWorkspace } from "../../state/workspace";

const ws = () => useWorkspace.getState();

export async function connect(id: ConnectionId): Promise<void> {
  const res = await commands.connectionConnect(id);
  if (res.status === "error") ws().notify(`${ws().configs[id]?.name ?? "Connection"}: ${connectErrorText(res.error)}`);
}

export async function disconnect(id: ConnectionId): Promise<void> {
  const res = await commands.connectionDisconnect(id, false);
  if (res.status === "ok") return;
  if (res.error.kind !== "OpenTransactions") {
    ws().notify(disconnectErrorText(res.error));
    return;
  }
  ws().open({
    kind: "confirm",
    title: "Disconnect with open transactions?",
    body: `${disconnectErrorText(res.error)} Disconnecting rolls it back.`,
    confirmLabel: "Roll back and disconnect",
    onConfirm: () => void commands.connectionDisconnect(id, true),
  });
}

export function confirmDelete(id: ConnectionId): void {
  const name = ws().configs[id]?.name ?? "this connection";
  ws().open({
    kind: "confirm",
    title: `Delete ${name}?`,
    body: "This removes the saved connection and its stored password. Query history is kept.",
    confirmLabel: "Delete",
    onConfirm: async () => {
      const res = await commands.connectionDelete(id);
      if (res.status === "error") ws().notify(disconnectErrorText(res.error));
      else ws().removeConfig(id);
    },
  });
}

export async function refreshCatalog(id: ConnectionId): Promise<void> {
  const res = await commands.catalogRefresh(id);
  if (res.status === "error") ws().notify("Connect first to refresh the catalog.");
}
