# syntax=docker/dockerfile:1
ARG UPSTREAM_IMAGE=decolua/9router:latest
FROM ${UPSTREAM_IMAGE}
ARG UPSTREAM_IMAGE
ARG OVERLAY_REVISION=local
USER root
WORKDIR /app
COPY patches/ /opt/9router-hotfix/
COPY scripts/verify-image.cjs scripts/entrypoint.sh /opt/9router-autopatch/
COPY LICENSE /opt/9router-autopatch/LICENSE
RUN npm ci --prefix /opt/9router-hotfix/runtime --ignore-scripts --omit=dev \
 && chmod 755 /opt/9router-hotfix /opt/9router-hotfix/runtime /opt/9router-hotfix/runtime/node_modules \
 && find /opt/9router-hotfix/runtime/node_modules -type d -exec chmod 755 {} + \
 && find /opt/9router-hotfix/runtime/node_modules -type f -exec chmod 644 {} + \
 && node /opt/9router-hotfix/fix-9router-ds41-low.cjs \
 && node /opt/9router-hotfix/fix-9router-opencode-pool.cjs \
 && node /opt/9router-hotfix/fix-9router-opencode-anonymous.cjs \
 && node /opt/9router-autopatch/verify-image.cjs \
 && su-exec node node /opt/9router-hotfix/check-proxy-runtime.cjs
LABEL org.opencontainers.image.source="https://github.com/AlanBacker/9router-autopatch" \
      org.opencontainers.image.revision="${OVERLAY_REVISION}" \
      org.opencontainers.image.base.name="${UPSTREAM_IMAGE}"
ENTRYPOINT ["/bin/sh", "/opt/9router-autopatch/entrypoint.sh"]
CMD ["node", "custom-server.js"]
