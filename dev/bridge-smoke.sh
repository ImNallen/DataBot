#!/usr/bin/env bash
set -euo pipefail

BRIDGE=http://127.0.0.1:7077
DATA_DIR=$(mktemp -d)
SSE_LOG=$(mktemp)
SSE_PID=
L1_DATA_DATA_DIR="$DATA_DIR" ./target/debug/dev-bridge >"$DATA_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID ${SSE_PID:-} 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 50); do
  if curl -s "$BRIDGE/invoke/app_boot" -d '{}' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
test "$ready" = 1

curl -sN "$BRIDGE/events" >"$SSE_LOG" &
SSE_PID=$!
sleep 0.3

invoke() { curl -s "$BRIDGE/invoke/$1" -H 'content-type: application/json' -d "$2"; }
ok() { python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok", r; print(json.dumps(r["data"]))'; }

PG_URL="${L1_DATA_TEST_PG:-postgres://l1data:l1data@localhost:5433/shop}"
export PG_URL
DRAFT=$(python3 - <<'PY'
import json, os, sys
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["PG_URL"])
if u.scheme not in ("postgres", "postgresql"):
    sys.exit("L1_DATA_TEST_PG scheme must be postgres")
if u.query or u.fragment:
    sys.exit("L1_DATA_TEST_PG must not carry a query string")
database = unquote(u.path.lstrip("/"))
if not u.hostname or not u.username or not u.password or not database or "/" in database:
    sys.exit("L1_DATA_TEST_PG must be postgres://user:password@host:port/database")
json.dump({
    "draft": {
        "id": None,
        "name": "smoke",
        "host": u.hostname,
        "port": u.port or 5432,
        "database": database,
        "user": unquote(u.username),
        "sslMode": "Prefer",
        "caCertPath": None,
        "password": {"Set": unquote(u.password)},
        "color": None,
    }
}, sys.stdout, separators=(",", ":"))
PY
)
CONN=$(invoke connection_save "$DRAFT" | ok)
CONN_ID=$(echo "$CONN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
DB=$(echo "$CONN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["database"])')
echo "saved connection $CONN_ID"
invoke connection_connect "{\"id\":\"$CONN_ID\"}" | ok
invoke catalog_get "{\"db\":{\"connectionId\":\"$CONN_ID\",\"database\":\"$DB\"}}" | ok | python3 -c 'import json,sys; c=json.load(sys.stdin); print("catalog %s v%d: %s" % (c["db"]["database"], c["version"], ", ".join("%s(%d)" % (s["name"], len(s["relations"])) for s in c["schemas"])))'
TAB=$(python3 -c 'import uuid; print(uuid.uuid4())')
invoke console_configure "{\"tabId\":\"$TAB\",\"config\":{\"connectionId\":\"$CONN_ID\",\"database\":\"$DB\",\"schema\":null,\"mode\":\"AutoCommit\"}}" | ok >/dev/null
NOTICE=$(cat <<'SQL'
do $$ begin raise notice 'smoke notice'; end $$;
SQL
)
QUERY="select c.region, count(*) as orders, sum(o.total) as revenue from orders o join customers c on c.id = o.customer_id where o.status = 'paid' and o.created_at > now() - interval '90 days' group by c.region order by revenue desc"
RUN=$(invoke console_run "{\"tabId\":\"$TAB\",\"request\":{\"kind\":\"script\",\"text\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$NOTICE
$QUERY"),\"target\":{\"kind\":\"all\"}}}" | ok)
RUN_ID=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
echo "run $RUN_ID accepted: $RUN"
for _ in $(seq 1 30); do
  if python3 - "$SSE_LOG" "$TAB" "$RUN_ID" <<'PY'
import json, sys
frames = [json.loads(l[5:]) for l in open(sys.argv[1]) if l.startswith("data:")]
tab, run_id = sys.argv[2], int(sys.argv[3])
sys.exit(0 if any(
    f.get("kind") == "ConsoleChanged" and f.get("tabId") == tab
    and f.get("run", {}).get("kind") == "Finished"
    and f.get("run", {}).get("runId") == run_id
    for f in frames
) else 1)
PY
  then
    break
  fi
  sleep 1
done
invoke result_page "{\"resultRef\":{\"tabId\":\"$TAB\",\"runId\":$RUN_ID,\"index\":1},\"start\":0,\"len\":10}" | ok
kill $SSE_PID; wait $SSE_PID 2>/dev/null || true

python3 - "$SSE_LOG" "$TAB" "$RUN_ID" "$QUERY" "$DB" <<'EOF'
import json, sys
frames = [json.loads(l[5:]) for l in open(sys.argv[1]) if l.startswith("data:")]
kinds = [f["kind"] for f in frames]
print("SSE kinds:", kinds)
finished = [f for f in frames if f["kind"] == "ConsoleChanged" and f["tabId"] == sys.argv[2]
            and f["run"]["kind"] == "Finished" and f["run"]["runId"] == int(sys.argv[3])]
assert finished, "no Finished ConsoleChanged on SSE"
st = finished[-1]["run"]["statements"][1]["status"]
assert st["kind"] == "Rows" and st["result"]["rowCount"] == 6, st
print("SSE ConsoleChanged Finished: rows=%d outcome=%s" % (st["result"]["rowCount"], finished[-1]["run"]["outcome"]))
def line(b):
    fields = {"Statement": ("statement", "text"), "Notice": ("severity", "message"), "Command": ("statement", "tag"), "Rows": ("statement", "rows")}
    return (b["kind"],) + tuple(b[k] for k in fields.get(b["kind"], ()))
log = [line(e["body"]) for f in frames if f["kind"] == "ConsoleOutput" and f["tabId"] == sys.argv[2]
       for e in f["entries"] if e["runId"] == int(sys.argv[3])]
expected = [
    ("Statement", 0, "do $$ begin raise notice 'smoke notice'; end $$"),
    ("Notice", "NOTICE", "smoke notice"),
    ("Command", 0, "DO"),
    ("Statement", 1, sys.argv[4]),
    ("Rows", 1, 6),
]
assert log == expected, log
print("SSE ConsoleOutput: %d lines, notice %r" % (len(log), log[1][2]))
assert "ConnectionChanged" in kinds and "ConsoleOutput" in kinds and "HistoryAppended" in kinds
ready = [d["catalog"]["version"] for f in frames if f["kind"] == "ConnectionChanged" and f["status"]["kind"] == "Connected"
         for d in f["status"]["instance"]["databases"] if d["name"] == sys.argv[5] and d["catalog"]["kind"] == "Ready"]
assert ready, "no ConnectionChanged carried a Ready catalog for %s" % sys.argv[5]
print("SSE ConnectionChanged: %s catalog Ready at v%d" % (sys.argv[5], ready[-1]))
print("bridge smoke ok")
EOF
