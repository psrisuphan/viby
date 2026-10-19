#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_file="$repo_root/scripts/rustfmt-baseline.txt"
checked=0
skipped=0
failed=0

check_file() {
  local file="$1"
  local relative="${file#"$repo_root/"}"

  if grep -Fxq "$relative" "$baseline_file"; then
    skipped=$((skipped + 1))
    return
  fi

  checked=$((checked + 1))
  if ! rustfmt --edition 2024 --check --config skip_children=true "$file"; then
    failed=1
  fi
}

check_tree() {
  local source_root="$1"
  [[ -d "$source_root" ]] || return 0

  while IFS= read -r -d '' file; do
    check_file "$file"
  done < <(find "$source_root" -type f -name '*.rs' -print0)
}

check_tree "$repo_root/src-tauri/src"
check_tree "$repo_root/src-tauri/examples"
check_tree "$repo_root/src-tauri/tests"

if [[ -f "$repo_root/src-tauri/build.rs" ]]; then
  check_file "$repo_root/src-tauri/build.rs"
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

printf 'Rust format checked %d files; skipped %d recorded baseline files.\n' "$checked" "$skipped"
