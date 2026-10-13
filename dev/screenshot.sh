#!/usr/bin/env bash
# Rewrites docs/images/l1-data.png from the real desktop app: it runs the revenue-by-region query against the seeded
# shop database and captures the window. macOS only. The terminal needs Accessibility and Screen Recording access.
# Usage: pnpm screenshot
set -euo pipefail

PG_PORT=5434
BRIDGE=http://127.0.0.1:7077
OUT=docs/images/l1-data.png
DATA_DIR=$(mktemp -d)
PIDS=()
cleanup() {
	kill "${PIDS[@]}" 2>/dev/null || true
	wait 2>/dev/null || true
	docker rm -f l1-data-screenshot >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Trust auth lets the app connect without a saved password, which a memory key store can't carry across processes.
docker run -d --rm --name l1-data-screenshot -p "$PG_PORT:5432" \
	-e POSTGRES_USER=l1data -e POSTGRES_DB=shop -e POSTGRES_HOST_AUTH_METHOD=trust \
	-v "$PWD/dev/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro" postgres:16 >/dev/null
until docker exec l1-data-screenshot pg_isready -q -h 127.0.0.1 -U l1data -d shop; do sleep 0.5; done

L1_DATA_DATA_DIR="$DATA_DIR" ./target/debug/dev-bridge >"$DATA_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")
until curl -s "$BRIDGE/invoke/app_boot" -d '{}' >/dev/null 2>&1; do sleep 0.1; done

invoke() { curl -s "$BRIDGE/invoke/$1" -H 'content-type: application/json' -d "$2"; }
CONN_ID=$(invoke connection_save "{\"draft\":{\"id\":null,\"name\":\"prod-postgres\",\"host\":\"localhost\",\"port\":$PG_PORT,\"database\":\"shop\",\"user\":\"l1data\",\"sslMode\":\"Prefer\",\"caCertPath\":null,\"password\":\"Clear\",\"color\":null}}" |
	python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok", r; print(r["data"]["id"])')
python3 - "$CONN_ID" >"$DATA_DIR/workspace.json" <<'EOF'
import json, sys, uuid
tab = str(uuid.uuid4())
text = """-- Revenue by region, last 90 days
SELECT
  c.region,
  count(o.id)              AS orders,
  sum(o.total)             AS revenue,
  round(avg(o.total), 2)   AS avg_order,
  max(o.created_at)        AS last_order
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= now() - interval '90 days'
  AND o.status = 'paid'
GROUP BY c.region
ORDER BY revenue DESC;
"""
console = {"connectionId": sys.argv[1], "schema": "public", "mode": "AutoCommit"}
layout = {"sidebar": True, "results": True, "rightPanel": None, "resultsHeight": 420, "sidebarWidth": 256, "rightPanelWidth": 340}
tabs = [{"kind": "Sql", "id": tab, "title": "orders_by_region.sql", "text": text, "console": console}]
print(json.dumps({"workspace": {"tabs": tabs, "active": tab, "layout": layout}}))
EOF
invoke workspace_save "@$DATA_DIR/workspace.json" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok", r'
kill "$BRIDGE_PID"
wait "$BRIDGE_PID" 2>/dev/null || true

pnpm -s dev >"$DATA_DIR/vite.log" 2>&1 &
PIDS+=($!)
until curl -s http://localhost:5173 >/dev/null; do sleep 0.2; done

L1_DATA_DATA_DIR="$DATA_DIR" L1_DATA_SECRET_STORE=memory ./target/debug/l1-data >"$DATA_DIR/app.log" 2>&1 &
PIDS+=($!)

window() {
	swift - <<'EOF'
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in windows where w[kCGWindowOwnerName as String] as? String == "l1-data" && w[kCGWindowLayer as String] as? Int == 0 {
	let b = w[kCGWindowBounds as String] as! [String: Double]
	print(w[kCGWindowNumber as String] as! Int, Int(b["X"]!), Int(b["Y"]!))
	break
}
EOF
}
until [ -n "$(window)" ]; do sleep 0.5; done
sleep 3
read -r WINDOW_ID WIN_X WIN_Y <<<"$(window)"

osascript -e 'tell application "System Events" to set frontmost of process "l1-data" to true'
cliclick "c:$((WIN_X + 640)),$((WIN_Y + 300))"
osascript -e 'tell application "System Events" to keystroke return using command down'
sleep 3

screencapture -o -x -l "$WINDOW_ID" "$OUT"
echo "wrote $OUT ($(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixel/ {printf "%s ", $2}'))"
