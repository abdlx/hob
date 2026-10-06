import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { createDaytonaRegistration } from "./src/backend.js";
import { resolveDaytonaConfig } from "./src/config.js";

export default definePluginEntry({
  id: "daytona",
  name: "Daytona Sandbox",
  description: "Optional Daytona cloud sandbox using OpenClaw's existing remote-shell contract.",
  register(api) {
    if (api.registrationMode !== "full") { return; }
    const unregister = registerSandboxBackend("daytona", createDaytonaRegistration(resolveDaytonaConfig(api.pluginConfig)));
    api.lifecycle.registerRuntimeLifecycle({
      id: "daytona-sandbox-registration",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (sessionKey !== undefined || runId !== undefined) { return; }
        if (reason === "disable" || reason === "restart") { unregister(); }
      },
    });
  },
});
