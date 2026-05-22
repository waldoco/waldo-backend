#!/bin/bash
# Fail if any TS file exceeds 800 lines
find cloudflare supabase -name "*.ts" 2>/dev/null | while read f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 800 ]; then
    echo "VIOLATION: $f has $lines lines (cap: 800). Split it before committing."
    exit 1
  fi
done
exit 0
