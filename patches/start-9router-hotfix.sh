#!/bin/sh
# Bind-mount this script and fix-9router-ds41-low.cjs read-only into the container.
# Patch the new image's writable layer BEFORE starting the application.
set -u
if ! node /opt/9router-hotfix/fix-9router-ds41-low.cjs; then
  printf '%s\n' '[9router-hotfix] Patch skipped or failed. Starting the upstream application normally; inspect this log before assuming LOW is active.' >&2
fi
if ! node /opt/9router-hotfix/fix-9router-opencode-pool.cjs; then
  printf '%s\n' '[9router-hotfix] OpenCode connection pool patch failed; inspect the log before using managed connections.' >&2
fi
if ! node /opt/9router-hotfix/fix-9router-opencode-anonymous.cjs; then
  printf '%s\n' '[9router-hotfix] Anonymous session isolation patch failed; inspect this log before assuming managed sessions are isolated.' >&2
fi
if [ "$#" -eq 0 ]; then
  set -- node custom-server.js
fi
if [ -f /opt/9router-hotfix/thinking-compat.cjs ]; then
  export NINEROUTER_THINKING_COMPAT=1
  case " ${NODE_OPTIONS:-} " in
    *" --require=/opt/9router-hotfix/thinking-compat.cjs "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/opt/9router-hotfix/thinking-compat.cjs" ;;
  esac
fi
if [ -f /opt/9router-hotfix/opencode-anonymous.cjs ]; then
  export NINEROUTER_OPENCODE_ANONYMOUS=1
  case " ${NODE_OPTIONS:-} " in
    *" --require=/opt/9router-hotfix/opencode-anonymous.cjs "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/opt/9router-hotfix/opencode-anonymous.cjs" ;;
  esac
fi
if [ -f /opt/9router-hotfix/opencode-public-proxy.cjs ]; then
  if [ "$(id -u)" = 0 ] && command -v su-exec >/dev/null 2>&1; then
    if ! env NODE_OPTIONS= NINEROUTER_OPENCODE_PUBLIC_PROXY=0 su-exec node node /opt/9router-hotfix/check-proxy-runtime.cjs; then
      printf '%s\n' '[9router-hotfix] Application-user proxy dependency check failed. Automatic proxy mode will remain unavailable; inspect the runtime directory permissions.' >&2
    fi
  elif [ "$(id -u)" != 0 ]; then
    if ! env NODE_OPTIONS= NINEROUTER_OPENCODE_PUBLIC_PROXY=0 node /opt/9router-hotfix/check-proxy-runtime.cjs; then
      printf '%s\n' '[9router-hotfix] Proxy dependency check failed for the application user.' >&2
    fi
  fi
  export NINEROUTER_OPENCODE_PUBLIC_PROXY=1
  case " ${NODE_OPTIONS:-} " in
    *" --require=/opt/9router-hotfix/opencode-public-proxy.cjs "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/opt/9router-hotfix/opencode-public-proxy.cjs" ;;
  esac
fi
exec /entrypoint.sh "$@"
