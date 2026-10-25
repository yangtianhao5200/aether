#!/usr/bin/env bash
# Restart the DeepSeek Harness web profile so the Aether remote-agent plugin
# mounts its HTTP/WebSocket routes on the harness webserver.
#
# Why this is needed: the plugin registers `/aether` routes at boot. A running
# process cannot gain new routes, so one restart is required. Everything else
# (plugin install, cordis.patch.yml entry, model provider patch) is already in
# place, so after the restart the phone can connect without any further setup.
#
# Safe to re-run: it is idempotent.
set -u

WEB_LOG=/tmp/dsh-web-restart.log
DSH_BIN=/usr/local/bin/dsh

echo "==> stopping the running dsh web (PID 1 of this container)"

# No pkill in this image: find the processes by their command line in /proc.
kill_dsh_web() {
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ -r "$entry/cmdline" ] || continue
    if tr '\0' ' ' < "$entry/cmdline" 2>/dev/null | grep -q 'dsh web'; then
      echo "   killing pid $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
}
kill_dsh_web

# Give the container a moment. If Docker restarts it (restart policy), the
# original entrypoint boots the patched profile and the mount appears by itself.
for attempt in $(seq 1 20); do
  sleep 3
  if curl -fs -m 3 http://127.0.0.1:3081/aether/healthz >/dev/null 2>&1; then
    echo "==> mount is live (brought up by the container entrypoint):"
    curl -fs -m 3 http://127.0.0.1:3081/aether/healthz
    echo
    exit 0
  fi
done

echo "==> starting dsh web again"
cd /workspace
export DSH_HOME=/home/dsh/.dsh
setsid nohup node "$DSH_BIN" web --no-open --port 3081 \
  --trusted-host 186.241.74.39 >>"$WEB_LOG" 2>&1 </dev/null &

for attempt in $(seq 1 40); do
  sleep 3
  if curl -fs -m 3 http://127.0.0.1:3081/aether/healthz >/dev/null 2>&1; then
    echo "==> mount is live:"
    curl -fs -m 3 http://127.0.0.1:3081/aether/healthz
    echo
    echo "==> agent pairing:"
    curl -fs -m 5 -H "Authorization: Bearer aether-811f08ec6a3c059c" \
      "http://127.0.0.1:3081/aether/v1/pair" | head -c 300
    echo
    exit 0
  fi
done

echo "==> the mount is not responding. Check $WEB_LOG"
exit 1
