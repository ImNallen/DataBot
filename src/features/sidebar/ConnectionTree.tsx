import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  IconBolt,
  IconBraces,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconDatabase,
  IconDots,
  IconEqual,
  IconEye,
  IconFilter2,
  IconHash,
  IconKey,
  IconLetterT,
  IconLink,
  IconList,
  IconPoint,
  IconStack2,
  IconSum,
  IconTable,
  IconToggleLeft,
  type Icon,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  commands,
  type ColumnInfo,
  type ConnectionConfig,
  type DatabaseRef,
  type DatabaseState,
  type FunctionInfo,
  type InstanceState,
  type KeyKind,
  type Relation,
  type RelationDetail,
  type SchemaInfo,
  type TypeCategory,
} from "../../ipc/bindings";
import { isViewKind, useCatalog, viewFor } from "../../state/catalog";
import { connectErrorText } from "../../ipc/errors";
import { dbKey, sameDb } from "../../state/dbKey";
import { instanceOf, useLive } from "../../state/live";
import { detailKey, useRelationDetail } from "../../state/relationDetail";
import { connectionStatus, type Tone } from "../../state/status";
import { useWorkspace } from "../../state/workspace";
import {
  ContextMenuArea,
  ContextMenuItem,
  ContextSubmenu,
  cx,
  MenuContent,
  MenuItem,
  MenuSeparator,
  PgBadge,
  Spinner,
  StatusDot,
} from "../../ui/primitives";
import { connect, confirmDelete, disconnect, refreshCatalog, refreshConnection } from "../connections/connectionActions";
import { insertAtCursor } from "../editor/editorStates";
import { openSqlTab, openTableTab } from "../editor/runActions";
import { columnType, defaultText, indexText, keyText, triggerText, type RowText } from "./detailText";
import { databaseCount, schemaCount } from "./pickers";
import { PickerHost, PickerPill, useIsPickerOpen, type PickerTarget } from "./VisibilityPopover";

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
  onToggle,
  icon,
  label,
  trailing,
  second,
  menu,
  contextMenu,
  quietChevron,
  active,
}: {
  quietChevron?: boolean;
  /** Its picker is open. */
  active?: boolean;
  path: string;
  depth: number;
  expandable: boolean;
  open?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onToggle?: () => void;
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  /** A muted line under the label, cut with an ellipsis and whole in its title. */
  second?: string;
  menu?: ReactNode;
  contextMenu?: ReactNode;
}) {
  const twoLines = second !== undefined;
  const row = (
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
        "group mx-2 flex cursor-default gap-1.5 rounded-md pr-2.5",
        twoLines ? "items-start py-1" : "h-7 items-center",
        selected || active ? "bg-selected" : "hover:bg-hover data-[state=open]:bg-hover",
      )}
    >
      <span
        onClick={
          onToggle &&
          ((e) => {
            e.stopPropagation();
            onToggle();
          })
        }
        onDoubleClick={onToggle && ((e) => e.stopPropagation())}
        className={cx("shrink-0 place-items-center self-stretch text-muted", expandable ? "grid w-3.5" : "hidden")}
      >
        {expandable && (
          <IconChevronRight
            size={14}
            className={cx("transition-transform duration-100", open && "rotate-90", quietChevron && !open && "invisible group-hover:visible")}
          />
        )}
      </span>
      {icon && <span className={cx("grid w-[18px] shrink-0 place-items-center", twoLines && "h-5")}>{icon}</span>}
      {twoLines ? (
        <span className="min-w-0 flex-1">
          <span className="flex h-5 items-center">
            <span className="min-w-0 flex-1 truncate text-ui-14 text-tree">{label}</span>
            {trailing}
          </span>
          <span title={second} className="block truncate font-mono text-ui-11 leading-4 text-muted">
            {second}
          </span>
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-ui-14 text-tree">{label}</span>
          {trailing}
        </>
      )}
      {menu}
    </div>
  );
  return contextMenu ? <ContextMenuArea menu={contextMenu}>{row}</ContextMenuArea> : row;
}

function NewMenu({ db }: { db: DatabaseRef }) {
  return (
    <ContextSubmenu label="New" testId="tree-menu-new">
      <ContextMenuItem testId="tree-menu-query-console" onSelect={() => openSqlTab({ db })}>
        Query Console
      </ContextMenuItem>
    </ContextSubmenu>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="shrink-0 pl-2 text-ui-11.5 text-muted tabular-nums">{children}</span>;
}

const COLUMN_GLYPHS: Partial<Record<TypeCategory, Icon>> = {
  Integer: IconHash,
  Numeric: IconSum,
  Text: IconLetterT,
  Enum: IconList,
  Bool: IconToggleLeft,
  Json: IconBraces,
  Temporal: IconClock,
};

const glyph = (Glyph: Icon, className = "text-muted") => <Glyph size={14} className={className} />;

/** A detail row's name in mono, with marks after it that stay visible when the name is cut. */
function DetailName({ name, marks }: { name: string; marks?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-ui-12.5">{name}</span>
      {marks}
    </span>
  );
}

function Trailing({ children }: { children: string }) {
  return <span className="max-w-[65%] shrink-0 truncate pl-2 font-mono text-ui-11 text-muted">{children}</span>;
}

function ColumnRow({ path, depth, column }: { path: string; depth: number; column: ColumnInfo }) {
  const marks = (
    <>
      {column.pk && <IconKey size={13} className="shrink-0 text-amber" />}
      {column.fk && <IconLink size={13} className="shrink-0 text-badge" />}
    </>
  );
  return (
    <Row
      path={`${path}/${column.name}`}
      depth={depth}
      expandable={false}
      icon={glyph(COLUMN_GLYPHS[column.category] ?? IconPoint)}
      label={<DetailName name={column.name} marks={marks} />}
      trailing={<Trailing>{columnType(column)}</Trailing>}
    />
  );
}

const KEY_GLYPHS: Record<KeyKind["kind"], ReactNode> = {
  Primary: glyph(IconKey, "text-amber"),
  Foreign: glyph(IconLink, "text-badge"),
  Unique: glyph(IconKey),
  Check: glyph(IconChecks),
};

function TextRow({ path, depth, icon, name, text }: { path: string; depth: number; icon: ReactNode; name: string; text: RowText }) {
  return (
    <Row
      path={path}
      depth={depth}
      expandable={false}
      icon={icon}
      label={<DetailName name={name} />}
      trailing={<Trailing>{text.trailing}</Trailing>}
      second={text.second}
    />
  );
}

type DetailGroup = { id: string; label: string; count: number | null; rows: () => ReactNode };

/** Columns come from the catalog. The other groups wait for `relation_detail` and hide when empty. */
function detailGroups(path: string, depth: number, schema: string, rel: Relation, detail: RelationDetail | null): DetailGroup[] {
  const at = (group: string, name: string) => `${path}/#${group}/${name}`;
  const columns: DetailGroup = {
    id: "columns",
    label: "Columns",
    count: rel.columns.length,
    rows: () => rel.columns.map((c) => <ColumnRow key={c.attnum} path={`${path}/#columns`} depth={depth} column={c} />),
  };
  if (!detail) {
    const pending = (id: string, label: string): DetailGroup => ({ id, label, count: null, rows: () => null });
    return [columns, pending("defaults", "Defaults"), pending("keys", "Keys"), pending("indexes", "Indexes"), pending("triggers", "Triggers")];
  }
  const rest: DetailGroup[] = [
    {
      id: "defaults",
      label: "Defaults",
      count: detail.defaults.length,
      rows: () =>
        detail.defaults.map((d) => (
          <Row
            key={d.column}
            path={at("defaults", d.column)}
            depth={depth}
            expandable={false}
            icon={glyph(IconEqual)}
            label={<DetailName name={d.column} />}
            trailing={<Trailing>{defaultText(d.value)}</Trailing>}
          />
        )),
    },
    {
      id: "keys",
      label: "Keys",
      count: detail.keys.length,
      rows: () =>
        detail.keys.map((k) => (
          <TextRow key={k.name} path={at("keys", k.name)} depth={depth} icon={KEY_GLYPHS[k.kind.kind]} name={k.name} text={keyText(k, schema)} />
        )),
    },
    {
      id: "indexes",
      label: "Indexes",
      count: detail.indexes.length,
      rows: () =>
        detail.indexes.map((i) => <TextRow key={i.name} path={at("indexes", i.name)} depth={depth} icon={glyph(IconFilter2)} name={i.name} text={indexText(i)} />),
    },
    {
      id: "triggers",
      label: "Triggers",
      count: detail.triggers.length,
      rows: () =>
        detail.triggers.map((t) => <TextRow key={t.name} path={at("triggers", t.name)} depth={depth} icon={glyph(IconBolt)} name={t.name} text={triggerText(t)} />),
    },
  ];
  return [columns, ...rest.filter((g) => g.count !== 0)];
}

/** Fetches the relation's detail on first open and again whenever the catalog version moves. */
function RelationGroups({
  path,
  depth,
  db,
  schema,
  rel,
  version,
  expanded,
}: {
  path: string;
  depth: number;
  db: DatabaseRef;
  schema: string;
  rel: Relation;
  version: number;
  expanded: Expanded;
}) {
  const key = detailKey(db, rel.oid);
  const entry = useRelationDetail((s) => s.entries[key]);
  // `key` stands in for `db`, which is a new object on every render.
  useEffect(() => {
    void useRelationDetail.getState().ensure(db, version, rel.oid);
  }, [key, version, rel.oid]);
  return (
    <>
      {detailGroups(path, depth + 1, schema, rel, entry?.detail ?? null).map((g) => (
        <Group key={g.id} path={`${path}/#${g.id}`} depth={depth} label={g.label} count={g.count} expanded={expanded}>
          {g.rows()}
        </Group>
      ))}
      {entry?.error && (
        <div
          data-testid={`detail-error-${path}`}
          style={{ paddingLeft: 30 + depth * INDENT }}
          className="mx-2 mb-1 pr-2 text-ui-11.5 leading-4 text-danger/90"
        >
          {entry.error}
        </div>
      )}
    </>
  );
}

function RelationRow({
  path,
  depth,
  db,
  schema,
  rel,
  version,
  expanded,
}: {
  path: string;
  depth: number;
  db: DatabaseRef;
  schema: string;
  rel: Relation;
  version: number;
  expanded: Expanded;
}) {
  const me = `${path}/${rel.name}`;
  const open = expanded.has(me);
  const selected = useWorkspace((s) => sameDb(s.selected?.db, db) && s.selected?.schema === schema && s.selected.relation === rel.name);
  const select = useWorkspace((s) => s.select);
  const toggle = () => {
    if (!open) expanded.toggle(`${me}/#columns`, true);
    expanded.toggle(me);
  };
  return (
    <>
      <Row
        path={me}
        depth={depth}
        expandable
        quietChevron
        open={open}
        selected={selected}
        onClick={() => select({ db, schema, relation: rel.name })}
        onToggle={toggle}
        onDoubleClick={() => openTableTab({ db, schema, relation: rel.name })}
        contextMenu={<NewMenu db={db} />}
        icon={isViewKind(rel.kind) ? <IconEye size={15} className="text-muted" /> : <IconTable size={15} className="text-muted" />}
        label={rel.name}
      />
      {open && <RelationGroups path={me} depth={depth + 1} db={db} schema={schema} rel={rel} version={version} expanded={expanded} />}
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
        <span title={`${fn.name}(${fn.args}) → ${fn.returns}`} className="text-ui-13.5">
          {fn.name}
        </span>
      }
      trailing={<span className="shrink-0 truncate pl-2 font-mono text-ui-11 text-muted">{fn.returns}</span>}
    />
  );
}

/** `count` is null while it loads. */
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
  icon?: ReactNode;
  label: string;
  count: number | null;
  expanded: Expanded;
  children: ReactNode;
}) {
  const open = expanded.has(path);
  return (
    <>
      <Row
        path={path}
        depth={depth}
        expandable
        open={open}
        onClick={() => expanded.toggle(path)}
        icon={icon}
        label={icon ? label : <span className="text-ui-13 text-muted">{label}</span>}
        trailing={<Count>{count ?? <span className="text-faint">…</span>}</Count>}
      />
      {open && children}
    </>
  );
}

function SchemaNode({
  path,
  depth,
  db,
  schema,
  version,
  expanded,
}: {
  path: string;
  depth: number;
  db: DatabaseRef;
  schema: SchemaInfo;
  version: number;
  expanded: Expanded;
}) {
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
        icon={<IconStack2 size={15} className="text-muted" />}
        label={schema.name}
        contextMenu={<NewMenu db={db} />}
        trailing={<Count>{tables.length}</Count>}
      />
      {open && (
        <>
          {[...tables, ...views].map((rel) => (
            <RelationRow key={rel.oid} path={me} depth={depth + 1} db={db} schema={schema.name} rel={rel} version={version} expanded={expanded} />
          ))}
          {schema.functions.length > 0 && (
            <Group
              path={`${me}/#functions`}
              depth={depth + 1}
              icon={<IconBraces size={14} className="text-muted" />}
              label="Functions"
              count={schema.functions.length}
              expanded={expanded}
            >
              {schema.functions.map((fn) => (
                <FunctionRow key={fn.oid} path={`${me}/#functions`} depth={depth + 2} fn={fn} />
              ))}
            </Group>
          )}
        </>
      )}
    </>
  );
}

function ConnectionMenu({ config, shown }: { config: ConnectionConfig; shown: DatabaseRef[] | null }) {
  const connected = shown !== null;
  const open = useWorkspace((s) => s.open);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        data-testid={`conn-menu-${config.name}`}
        onClick={(e) => e.stopPropagation()}
        className="ml-1 hidden size-5 shrink-0 place-items-center rounded text-muted outline-none group-hover:grid hover:bg-control hover:text-fg data-[state=open]:grid"
      >
        <IconDots size={14} />
      </Menu.Trigger>
      <MenuContent align="end">
        {connected ? (
          <MenuItem onSelect={() => void disconnect(config.id)}>Disconnect</MenuItem>
        ) : (
          <MenuItem onSelect={() => void connect(config.id)}>Connect</MenuItem>
        )}
        <MenuItem onSelect={() => openSqlTab({ db: shown?.[0] ?? { connectionId: config.id, database: config.database } })}>New SQL tab</MenuItem>
        {connected && <MenuItem onSelect={() => void refreshConnection(config.id)}>Refresh catalog</MenuItem>}
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

/** One shown database of a connected instance: its row, then its schemas once the catalog is in. */
function DatabaseNode({ path, db, state, expanded }: { path: string; db: DatabaseRef; state: DatabaseState; expanded: Expanded }) {
  const me = `${path}/${db.database}`;
  const open = expanded.has(me);
  const view = useCatalog((s) => viewFor(s.views, db));
  const target: PickerTarget = { kind: "schemas", db };
  const picking = useIsPickerOpen(target);
  const count = schemaCount(state, view?.catalog);
  const schemas = view ? state.shownSchemas.flatMap((name) => view.catalog.schemas.find((s) => s.name === name) ?? []) : [];

  // Past the engine's cap of auto-opened databases a shown one stays Idle until its row opens. The snapshot then
  // moves it to Loading and Ready, and the catalog sync fetches it; the reply itself carries nothing new.
  const idle = state.catalog.kind === "Idle";
  const key = dbKey(db);
  useEffect(() => {
    if (open && idle) void commands.catalogGet(db);
  }, [open, idle, key]);

  return (
    <>
      <Row
        path={me}
        depth={1}
        expandable
        open={open}
        active={picking}
        onClick={() => expanded.toggle(me)}
        icon={<IconDatabase size={15} className="text-muted" />}
        label={db.database}
        contextMenu={<NewMenu db={db} />}
        trailing={count && <PickerPill target={target} count={count} active={picking} testId={`schema-pill-${me}`} />}
      />
      {open && state.catalog.kind === "Failed" && (
        <div data-testid={`db-error-${path}/${db.database}`} className="mx-2 mb-1 flex items-baseline gap-2 pr-2 pl-[52px] text-ui-11.5 leading-4 text-danger/90">
          <span className="min-w-0 flex-1 truncate" title={state.catalog.message}>
            {view ? "Refresh failed: " : ""}
            {state.catalog.message}
          </span>
          <button
            type="button"
            data-testid={`db-retry-${path}/${db.database}`}
            onClick={() => void refreshCatalog(db)}
            className="shrink-0 rounded px-1 text-fg/80 underline-offset-2 hover:bg-control hover:underline"
          >
            Retry
          </button>
        </div>
      )}
      {open && !view && state.catalog.kind !== "Failed" && (
        <div className="flex h-7 items-center gap-2 pl-[52px] text-ui-12 text-dim">
          <Spinner /> Loading catalog
        </div>
      )}
      {open && view && schemas.length === 0 && (
        <div data-testid={`db-empty-${me}`} className="flex h-7 items-center pl-[52px] text-ui-12 text-muted">
          No schemas shown
        </div>
      )}
      {open &&
        view &&
        schemas.map((s) => <SchemaNode key={s.name} path={me} depth={2} db={db} schema={s} version={view.catalog.version} expanded={expanded} />)}
    </>
  );
}

function ConnectionTrailing({
  config,
  tone,
  instance,
  target,
  active,
}: {
  config: ConnectionConfig;
  tone: Tone;
  instance: InstanceState | null;
  target: PickerTarget;
  active: boolean;
}) {
  if (instance) return <PickerPill target={target} count={databaseCount(instance)} active={active} testId={`db-pill-${config.name}`} />;
  switch (tone) {
    case "pending":
      return (
        <span className="grid shrink-0 place-items-center pl-2">
          <Spinner />
        </span>
      );
    case "error":
      return (
        <span className="flex shrink-0 items-center gap-1.5 pl-2 text-ui-11.5 text-muted">
          <StatusDot tone="error" />
          Failed
        </span>
      );
    case "live":
      return null;
    case "off":
      return (
        <button
          type="button"
          data-testid={`conn-connect-${config.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void connect(config.id);
          }}
          className="ml-1 h-5 shrink-0 rounded-md px-1.5 text-ui-11.5 text-muted hover:bg-control hover:text-fg"
        >
          Connect
        </button>
      );
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

function ConnectionNode({ config, expanded }: { config: ConnectionConfig; expanded: Expanded }) {
  const state = useLive((s) => s.connections[config.id]);
  const instance = instanceOf(state);
  const status = connectionStatus(state);
  const path = config.name;
  const open = expanded.has(path);
  const connected = instance !== null;
  const shown = instance?.databases.filter((d) => d.shown) ?? [];
  const home = instance?.home;
  const homeDefault = useCatalog((s) => (home ? viewFor(s.views, { connectionId: config.id, database: home })?.catalog.defaultSchema : undefined));
  const target: PickerTarget = { kind: "databases", id: config.id };
  const picking = useIsPickerOpen(target);
  const failure =
    state?.status.kind === "Failed"
      ? connectErrorText(state.status.error)
      : state?.status.kind === "Lost"
        ? `Connection lost: ${state.status.reason}`
        : null;

  // The first connect opens the connection and its home database, then that database's default schema once its catalog says which.
  const revealed = useRef<"nothing" | "database" | "schema">("nothing");
  const { toggle } = expanded;
  useEffect(() => {
    if (!home) return;
    if (revealed.current === "nothing") {
      revealed.current = "database";
      toggle(path, true);
      toggle(`${path}/${home}`, true);
    }
    if (revealed.current === "database" && homeDefault !== undefined) {
      revealed.current = "schema";
      if (homeDefault) toggle(`${path}/${home}/${homeDefault}`, true);
    }
  }, [home, homeDefault, toggle, path]);

  const onClick = () => {
    if (connected || state?.status.kind === "Connecting") expanded.toggle(path);
    else void connect(config.id);
  };

  return (
    <>
      <Row
        path={path}
        depth={0}
        expandable
        open={open && connected}
        active={picking}
        onClick={onClick}
        icon={
          <span className={cx(status.tone === "off" && "opacity-50 grayscale")}>
            <PgBadge />
          </span>
        }
        label={<span className={cx("font-medium", status.tone === "off" && "text-muted")}>{config.name}</span>}
        trailing={<ConnectionTrailing config={config} tone={status.tone} instance={instance} target={target} active={picking} />}
        menu={<ConnectionMenu config={config} shown={instance && shown.map((d) => ({ connectionId: config.id, database: d.name }))} />}
      />
      {failure && (
        <div data-testid={`conn-error-${config.name}`} className="mx-2 mb-1 pr-2 pl-[38px] text-ui-11.5 leading-4 text-danger/90">
          {failure}
        </div>
      )}
      {open &&
        connected &&
        shown.map((d) => <DatabaseNode key={d.name} path={path} db={{ connectionId: config.id, database: d.name }} state={d} expanded={expanded} />)}
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
    <div data-testid="conn-tree" role="tree" className="min-h-0 flex-1 overflow-y-auto pt-2 pb-3">
      {list.map((c) => (
        <ConnectionNode key={c.id} config={c} expanded={expanded} />
      ))}
      <PickerHost />
    </div>
  );
}
