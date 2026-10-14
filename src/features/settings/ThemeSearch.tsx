import { IconDownload, IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchExtensionThemes, searchThemes, type VsxExtension } from "../../themes/openVsx";
import { cx, inputClass, Spinner } from "../../ui/primitives";
import { addThemes } from "./themeActions";

const POPULAR = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const DEBOUNCE_MS = 250;

type Search =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; query: string; results: VsxExtension[] }
  | { kind: "error"; message: string };

function useThemeSearch(query: string): Search {
  const [search, setSearch] = useState<Search>({ kind: "idle" });
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return setSearch({ kind: "idle" });
    setSearch({ kind: "loading" });
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchThemes(trimmed, abort.signal).then(
        (results) => setSearch({ kind: "done", query: trimmed, results }),
        (e: unknown) => {
          if (!abort.signal.aborted) setSearch({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [trimmed]);
  return search;
}

const downloads = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function Status({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "danger" }) {
  return <div className={cx("flex h-16 items-center justify-center gap-2 text-[12.5px]", tone === "danger" ? "text-danger" : "text-dim")}>{children}</div>;
}

export function ThemeSearch({ onImported }: { onImported: () => void }) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useThemeSearch(query);
  const download = useRef<AbortController | null>(null);
  useEffect(() => () => download.current?.abort(), []);

  const pick = async (ext: VsxExtension) => {
    const abort = new AbortController();
    download.current = abort;
    setImporting(ext.id);
    setError(null);
    try {
      const result = await fetchExtensionThemes(ext, abort.signal);
      if (!result.ok) return setError(result.error);
      await addThemes([result.family]);
      onImported();
    } catch (e) {
      if (!abort.signal.aborted) setError(`Couldn't import ${ext.displayName}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label htmlFor="theme-search" className="block text-[13px] text-fg">
          Search community themes
        </label>
        <span className="block text-[12px] text-dim">Find open-source themes from Open VSX.</span>
      </div>
      <div className="relative">
        <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim" />
        <input
          id="theme-search"
          data-testid="theme-search"
          autoFocus
          placeholder="Search themes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={cx(inputClass, "pl-8")}
        />
      </div>
      <div className="flex items-center gap-1 text-[12px]">
        <span className="mr-1 text-dim">Popular</span>
        {POPULAR.map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`theme-popular-${name}`}
            onClick={() => setQuery(name)}
            className="rounded-md px-2 py-0.5 text-muted hover:bg-hover hover:text-fg"
          >
            {name}
          </button>
        ))}
      </div>
      {search.kind === "loading" && (
        <Status>
          <Spinner />
          Searching Open VSX…
        </Status>
      )}
      {search.kind === "error" && <Status tone="danger">Couldn't reach Open VSX: {search.message}</Status>}
      {search.kind === "done" && search.results.length === 0 && <Status>No themes match “{search.query}”.</Status>}
      {search.kind === "done" && search.results.length > 0 && (
        <ul data-testid="theme-search-results" className="flex max-h-[176px] flex-col overflow-auto rounded-lg border border-control p-1">
          {search.results.map((ext) => (
            <li key={ext.id}>
              <button
                type="button"
                disabled={importing !== null}
                onClick={() => void pick(ext)}
                title={ext.description}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-hover disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{ext.displayName}</span>
                  <span className="block truncate text-[12px] text-dim">{ext.publisher}</span>
                </span>
                {importing === ext.id ? (
                  <Spinner />
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-dim tabular-nums">
                    <IconDownload size={12} />
                    {downloads.format(ext.downloadCount)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
