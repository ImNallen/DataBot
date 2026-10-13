import * as Menu from "@radix-ui/react-dropdown-menu";
import { Braces, ChevronRight, Database, Ellipsis, Eye, KeyRound, Table2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ColumnInfo, ConnectionConfig, FunctionInfo, Relation, SchemaInfo } from "../../ipc/bindings";
import { isViewKind, useCatalog } from "../../state/catalog";
import { connectErrorText } from "../../ipc/errors";
import { useLive } from "../../state/live";
import { connectionStatus } from "../../state/status";
import { useWorkspace } from "../../state/workspace";
import { cx, MenuContent, MenuItem, MenuSeparator, PgBadge, Spinner, StatusDot } from "../../ui/primitives";
import { connect, confirmDelete, disconnect, refreshCatalog } from "../connections/connectionActions";
import { insertAtCursor } from "../editor/editorStates";
import { openSqlTab, openTableTab } from "../editor/runActions";
import { compactCount, shortType } from "../results/format";

const INDENT = 12;

type Expanded = { has(path: string): boolean; toggle(path: string, open?: boolean): void };

function Row({
  path,
  depth,
  expandable,
  open,
  selected,
  onClick,
  onDoubleClick,
  icon,
  label,
  trailing,
  menu,
  quietChevron,
}: {
  quietChevron?: boolean;
  path: string;
  depth: number;
  expandable: boolean;
  open?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div
      data-testid={`tree-node-${path}`}
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      tabIndex={-1}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: 8 + depth * INDENT }}
      className={cx(
        "group mx-2 flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2.5",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className={cx("shrink-0 place-items-center text-muted", expandable ? "grid w-3.5" : "hidden")}>
        {expandable && (
          <ChevronRight
            size={14}
            className={cx("transition-transform duration-100", open && "rotate-90", quietChevron && !open && "invisible group-hover:visible")}
          />
        )}
      </span>
      {icon && <span className="grid w-[18px] shrink-0 place-items-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[14px] text-tree">{label}</span>
      {trailing}
      {menu}
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="shrink-0 pl-2 text-[11.5px] text-muted tabular-nums">{children}</span>;
}

function ColumnRow({ path, depth, column }: { path: string; depth: number; column: ColumnInfo }) {
  return (
    <Row
      path={`${path}/${column.name}`}
      depth={depth}
      expandable={false}
      icon={column.pk ? <KeyRound size={13} className="text-amber" /> : <span className="size-[3px] rounded-full bg-faint" />}
      label={<span className="text-[13px]">{column.name}</span>}
      trailing={<span className="max-w-[55%] min-w-0 truncate pl-2 font-mono text-[10.5px] text-muted">{shortType(column.typeDisplay)}</span>}
    />
  );
}

function RelationRow({
  path,
  depth,
  connectionId,
  schema,
  rel,
  expanded,
}: {
  path: string;
  depth: number;
  connectionId: string;
  schema: string;
  rel: Relation;
  expanded: Expanded;
}) {
  const me = `${path}/${rel.name}`;
  const open = expanded.has(me);
  const selected = useWorkspace(
    (s) => s.selected?.connectionId === connectionId && s.selected.schema === schema && s.selected.relation === rel.name,
  );
  const select = useWorkspace((s) => s.select);
  const view = isViewKind(rel.kind);
  return (
    <>
      <Row
        path={me}
        depth={depth}
        expandable
        quietChevron
        open={open}
        selected={selected}
        onClick={() => {
          select({ connectionId, schema, relation: rel.name });
          expanded.toggle(me);
        }}
        onDoubleClick={() => openTableTab({ connectionId, schema, relation: rel.name })}
        icon={view ? <Eye size={15} className="text-muted" /> : <Table2 size={15} className="text-muted" />}
        label={rel.name}
        trailing={!view && rel.rowEstimate !== null ? <Count>{compactCount(rel.rowEstimate)}</Count> : undefined}
      />
      {open && rel.columns.map((c) => <ColumnRow key={c.attnum} path={me} depth={depth + 1} column={c} />)}
    </>
  );
}

function FunctionRow({ path, depth, fn }: { path: string; depth: number; fn: FunctionInfo }) {
  return (
    <Row
      path={`${path}/${fn.name}`}
      depth={depth}
      expandable={false}
      onDoubleClick={() => {
        const active = useWorkspace.getState().active;
        const tab = active ? useWorkspace.getState().tabs[active] : undefined;
        if (tab?.kind === "sql") insertAtCursor(tab.id, `${fn.name}()`);
      }}
      label={
        <span title={`${fn.name}(${fn.args}) → ${fn.returns}`} className="text-[13.5px]">
          {fn.name}
        </span>
      }
      trailing={<span className="shrink-0 truncate pl-2 font-mono text-[11px] text-muted">{fn.returns}</span>}
    />
  );
}

function Group({
  path,
  depth,
  icon,
  label,
  count,
  expanded,
  children,
}: {
  path: string;
  depth: number;
  icon: ReactNode;
  label: string;
  count: number;
  expanded: Expanded;
  children: ReactNode;
}) {
  const open = expanded.has(path);
  return (
    <>
      <Row path={path} depth={depth} expandable open={open} onClick={() => expanded.toggle(path)} icon={icon} label={label} trailing={<Count>{count}</Count>} />
      {open && children}
    </>
  );
}

function SchemaNode({ path, depth, connectionId, schema, expanded }: { path: string; depth: number; connectionId: string; schema: SchemaInfo; expanded: Expanded }) {
  const me = `${path}/${schema.name}`;
  const open = expanded.has(me);
  const tables = schema.relations.filter((r) => !isViewKind(r.kind));
  const views = schema.relations.filter((r) => isViewKind(r.kind));
  return (
    <>
      <Row
        path={me}
        depth={depth}
        expandable
        open={open}
        onClick={() => expanded.toggle(me)}
        label={schema.name}
        trailing={<Count>{`${tables.length} ${tables.length === 1 ? "table" : "tables"}`}</Count>}
      />
      {open && (
        <>
          {tables.map((rel) => (
            <RelationRow key={rel.oid} path={me} depth={depth + 1} connectionId={connectionId} schema={schema.name} rel={rel} expanded={expanded} />
          ))}
          {views.length > 0 && (
            <Group path={`${me}/views`} depth={depth + 1} icon={<Eye size={15} className="text-muted" />} label="Views" count={views.length} expanded={expanded}>
              {views.map((rel) => (
                <RelationRow key={rel.oid} path={`${me}/views`} depth={depth + 2} connectionId={connectionId} schema={schema.name} rel={rel} expanded={expanded} />
              ))}
            </Group>
          )}
          {schema.functions.length > 0 && (
            <Group
              path={`${me}/functions`}
              depth={depth + 1}
              icon={<Braces size={14} className="text-muted" />}
              label="Functions"
              count={schema.functions.length}
              expanded={expanded}
            >
              {schema.functions.map((fn) => (
                <FunctionRow key={fn.oid} path={`${me}/functions`} depth={depth + 2} fn={fn} />
              ))}
            </Group>
          )}
        </>
      )}
    </>
  );
}

function ConnectionMenu({ config, connected }: { config: ConnectionConfig; connected: boolean }) {
  const open = useWorkspace((s) => s.open);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        data-testid={`conn-menu-${config.name}`}
        onClick={(e) => e.stopPropagation()}
        className="ml-1 hidden size-5 shrink-0 place-items-center rounded text-muted outline-none group-hover:grid hover:bg-control hover:text-fg data-[state=open]:grid"
      >
        <Ellipsis size={14} />
      </Menu.Trigger>
      <MenuContent align="end">
        {connected ? (
          <MenuItem onSelect={() => void disconnect(config.id)}>Disconnect</MenuItem>
        ) : (
          <MenuItem onSelect={() => void connect(config.id)}>Connect</MenuItem>
        )}
        <MenuItem onSelect={() => openSqlTab({ connectionId: config.id })}>New SQL tab</MenuItem>
        {connected && <MenuItem onSelect={() => void refreshCatalog(config.id)}>Refresh catalog</MenuItem>}
        <MenuSeparator />
        <MenuItem testId="conn-edit" onSelect={() => open({ kind: "connection", editing: config.id })}>
          Edit…
        </MenuItem>
        <MenuItem danger onSelect={() => confirmDelete(config.id)}>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu.Root>
  );
}

function ConnectionNode({ config, expanded }: { config: ConnectionConfig; expanded: Expanded }) {
  const state = useLive((s) => s.connections[config.id]);
  const view = useCatalog((s) => s.views[config.id]);
  const status = connectionStatus(state);
  const path = config.name;
  const open = expanded.has(path);
  const connected = state?.status.kind === "Connected";
  const failure =
    state?.status.kind === "Failed"
      ? connectErrorText(state.status.error)
      : state?.status.kind === "Lost"
        ? `Connection lost: ${state.status.reason}`
        : null;

  const revealed = useRef(false);
  const { toggle } = expanded;
  useEffect(() => {
    if (!connected || revealed.current) return;
    revealed.current = true;
    toggle(path, true);
    toggle(`${path}/${config.database}`, true);
    toggle(`${path}/${config.database}/public`, true);
  }, [connected, toggle, path, config.database]);

  const onClick = () => {
    if (connected || state?.status.kind === "Connecting") expanded.toggle(path);
    else void connect(config.id);
  };

  const db = view?.catalog;
  return (
    <>
      <Row
        path={path}
        depth={0}
        expandable
        open={open && connected}
        onClick={onClick}
        icon={<PgBadge />}
        label={<span className="font-medium">{config.name}</span>}
        trailing={
          <span className="flex shrink-0 items-center gap-1.5 pl-2 text-[11.5px] text-muted">
            {status.tone === "pending" ? <Spinner /> : status.tone !== "off" && <StatusDot tone={status.tone} />}
            {connected ? "Live" : status.tone === "error" ? "Failed" : null}
          </span>
        }
        menu={<ConnectionMenu config={config} connected={connected} />}
      />
      {failure && (
        <div data-testid={`conn-error-${config.name}`} className="mx-2 mb-1 pr-2 pl-[38px] text-[11.5px] leading-4 text-danger/90">
          {failure}
        </div>
      )}
      {open && connected && !db && (
        <div className="flex h-7 items-center gap-2 pl-[52px] text-[12px] text-dim">
          <Spinner /> Loading catalog
        </div>
      )}
      {open && connected && db && (
        <>
          <Row
            path={`${path}/${db.database}`}
            depth={1}
            expandable
            open={expanded.has(`${path}/${db.database}`)}
            onClick={() => expanded.toggle(`${path}/${db.database}`)}
            icon={<Database size={15} className="text-muted" />}
            label={db.database}
          />
          {expanded.has(`${path}/${db.database}`) &&
            db.schemas.map((s) => (
              <SchemaNode key={s.name} path={`${path}/${db.database}`} depth={2} connectionId={config.id} schema={s} expanded={expanded} />
            ))}
        </>
      )}
    </>
  );
}

export function ConnectionTree() {
  const configs = useWorkspace((s) => s.configs);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (p: string, force?: boolean) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (force ?? !prev.has(p)) next.add(p);
        else next.delete(p);
        return next;
      }),
    [],
  );
  const expanded: Expanded = { has: (p) => open.has(p), toggle };
  const list = Object.values(configs).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div data-testid="conn-tree" role="tree" className="min-h-0 flex-1 overflow-y-auto pb-3">
      {list.map((c) => (
        <ConnectionNode key={c.id} config={c} expanded={expanded} />
      ))}
      {list.length === 0 && (
        <div className="px-5 py-3 text-[12.5px] leading-5 text-dim">
          No connections yet. Use + to add a PostgreSQL server.
        </div>
      )}
    </div>
  );
}
