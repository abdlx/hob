# Headless OpenClaw backend

This checkout retains the OpenClaw gateway, CLI, agent runtime, APIs, plugins,
memory, skills, Workshop proposal service, approvals, scheduling, and execution
backends. Native companion applications and the bundled web Control UI have been
removed. The separate OpenMuse frontend in the parent workspace is unchanged.

Control UI hosting defaults to disabled. Existing gateway/WebSocket interfaces
and their authentication remain available to external clients. An operator can
explicitly enable hosting and supply a separately built `gateway.controlUi.root`;
this checkout does not build or ship a frontend.

Use the package-owned toolchain and commands:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm openclaw gateway run
```

Node must satisfy `package.json`'s supported versions, and pnpm must match its
pinned version. Backend tests and checks remain under `pnpm test`, `pnpm lint`,
and `pnpm check`. Client build, localization, and test commands are removed from
the default build/check graph. Backend native addons, platform service support,
remote node protocols, browser automation, Canvas/A2UI, and plugin-owned assets
remain; these are runtime capabilities rather than bundled client applications.

The P0a backend defaults remain `skills.workshop.autonomous.mode: "propose"` and
`skills.workshop.approvalPolicy: "pending"`. Review and activate pending proposals
through the existing Workshop CLI or authenticated gateway methods. Literal
`auto` remains an explicit opt-in. Universal autonomous staging is still deferred.

The earlier P0a report describes the pre-cleanup tree, including its now-removed
UI changes. A verified snapshot of the complete tree immediately before this
cleanup is retained outside the source directory in
`../p0a-evidence/headless/before.zip`, with a SHA-256 file manifest. This preserves
the removed clients and all previous source changes for recovery.
