# syntax=docker/dockerfile:1.7
ARG NODE_BUILD_IMAGE=docker.io/library/node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
# Official multi-architecture image, resolved from the publisher's registry on
# 2026-10-16. Updating this digest is an explicit, tested runtime upgrade.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919

FROM ${NODE_BUILD_IMAGE} AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=hob-npm,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM ${HERMES_IMAGE} AS runtime
# Preserve the upstream entrypoint, sealed runtime, PM tools, migrations and
# privilege drop. Only the application CMD and its files are added.
USER root
WORKDIR /app
COPY --from=web-build /app/web/dist/ ./web/dist/
COPY server/ ./server/
COPY deploy/ ./deploy/
COPY LICENSE ./LICENSE
RUN chmod -R a+rX /app && /usr/local/bin/node --version && test -x /opt/hermes/bin/hermes
# hob owns the foreground Gateway lifetime. Preserve the stock reconciliation
# hook for diagnostics but take it out of automatic boot: its persisted s6
# autostart would otherwise compete with our supervised foreground process on
# restart. Retain s6 init, volume setup, UID remapping and privilege drop.
RUN test -f /etc/cont-init.d/02-reconcile-profiles && \
    mv /etc/cont-init.d/02-reconcile-profiles /app/deploy/upstream-reconcile-profiles.disabled
# Seed only an absent config before stock initialization/migrations run. The
# same seed owner is used by local bootstrap; stock init applies user ownership.
RUN mkdir -p /etc/cont-init.d && \
    printf '#!/command/with-contenv sh\nexec /usr/local/bin/node /app/deploy/seed-hermes-config.mjs\n' > /etc/cont-init.d/00-hob-config && \
    chmod 755 /etc/cont-init.d/00-hob-config
ENV MUSE_HOST=0.0.0.0 \
    MUSE_PORT=3000 \
    HERMES_DIR=/opt/hermes \
    HERMES_HOME=/opt/data \
    HERMES_EXECUTABLE=/opt/hermes/bin/hermes \
    HOB_STATE_DIR=/opt/data/.hob \
    HERMES_DASHBOARD=0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["/usr/local/bin/node", "/app/deploy/healthcheck.mjs"]
# The inherited dispatcher runs stock init, then drops this program to Hermes'
# runtime user. Our supervisor starts the two private APIs and the public app.
CMD ["/usr/local/bin/node", "/app/deploy/start.mjs"]
