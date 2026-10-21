# syntax=docker/dockerfile:1.7
ARG NODE_BUILD_IMAGE=docker.io/library/node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
# The runtime base is pinned by digest. The newest published official release is
# 0.22.2, whose gateway control socket answers only `identify` and `status`; the
# native session authority this application requires (gateway/run_runtime.py, the
# `session-ticket` verb, runtime_protocol 1) exists only on upstream's default
# branch at the pinned commit below.
#
# So .github/workflows/hermes-runtime-image.yml builds that exact upstream commit
# with upstream's own Dockerfile and publishes it to GHCR, and it is pinned here
# by digest. Once upstream publishes a release that passes the session smoke,
# retire that workflow and pin the tested official image. The previous official
# image below is incompatible with this adapter; retain it only for provenance:
#   docker.io/nousresearch/hermes-agent@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919
# Updating either digest is an explicit, tested runtime upgrade.
ARG HERMES_IMAGE=ghcr.io/abdlx/hob-hermes-runtime:hermes-7e9eb8d9@sha256:18633293b436b15b8fb306cc065f9b86b21ddf4a9ac60601e07520044b6c00bc

FROM ${NODE_BUILD_IMAGE} AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=hob-npm,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

# The application's own server deps are installed from the lockfile rather than
# copied from the build context, so the image never carries host node_modules and
# a dependency bump cannot silently ship a half-installed tree.
FROM ${NODE_BUILD_IMAGE} AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,id=hob-npm,target=/root/.npm npm ci --omit=dev

FROM ${HERMES_IMAGE} AS runtime
# Build provenance is baked into the image so a running container can report
# exactly which commit Coolify checked out. Compose passes these from Coolify's
# SOURCE_COMMIT/COOLIFY_BRANCH variables; they are public and contain no secrets.
ARG HOB_GIT_COMMIT=unknown
ARG HOB_GIT_REF=unknown
ARG HOB_BUILD_TIME=unknown
# Preserve the upstream entrypoint, sealed runtime, PM tools, migrations and
# privilege drop. Only the application CMD and its files are added.
USER root
WORKDIR /app
COPY --from=web-build /app/web/dist/ ./web/dist/
COPY server/ ./server/
# After `server/`, so the installed deps win over anything in the build context.
COPY --from=server-build /app/server/node_modules/ ./server/node_modules/
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
    HOB_GIT_COMMIT=${HOB_GIT_COMMIT} \
    HOB_GIT_REF=${HOB_GIT_REF} \
    HOB_BUILD_TIME=${HOB_BUILD_TIME} \
    HERMES_DASHBOARD=0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["/usr/local/bin/node", "/app/deploy/healthcheck.mjs"]
# The inherited dispatcher runs stock init, then drops this program to Hermes'
# runtime user. Our supervisor starts the two private APIs and the public app.
CMD ["/usr/local/bin/node", "/app/deploy/start.mjs"]
