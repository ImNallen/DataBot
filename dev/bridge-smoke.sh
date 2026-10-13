#!/usr/bin/env bash
# Drives the dev-bridge through a full flow with curl and checks the SSE stream carried rows.
# Usage: cargo build -p dev-bridge && dev/bridge-smoke.sh   (expects Docker PG on :5433)
set -euo pipefail

BRIDGE=http://127.0.0.1:7077
DATA_DIR=$(mktemp -d)
SSE_LOG=$(mktemp)
DATABOT_DATA_DIR="$DATA_DIR" ./target/debug/dev-bridge >"$DATA_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID $SSE_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -s "$BRIDGE/invoke/app_boot" -d '{}' >/dev/null 2>&1 && break; sleep 0.1; done

curl -sN "$BRIDGE/events" >"$SSE_LOG" &
SSE_PID=$!
sleep 0.3

invoke() { curl -s "$BRIDGE/invoke/$1" -H 'content-type: application/json' -d "$2"; }
ok() { python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok", r; print(json.dumps(r["data"]))'; }

CONN=$(invoke connection_save '{"draft":{"id":null,"name":"smoke","host":"localhost","port":5433,"database":"shop","user":"databot","sslMode":"Prefer","caCertPath":null,"password":{"Set":"databot"},"color":null}}' | ok)
CONN_ID=$(echo "$CONN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "saved connection $CONN_ID"
invoke connection_connect "{\"id\":\"$CONN_ID\"}" | ok
invoke catalog_get "{\"id\":\"$CONN_ID\"}" | ok | python3 -c 'import json,sys; c=json.load(sys.stdin); print("catalog v%d: %s" % (c["version"], ", ".join("%s(%d)" % (s["name"], len(s["relations"])) for s in c["schemas"])))'
TAB=$(python3 -c 'import uuid; print(uuid.uuid4())')
invoke console_configure "{\"tabId\":\"$TAB\",\"config\":{\"connectionId\":\"$CONN_ID\",\"schema\":null,\"mode\":\"AutoCommit\"}}" | ok >/dev/null
QUERY="select c.region, count(*) as orders, sum(o.total) as revenue from orders o join customers c on c.id = o.customer_id where o.status = 'paid' and o.created_at > now() - interval '90 days' group by c.region order by revenue desc"
RUN=$(invoke console_run "{\"tabId\":\"$TAB\",\"request\":{\"kind\":\"script\",\"text\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$QUERY"),\"target\":{\"kind\":\"all\"}}}" | ok)
RUN_ID=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
echo "run $RUN_ID accepted: $RUN"
sleep 1
invoke result_page "{\"resultRef\":{\"tabId\":\"$TAB\",\"runId\":$RUN_ID,\"index\":0},\"start\":0,\"len\":10}" | ok
kill $SSE_PID; wait $SSE_PID 2>/dev/null || true

python3 - "$SSE_LOG" "$TAB" "$RUN_ID" <<'EOF'
import json, sys
frames = [json.loads(l[5:]) for l in open(sys.argv[1]) if l.startswith("data:")]
kinds = [f["kind"] for f in frames]
print("SSE kinds:", kinds)
finished = [f for f in frames if f["kind"] == "ConsoleChanged" and f["tabId"] == sys.argv[2]
            and f["run"]["kind"] == "Finished" and f["run"]["runId"] == int(sys.argv[3])]
assert finished, "no Finished ConsoleChanged on SSE"
st = finished[-1]["run"]["statements"][0]["status"]
assert st["kind"] == "Rows" and st["result"]["rowCount"] == 6, st
print("SSE ConsoleChanged Finished: rows=%d outcome=%s" % (st["result"]["rowCount"], finished[-1]["run"]["outcome"]))
assert "ConnectionChanged" in kinds and "CatalogChanged" in kinds and "ConsoleOutput" in kinds and "HistoryAppended" in kinds
print("bridge smoke ok")
EOF
