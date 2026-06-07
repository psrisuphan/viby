#!/usr/bin/env bash
set -u

timestamp="$(date +%Y%m%d-%H%M%S)"
out_dir="/tmp/viby-hang-debug-${timestamp}"
mkdir -p "$out_dir"

pid="${1:-}"
if [[ -z "$pid" ]]; then
  pid="$(
    pgrep -n -u "$USER" -f '(^|/)(viby|Viby)( |$)|target/debug/viby|src-tauri/target/debug/viby' \
      || true
  )"
fi

{
  echo "timestamp=$timestamp"
  echo "user=$USER"
  echo "pid=${pid:-not-found}"
  echo "kernel=$(uname -a)"
  echo
  echo "matching processes:"
  ps -eo pid,ppid,stat,wchan:32,comm,args | rg -i 'viby|webkit|tauri' || true
} > "$out_dir/summary.txt" 2>&1

journalctl --user --since "30 minutes ago" --no-pager \
  | rg -i 'viby|webkit|crash|segv|abort|panic|egl|gbm|mesa|at-spi|unresponsive' \
  > "$out_dir/journal-user.txt" 2>&1 || true

coredumpctl list --no-pager > "$out_dir/coredumps.txt" 2>&1 || true

if [[ -n "$pid" && -d "/proc/$pid" ]]; then
  ps -T -p "$pid" -o pid,tid,stat,psr,wchan:32,comm \
    > "$out_dir/threads.txt" 2>&1 || true
  cp "/proc/$pid/status" "$out_dir/proc-status.txt" 2>&1 || true
  cat "/proc/$pid/wchan" > "$out_dir/proc-wchan.txt" 2>&1 || true
  ls -l "/proc/$pid/fd" > "$out_dir/fds.txt" 2>&1 || true

  stacks_dir="$out_dir/thread-stacks"
  mkdir -p "$stacks_dir"
  for task in "/proc/$pid/task/"*; do
    tid="$(basename "$task")"
    {
      echo "tid=$tid"
      cat "$task/comm" 2>/dev/null || true
      cat "$task/wchan" 2>/dev/null || true
      echo
      cat "$task/stack" 2>/dev/null || true
    } > "$stacks_dir/$tid.txt" 2>&1
  done

  if command -v gdb >/dev/null 2>&1; then
    timeout 12s gdb -batch \
      -ex "set pagination off" \
      -ex "thread apply all bt" \
      -ex "detach" \
      -ex "quit" \
      -p "$pid" > "$out_dir/gdb-backtrace.txt" 2>&1 || true
  else
    echo "gdb not found" > "$out_dir/gdb-backtrace.txt"
  fi

  if command -v strace >/dev/null 2>&1; then
    timeout 8s strace -f -tt -T -p "$pid" \
      -o "$out_dir/strace.txt" > "$out_dir/strace-attach.txt" 2>&1 || true
  else
    echo "strace not found" > "$out_dir/strace-attach.txt"
  fi
else
  echo "No live Viby process found. Pass the PID explicitly: scripts/collect-hang-debug.sh <PID>" \
    > "$out_dir/no-process.txt"
fi

tarball="${out_dir}.tar.gz"
tar -C /tmp -czf "$tarball" "$(basename "$out_dir")"

echo "$out_dir"
echo "$tarball"
