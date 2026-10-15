import { useEffect, useRef, useState } from "react";
import { commands, type HistoryFilter } from "../../ipc/bindings";
import { useLive } from "../../state/live";
import { appendOlder, appendRuns, firstPageQuery, keepSelection, olderPageQuery, type HistoryDetail, type HistoryList } from "./historyList";

export function useHistory(text: string, filter: HistoryFilter) {
  const tail = useLive((s) => s.historyTail);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<HistoryList | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const generation = useRef(0);
  const olderRequest = useRef<HistoryList | null>(null);
  const runRequest = useRef<HistoryDetail | null>(null);
  const reload = () => setRefresh((n) => n + 1);

  useEffect(() => {
    const version = ++generation.current;
    setList(null);
    setDetail(null);
    setError(null);
    setLoadingOlder(false);
    setLoadingRuns(false);
    olderRequest.current = null;
    runRequest.current = null;
    const timer = setTimeout(() => {
      void commands.historyBrowse(firstPageQuery(text, filter)).then((res) => {
        if (generation.current !== version) return;
        if (res.status === "error") { setError(res.error.kind === "Stale" ? "History changed. Try again." : res.error.message); return; }
        setList({ ...res.data, text: text.trim(), filter });
        setSelectedId((id) => keepSelection(res.data.groups, id));
      }).catch((e: unknown) => { if (generation.current === version) setError(String(e)); });
    }, text.trim() ? 150 : 0);
    return () => { ++generation.current; clearTimeout(timer); };
  }, [text, filter, tail, refresh]);

  const selected = list?.groups.find((g) => g.id === selectedId) ?? null;
  const revision = list?.revision;
  useEffect(() => {
    setDetail(null);
    setLoadingRuns(false);
    runRequest.current = null;
    if (selectedId === null || revision === undefined) return;
    let cancelled = false;
    const version = generation.current;
    void commands.historyGroup({ id: selectedId, beforeId: null, limit: 50, revision }).then((res) => {
      if (cancelled || version !== generation.current) return;
      if (res.status === "error") {
        if (res.error.kind === "Stale") reload(); else setError(res.error.message);
        return;
      }
      setDetail({ ...res.data, id: selectedId });
    }).catch((e: unknown) => { if (!cancelled && version === generation.current) setError(String(e)); });
    return () => { cancelled = true; };
  }, [selectedId, revision]);

  function loadOlder() {
    const query = list && olderPageQuery(list);
    if (!query || olderRequest.current === list) return;
    const requested = list;
    const version = generation.current;
    olderRequest.current = requested;
    setLoadingOlder(true);
    void commands.historyBrowse(query).then((res) => {
      if (version !== generation.current) return;
      if (res.status === "error") {
        if (res.error.kind === "Stale") reload(); else setError(res.error.message);
      } else setList((current) => current && requested && appendOlder(current, requested, res.data));
    }).catch((e: unknown) => { if (version === generation.current) setError(String(e)); }).finally(() => {
      if (version === generation.current) { setLoadingOlder(false); olderRequest.current = null; }
    });
  }

  function loadRuns() {
    if (!detail?.hasMore || runRequest.current === detail) return;
    const requested = detail;
    const version = generation.current;
    runRequest.current = detail;
    setLoadingRuns(true);
    void commands.historyGroup({ id: detail.id, beforeId: detail.runs.at(-1)?.id ?? null, limit: 50, revision: detail.revision }).then((res) => {
      if (version !== generation.current) return;
      if (res.status === "error") {
        if (res.error.kind === "Stale") reload(); else setError(res.error.message);
      } else setDetail((current) => current && appendRuns(current, requested, res.data));
    }).catch((e: unknown) => { if (version === generation.current) setError(String(e)); }).finally(() => {
      if (version === generation.current && runRequest.current === requested) { setLoadingRuns(false); runRequest.current = null; }
    });
  }

  const currentDetail = selected && detail?.id === selected.id && detail.revision === revision ? detail : null;
  return { list, selected, detail: currentDetail, error, loadingOlder, loadingRuns, setSelectedId, loadOlder, loadRuns, reload };
}
