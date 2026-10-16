#!/usr/bin/env bash
# Rewrites docs/images/l1-data.png from the real desktop app: it runs the revenue-by-region query against the seeded
# shop database, opens the assistant on a chat that fake-claude answered, and captures the window. macOS only. The
# terminal needs Accessibility and Screen Recording access.
# Usage: pnpm screenshot
set -euo pipefail

PG_PORT=5434
BRIDGE=http://127.0.0.1:7077
OUT=docs/images/l1-data.png
DATA_DIR=$(mktemp -d)
PIDS=()
cleanup() {
	kill ${PIDS[@]+"${PIDS[@]}"} 2>/dev/null || true
	wait 2>/dev/null || true
	docker rm -f l1-data-screenshot >/dev/null 2>&1 || true
}
trap cleanup EXIT

for port in 7077 5173 "$PG_PORT"; do
	if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
		echo "port $port is in use; stop pnpm bridge, vite, or the other process first" >&2
		exit 1
	fi
done

# Trust auth lets the app connect without a saved password, which a memory key store can't carry across processes.
docker run -d --rm --name l1-data-screenshot -p "$PG_PORT:5432" \
	-e POSTGRES_USER=l1data -e POSTGRES_DB=shop -e POSTGRES_HOST_AUTH_METHOD=trust \
	-v "$PWD/dev/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro" postgres:16 >/dev/null
until docker exec l1-data-screenshot pg_isready -q -h 127.0.0.1 -U l1data -d shop; do sleep 0.5; done

L1_DATA_DATA_DIR="$DATA_DIR" ./target/debug/dev-bridge >"$DATA_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")
until curl -s "$BRIDGE/invoke/app_boot" -d '{}' >/dev/null 2>&1; do sleep 0.1; done

# Settings stay on fake-claude, so the app draws the stored chat and the model picker without the real CLI.
python3 - "$BRIDGE" "$PG_PORT" "$PWD/target/debug/fake-claude" <<'EOF'
import json, sys, time, urllib.request, uuid
bridge, pg_port, fake = sys.argv[1], int(sys.argv[2]), sys.argv[3]

def invoke(cmd, **args):
	req = urllib.request.Request(f"{bridge}/invoke/{cmd}", json.dumps(args).encode(), {"content-type": "application/json"})
	r = json.load(urllib.request.urlopen(req))
	assert r["status"] == "ok", (cmd, r)
	return r["data"]

def wait_for(what, check):
	deadline = time.monotonic() + 30
	while not check():
		assert time.monotonic() < deadline, f"timed out waiting for {what}"
		time.sleep(0.2)

draft = {"id": None, "name": "prod-postgres", "host": "localhost", "port": pg_port, "database": "shop", "user": "l1data", "sslMode": "Prefer", "caCertPath": None, "password": "Clear", "color": None}
conn = invoke("connection_save", draft=draft)["id"]

settings = invoke("app_boot")["settings"]
claude = next(p for p in settings["providers"] if p["provider"] == "Claude")
claude.update(binaryPath=fake, launchArgs="--fake-scenario card")
invoke("settings_set", settings=settings)
# Only the stand-in lists a model named "fake", so this waits for its probe and not an earlier one.
probed = lambda: any(m["id"] == "fake" for p in invoke("app_boot")["providers"] for m in (p["outcome"] or {}).get("models", []))
wait_for("the fake-claude probe", probed)

tab, chat = str(uuid.uuid4()), str(uuid.uuid4())
title = "orders_by_region.sql"
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
context = {"tabId": tab, "title": title, "db": {"connectionId": conn, "database": "shop"}, "text": text, "target": {"kind": "cursor", "offset": text.index("WHERE")}, "attach": None}
invoke("assistant_open", chatId=chat)
invoke("assistant_send", chatId=chat, request={"text": "Which regions grew the most compared with the 90 days before?", "tab": context})
def answered():
	view = invoke("assistant_open", chatId=chat)
	return view["state"]["status"]["kind"] == "Idle" and any(e["entry"]["kind"] == "End" for e in view["entries"])
wait_for("the reply", answered)

console = {"connectionId": conn, "schema": "public", "mode": "AutoCommit"}
layout = {"sidebar": True, "results": True, "rightPanel": "Assistant", "resultsHeight": 420, "sidebarWidth": 256, "rightPanelWidth": 520, "assistantChat": chat}
tabs = [{"kind": "Sql", "id": tab, "title": title, "text": text, "console": console}]
invoke("workspace_save", workspace={"tabs": tabs, "active": tab, "layout": layout})
EOF
kill "$BRIDGE_PID"
wait "$BRIDGE_PID" 2>/dev/null || true

pnpm -s dev >"$DATA_DIR/vite.log" 2>&1 &
PIDS+=($!)
until curl -s http://localhost:5173 >/dev/null; do sleep 0.2; done

L1_DATA_DATA_DIR="$DATA_DIR" L1_DATA_SECRET_STORE=memory ./target/debug/l1-data >"$DATA_DIR/app.log" 2>&1 &
APP_PID=$!
PIDS+=("$APP_PID")

window() {
	swift - "$APP_PID" <<'EOF'
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in windows where w[kCGWindowOwnerPID as String] as? Int == pid && w[kCGWindowLayer as String] as? Int == 0 {
	let b = w[kCGWindowBounds as String] as! [String: Double]
	print(w[kCGWindowNumber as String] as! Int, Int(b["X"]!), Int(b["Y"]!))
	break
}
EOF
}
until [ -n "$(window)" ]; do sleep 0.5; done
sleep 3
read -r WINDOW_ID WIN_X WIN_Y <<<"$(window)"

osascript -e 'tell application "System Events" to set frontmost of first process whose unix id is '"$APP_PID"' to true'
cliclick "c:$((WIN_X + 640)),$((WIN_Y + 300))"
osascript -e 'tell application "System Events" to keystroke return using command down'
# A click on the transcript's empty space blurs the editor, which hides the input-source bubble macOS draws by its caret.
cliclick "c:$((WIN_X + 1180)),$((WIN_Y + 720))"
sleep 3

screencapture -o -x -l "$WINDOW_ID" "$OUT"
echo "wrote $OUT ($(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixel/ {printf "%s ", $2}'))"
