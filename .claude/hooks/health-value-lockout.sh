#!/bin/bash
# Raw health values must NEVER enter DO SQLite or agent context
if grep -rn "hrv_overnight_ms\|rhr_bpm\|sleep_duration_min\|hrv_method\|spo2_avg" \
  cloudflare/waldo-agent/src/core/ \
  cloudflare/waldo-agent/src/tools/ \
  cloudflare/waldo-agent/src/adapters/llm/ 2>/dev/null | grep -v "//\|\.ts:.*import"; then
  echo "VIOLATION: Raw health values found in DO code. Only derived values allowed in agent context."
  exit 1
fi
exit 0
