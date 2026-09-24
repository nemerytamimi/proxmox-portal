#!/bin/sh
#
# Docker HEALTHCHECK. The web role must answer HTTP; the worker has no port, so
# it is healthy for as long as its process is up (Docker restarts it if not).
set -eu

role="$(cat /tmp/portal-role 2>/dev/null || echo web)"

case "$role" in
  web)
    # shellcheck disable=SC2016 # the backticks are JavaScript, not shell
    exec node -e '
      fetch(`http://127.0.0.1:${process.env.PORT || 3000}/login`, { redirect: "manual" })
        .then((r) => process.exit(r.status < 500 ? 0 : 1))
        .catch(() => process.exit(1));
    '
    ;;
  *)
    exit 0
    ;;
esac
