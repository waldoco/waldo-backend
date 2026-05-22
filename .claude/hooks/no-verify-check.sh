#!/bin/bash
# Block --no-verify and force-push attempts
if echo "${TOOL_INPUT:-}" | grep -qE "\-\-no\-verify|push\s+\-\-force|push\s+-f\b"; then
  echo "BLOCKED: --no-verify / force push is not allowed. Fix the underlying issue."
  exit 1
fi
exit 0
