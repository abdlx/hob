The container runs the web adapter and modified OpenClaw Gateway under Tini and
`start.mjs`. Both children receive SIGTERM on shutdown; if either exits unexpectedly,
the supervisor stops the other and exits unsuccessfully so Docker can restart it.
Gateway auth, loopback binding, and port 18789 are managed runtime constraints;
user config is only created once, using exclusive creation, and never reset at boot.

The default `compose.yaml` targets a Git-based Coolify Application. Follow
[the Coolify setup](COOLIFY.md) for proxy routing, generated login credentials,
and repository preservation. For local/standalone use, add
`-f compose.yaml -f compose.standalone.yaml` to Compose commands and configure
the private `.env` using the root `.env.example`.

`chromium-seccomp.json` starts from Moby/Docker 28.0.4's default profile, as
preserved in the local modified OpenClaw checkout at
`scripts/lib/codex-live-docker-security/seccomp.json`. The six Bubblewrap-specific
rules appended there were removed. One rule allows `clone`, `setns`, and `unshare`
for Chromium's own user-namespace sandbox. The syscall allowlist, capability
checks, and default deny remain. This does not disable Chromium's sandbox or grant
SYS_ADMIN. Its base profile's Apache-2.0 license and notice are included here.
Compose reads this profile file on the client before container creation. Keep
the repository available for later starts; in Coolify, enable Preserve Repository
During Deployment. The profile is not read from the built image at this boundary.
The upstream source is
https://github.com/moby/moby/blob/v28.0.4/profiles/seccomp/default.json and the
unmodified source SHA-256 is
`9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76`.

The host kernel must permit unprivileged user namespaces. Some VPS kernels or
AppArmor policies block them. If a browser launch reports a sandbox error, fix
that host restriction or configure a remote browser; do not use privileged mode,
mount the Docker socket, or disable Chromium's sandbox as a routine workaround.
The browser is owned by OpenClaw and operates on its managed profile. This is
separate from optional Docker-based agent sandboxes, which need a separately
configured execution backend and are not enabled by this container.
