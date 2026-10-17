#!/bin/sh
set -eu
node /opt/9router-autopatch/verify-image.cjs
exec /bin/sh /opt/9router-hotfix/start-9router-hotfix.sh "$@"
