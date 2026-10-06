# syntax=docker/dockerfile:1.7
# These are the reviewed Node/Bun images already pinned by the modified backend.
ARG NODE_BUILD_IMAGE=docker.io/library/node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG BUN_IMAGE=docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

FROM ${BUN_IMAGE} AS bun
FROM ${NODE_BUILD_IMAGE} AS openclaw-inputs
WORKDIR /app/openclaw
RUN corepack enable
# This must be your modified source tree. No upstream download or image replaces it.
COPY openclaw/ ./
RUN test -f HEADLESS.md && node --input-type=module -e 'import { isSupportedOpenClawNodeVersion } from "./node-version.mjs"; if (!isSupportedOpenClawNodeVersion(process.versions.node)) process.exit(1)'

FROM openclaw-inputs AS openclaw-production
RUN --mount=type=cache,id=muse-pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --prod \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc

FROM openclaw-inputs AS openclaw-build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN --mount=type=cache,id=muse-pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc
ARG OPENCLAW_BUILD_MEMORY_MB=6144
# The backend's package-owned Docker graph builds runtime/plugin assets, not a UI.
RUN OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB="${OPENCLAW_BUILD_MEMORY_MB}" \
    NODE_OPTIONS="--max-old-space-size=${OPENCLAW_BUILD_MEMORY_MB}" pnpm build:docker
# Do not overlay development dependencies onto the production install.
RUN rm -rf node_modules && find packages extensions examples -name node_modules -prune -exec rm -rf '{}' +

FROM openclaw-production AS openclaw-runtime-assets
COPY --from=openclaw-build /app/openclaw/ ./
RUN node scripts/postinstall-bundled-plugins.mjs && \
    node scripts/check-package-dist-imports.mjs /app/openclaw && \
    node scripts/docker/verify-fs-safe-native.mjs --package-root /app/openclaw --mode require

FROM ${NODE_BUILD_IMAGE} AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=muse-npm,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM ${NODE_RUNTIME_IMAGE} AS runtime
WORKDIR /app
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git libgomp1 openssh-client openssl procps python3 tini && \
    rm -rf /var/lib/apt/lists/*
COPY --from=openclaw-runtime-assets /app/openclaw/ ./openclaw/
COPY --from=web-build /app/web/dist/ ./web/dist/
COPY server/ ./server/
COPY deploy/ ./deploy/
COPY LICENSE ./LICENSE
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Chromium is available on first boot; there is no browser download at startup.
# Set to 0 only when using a separately configured remote browser.
ARG INSTALL_BROWSER=1
RUN if [ "$INSTALL_BROWSER" = 1 ]; then \
      node /app/openclaw/node_modules/playwright-core/cli.js install --with-deps chromium; \
    fi && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /app/openclaw/openclaw.mjs /usr/local/bin/openclaw && \
    chmod 755 /app/openclaw/openclaw.mjs && \
    chmod -R a+rX /app /opt && \
    install -d -m 0700 -o node -g node /data /data/openclaw /data/workspace /data/home
ENV NODE_ENV=production \
    HOME=/data/home \
    MUSE_HOST=0.0.0.0 \
    MUSE_PORT=3000 \
    OPENCLAW_DIR=/app/openclaw \
    OPENCLAW_STATE_DIR=/data/openclaw \
    OPENCLAW_CONFIG_PATH=/data/openclaw/openclaw.json \
    OPENCLAW_WORKSPACE=/data/workspace \
    OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["node", "/app/deploy/healthcheck.mjs"]
ENTRYPOINT ["tini", "-s", "--", "node", "/app/deploy/start.mjs"]
