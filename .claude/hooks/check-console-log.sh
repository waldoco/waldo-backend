#!/bin/bash
# Warn (not fail) if console.log left in modified files
if grep -rn "console\.log" cloudflare/waldo-agent/src/ 2>/dev/null | grep -v "//\|console\.log.*trace\|console\.log.*error"; then
  echo "WARNING: console.log found in DO code. Use structured logging (agent_logs) instead."
fi
exit 0
