# End-to-end: the Hermes browser tools against a real managed browser

`hermes-tools-e2e.py` walks the scenario this subsystem exists for, using **Hermes'
own tool functions** (`browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_cdp`) and the **real `agent-browser` CLI** underneath them,
against a Chromium that `harness-server.mjs` started and is proxying.

```
the bot browses (navigate / snapshot / type / click)
-> the person watches
-> the person takes control
-> the bot's mutation is refused, through its tools and through raw CDP
-> the person drives the browser over the viewer socket
-> control is handed back
-> the bot carries on in the very same tab, on the person's page
-> nobody is watching, so the browser idles down
-> the bot uses it again: same endpoint, same profile
```

`harness-server.mjs` is a real hob server — real routes, real manager, real Chromium.
Only the Hermes gateway client is inert, because the browser routes never speak to it.

## Running it

```
cd server && npm ci
pip install ruamel.yaml requests websockets psutil    # Hermes' browser tool chain + the supervisor
python e2e/hermes-tools-e2e.py
```

`agent-browser` must be on `PATH` (`npm i -g agent-browser`), and Chromium is found
normally or named by `HOB_CHROMIUM_PATH`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HERMES_REPO` | `../hermes-agent` | the Hermes checkout whose tools are imported |
| `HOB_CHROMIUM_PATH` | discovered | Chromium/Chrome executable |
| `HOB_E2E_SITE` | `https://example.com` | what the bot browses |
| `HOB_E2E_FORM_SITE` | Wikipedia's main page | the page with a form, for type/click |
| `HOB_E2E_HUMAN_SITE` | IANA's example-domains page | where the person drives it |
| `HOB_E2E_WORK` | a temp dir | state dir and the bot's `HERMES_HOME` |
| `HOB_E2E_IDLE_MS` | `15000` | idle window, shortened so the scenario is quick |

Only public URLs by default, deliberately: Hermes' private-address guard stays on, so
a loopback page would be refused and the scenario would prove the wrong thing.

Exit code is the number of failed checks, so this is usable as a gate. It is not part
of `npm test`, because it needs a network, a browser and a Hermes checkout.
