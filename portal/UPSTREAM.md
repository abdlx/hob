# Bundled Portal

Source: https://github.com/abdlx/portal

Pinned revision: `63ced619d2ee5a0c85a9c378183bd6f3833976e2` (MIT; see LICENSE).

HOB vendors the runtime so Docker builds and releases ship it together. Local
changes add explicit shared workspace paths, 64-character Hermes profile IDs,
idempotent owner-only provisioning, real per-profile wake/sleep, HOB private
state mounts hidden from shell sandboxes, and fail-closed persisted state loads.
No standalone installer, systemd service, Tailscale dependency, or separate
Portal workspace is created by HOB.
