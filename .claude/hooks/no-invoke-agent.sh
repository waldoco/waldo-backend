#!/bin/bash
# invoke-agent EF must not exist — agent = CF DO only
if grep -rn "invoke-agent\|invokeAgent\|invoke_agent" cloudflare/ supabase/ 2>/dev/null | grep -v "//"; then
  echo "VIOLATION: invoke-agent pattern found. The CF DO is the ONLY agent brain."
  exit 1
fi
exit 0
