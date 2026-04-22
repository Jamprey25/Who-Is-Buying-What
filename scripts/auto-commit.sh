#!/usr/bin/env bash

set -euo pipefail

PID_FILE=".git/auto-commit.pid"
INTERVAL_SECONDS="${AUTO_COMMIT_INTERVAL_SECONDS:-20}"
MIN_CHANGED_FILES="${AUTO_COMMIT_MIN_CHANGED_FILES:-2}"
MIN_CHANGE_SCORE="${AUTO_COMMIT_MIN_CHANGE_SCORE:-40}"

log() {
  printf '[auto-commit] %s\n' "$*"
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(<"$PID_FILE")"
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

changed_file_count() {
  git status --porcelain --untracked-files=all | awk 'NF {count++} END {print count+0}'
}

change_score() {
  local tracked_lines
  local untracked_files

  tracked_lines="$(
    {
      git diff --numstat
      git diff --cached --numstat
    } | awk 'NF >= 2 {add += $1; del += $2} END {print add + del + 0}'
  )"

  untracked_files="$(git ls-files --others --exclude-standard | awk 'NF {count++} END {print count+0}')"

  # Weight each untracked file as 20 "line-change" points.
  echo $((tracked_lines + (untracked_files * 20)))
}

commit_if_needed() {
  local files score shortstat timestamp message

  files="$(changed_file_count)"
  if [[ "$files" -eq 0 ]]; then
    return 0
  fi

  score="$(change_score)"

  if (( files < MIN_CHANGED_FILES && score < MIN_CHANGE_SCORE )); then
    return 0
  fi

  git add -A
  if git diff --cached --quiet; then
    return 0
  fi

  shortstat="$(git diff --cached --shortstat || true)"
  timestamp="$(date '+%Y-%m-%d %H:%M:%S %z')"
  message=$(
    cat <<EOF
chore(auto): checkpoint ${timestamp}

Auto-commit triggered by threshold.
Changed files: ${files}
Change score: ${score}
${shortstat}
EOF
  )

  if git commit -m "$message" >/dev/null 2>&1; then
    log "Committed checkpoint (${files} files, score ${score})."
  else
    log "Commit skipped (hooks failed or nothing committable)."
  fi
}

start_loop() {
  if is_running; then
    log "Already running with PID $(<"$PID_FILE")."
    exit 0
  fi

  echo "$$" > "$PID_FILE"
  trap 'rm -f "$PID_FILE"' EXIT
  log "Started (interval=${INTERVAL_SECONDS}s, min_files=${MIN_CHANGED_FILES}, min_score=${MIN_CHANGE_SCORE})."

  while true; do
    commit_if_needed
    sleep "$INTERVAL_SECONDS"
  done
}

stop_loop() {
  if ! [[ -f "$PID_FILE" ]]; then
    log "Not running."
    exit 0
  fi

  local pid
  pid="$(<"$PID_FILE")"

  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    log "Stopped PID ${pid}."
  else
    log "Stale PID file removed."
  fi

  rm -f "$PID_FILE"
}

status_loop() {
  if is_running; then
    log "Running with PID $(<"$PID_FILE")."
  else
    log "Not running."
  fi
}

main() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "Run this script from inside a git repository."
    exit 1
  fi

  local cmd="${1:-start}"
  case "$cmd" in
    start) start_loop ;;
    stop) stop_loop ;;
    status) status_loop ;;
    *)
      log "Usage: scripts/auto-commit.sh [start|stop|status]"
      exit 1
      ;;
  esac
}

main "$@"
