# Deploy OpenMuse with Coolify

Use a **Git-based Application**, with **Docker Compose** as the build pack. The
repository contains the frontend, adapter, and complete modified OpenClaw source;
the Dockerfile builds that source directly. Do not choose Docker Compose Empty,
which has no Git checkout to build from.

In Configuration > General, set:

| Field | Value |
| --- | --- |
| Base Directory | `/` |
| Docker Compose Location | `/compose.yaml` |
| Domains for `muse` | `https://muse.example.com:3000` |
| Preserve Repository During Deployment | Enabled |
| Raw Compose Deployment | Disabled |

Replace the example domain with your own and point its DNS at the Coolify server.
The `:3000` suffix selects the container's internal port; visitors use
`https://muse.example.com` without that suffix. Coolify owns the proxy routing and
HTTPS certificates. The Compose service publishes no host port and does not
expose the Gateway or browser CDP.

Save and reload the Compose definition. Coolify generates and retains these
values under Environment Variables:

| Coolify variable | Used for |
| --- | --- |
| `SERVICE_PASSWORD_64_MUSE` | Password for the OpenMuse sign-in screen |
| `SERVICE_REALBASE64_64_MUSE` | Independent session signing secret |
| `SERVICE_URL_MUSE_3000` | Public application origin and proxy port selection |

Keep credentials runtime-only and disable Advanced > Inject Build Args to
Dockerfile. The Dockerfile declares its own build arguments and does not need
login or provider secrets during the build.

Copy the generated login password from Coolify's Environment Variables when you
sign in. Keep the session secret stable across deployments. Neither value is a
model API key. The app also accepts custom values assigned to those variables in
Coolify. Do not commit a `.env` file or put credentials in the Compose source.
For a custom domain, verify `SERVICE_URL_MUSE_3000` reflects its external URL
without the internal `:3000` suffix. HTTPS URLs automatically enable Secure app
cookies; `MUSE_SECURE_COOKIES=true` may also be set explicitly for an HTTPS-only
deployment. A generated HTTP test domain works for initial testing, but use HTTPS
before entering provider credentials.

Set `MUSE_PUBLIC_URL` to the external URL, for example `https://muse.example.com`,
when TLS terminates at another proxy or an older Coolify includes the internal
port in its generated URL. The external scheme, hostname, and port must match
what the browser uses so sign-in and other protected requests pass origin checks.

Deploy and inspect the build and application logs. The first boot creates the
OpenClaw configuration on the named `muse-data` volume. Open the URL, sign in,
then configure your provider/model and any channels or connectors in Settings.
No provider credentials are included in the image and chat needs a valid provider
before it can return model responses. Settings remains available while Gateway
workspace preparation finishes.

The build needs a supported Linux amd64 or arm64 host and sufficient memory;
allocate at least 8 GB for this fork's build or use a larger Coolify build server.
The Docker build sets the compiler's explicit old-space heap cap to 6144 MiB
through `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`, as well as `NODE_OPTIONS` for other
build steps. This fork replaces an inherited Node heap flag when choosing its
compiler budget, so `NODE_OPTIONS` alone does not bound the compiler. Native
bundler allocations, Docker, and other Coolify workloads need memory outside that
heap; use a dedicated larger build host if the VPS cannot provide enough headroom.
The runtime image includes Chromium. The host must support unprivileged user
namespaces and allow Chromium's sandbox under its kernel/AppArmor policy.

**Preserve Repository is required** because Docker Compose reads
`deploy/chromium-seccomp.json` on its client before creating the container.
Coolify normally runs the initial deployment from its repository clone; preserving
that clone also keeps the profile available for later host-side starts. This is a
client-side file, not a container bind mount. Compose does not accept inline JSON
in this `security_opt` value. Do not replace it with `seccomp=unconfined`, enable
privileged mode, or disable the browser sandbox. See [runtime notes](README.md).

Redeploy after pushing source changes. Coolify reuses the named volume, preserving
OpenClaw settings, credentials, conversations, identity files, scheduled tasks,
and workspace artifacts. Keep the Coolify Application and storage identity stable;
creating a separate resource creates separate storage. Back up the volume before
updates; deleting the volume deletes the application's data. Docker restarts the
service after process failure and host reboot when Docker starts. Health checks
expose readiness; they do not make Docker restart an unhealthy process by themselves.

Before relying on the deployment, check login, real chat, browser start/snapshot,
approvals, a scheduled task, and persistence after redeploy. The complete Linux
image and Coolify deployment have not yet been executed in this workspace because
no Docker daemon or connected Coolify server is available.

The repository includes a secretless Linux first-run workflow at
`.github/workflows/coolify-build.yml`. Once the complete app is pushed, it builds
the image and runs `deploy/smoke-container.mjs` on an isolated Compose project.
It checks protected login, Gateway APIs, a sandboxed browser screenshot, and
persisted configuration/identity/conversation/schedule/SOUL.md after container
recreation. This validates the image on its runner, while the actual Coolify
domain, proxy, and VPS policy still require deployment verification. The workflow
does not publish an image or configure a provider.

To run the same check on a Linux Docker host from the repository root:

```sh
docker build --build-arg OPENCLAW_BUILD_MEMORY_MB=6144 --tag openmuse:smoke .
node deploy/smoke-container.mjs
```

The script generates temporary test credentials and removes only its own Compose
project and volume when it finishes. It preserves any running OpenMuse deployment.
If cleanup fails, it retains its secret-free Compose override and prints a recovery
command. Failures report container exit/readiness fields without dumping
application logs, process arguments, or environment values.

Official references: [Git-based Docker Compose](https://coolify.io/docs/applications/builds/docker-compose),
[domains and internal ports](https://coolify.io/docs/applications/configuration/general),
[Compose seccomp file parsing](https://github.com/docker/compose/blob/main/pkg/compose/create.go).
