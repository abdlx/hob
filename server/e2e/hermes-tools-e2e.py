"""End-to-end: the real Hermes browser tools driving a HOB-managed persistent browser.

The sequence is the one that matters:

    the bot browses -> a person watches -> the person takes control ->
    the bot is refused any change (via its tools *and* via raw CDP) ->
    the person drives -> control is handed back ->
    the bot carries on in the same tab, on the person's page ->
    the dashboard refuses strangers and one-shot tickets ->
    two people watch at once -> a second bot gets its own browser ->
    a session cookie is stored -> the browser idles down -> it comes back
    still signed in on the same endpoint -> the browser is killed under the
    person's hands and comes back -> and, throughout, the browser is reachable
    only through the gateway: no raw DevTools port exists to bypass it.

Nothing about Hermes is patched. The tools imported below are the same
``browser_navigate`` / ``browser_snapshot`` / ``browser_click`` / ``browser_type`` /
``browser_cdp`` functions the agent calls, and ``agent-browser`` underneath them is
the real CLI. The browser on the other side is a real Chromium that hob launched and
is proxying.

Prerequisites (this is a scenario, not a unit test: it needs a network and a browser):

  * ``hob``'s server deps installed (``cd server && npm ci``).
  * ``agent-browser`` on PATH (``npm i -g agent-browser``).
  * Chromium/Chrome, discovered normally or named by ``HOB_CHROMIUM_PATH``.
  * The Hermes tree importable by *this* interpreter. It needs Hermes' runtime deps
    (in practice ``ruamel.yaml``, ``requests`` and ``websockets``) plus what the
    supervisor pulls in (``psutil``). A scratch venv is the cheapest way:

        python -m venv /tmp/hob-e2e
        /tmp/hob-e2e/bin/pip install ruamel.yaml requests websockets psutil
        /tmp/hob-e2e/bin/python server/e2e/hermes-tools-e2e.py

  Environment:
    HERMES_REPO            Hermes checkout (default: ../hermes-agent)
    HOB_CHROMIUM_PATH      Chromium/Chrome executable
    HOB_E2E_SITE           what the bot browses (default https://example.com)
    HOB_E2E_HUMAN_SITE     where the person drives it (default IANA's page)

Only public URLs are used, deliberately: Hermes' private-address guard stays on, so a
loopback page would be refused and the scenario would be testing the wrong thing.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER_DIR = HERE.parent
REPO_ROOT = SERVER_DIR.parent

HERMES_REPO = Path(os.environ.get("HERMES_REPO", REPO_ROOT / "hermes-agent"))
CHROME = os.environ.get("HOB_CHROMIUM_PATH", "")
WORK = Path(os.environ.get("HOB_E2E_WORK", tempfile.mkdtemp(prefix="hob-e2e-")))
STATE = WORK / "state"
HOME = WORK / "hermes-home"

BOT = "default"
PASSWORD = "e2e-password"
# Extra bot profiles, for the isolation scenario. `default` is always included.
EXTRA_BOTS = [name.strip() for name in os.environ.get("HOB_E2E_BOTS", "beta").split(",") if name.strip()]
SITE = os.environ.get("HOB_E2E_SITE", "https://example.com")
# Deliberately a different page, with unmistakable content: the bot has to be able to
# tell that the page it gets back is the one the person left it on.
HUMAN_SITE = os.environ.get("HOB_E2E_HUMAN_SITE", "https://www.iana.org/help/example-domains")
# A page with a real form, for typing and clicking.
FORM_SITE = os.environ.get("HOB_E2E_FORM_SITE", "https://en.wikipedia.org/wiki/Main_Page")

failures = []
notes = []


def check(label, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {label}" + (f"  -> {detail}" if detail else ""), flush=True)
    if not condition:
        failures.append(label)
    return condition


def info(label):
    print(f"[INFO] {label}", flush=True)


# ── the hob HTTP surface ─────────────────────────────────────────────────────


def login(base):
    import requests
    response = requests.post(f"{base}/api/auth/login", json={"password": PASSWORD}, timeout=20)
    response.raise_for_status()
    cookies = "; ".join(part.split(";")[0] for part in response.raw.headers.getlist("Set-Cookie"))
    return {part.split("=")[0]: part.split("=", 1)[1] for part in cookies.split("; ")}


def status(base, cookie, profile=BOT):
    import requests
    response = requests.get(f"{base}/api/hermes/browser", params={"profile": profile}, cookies=cookie, timeout=30)
    response.raise_for_status()
    return response.json()


def control(base, cookie, action):
    import requests
    response = requests.post(f"{base}/api/hermes/browser/control",
                             params={"profile": BOT}, json={"action": action}, cookies=cookie, timeout=30)
    response.raise_for_status()
    return response.json()


def diag(label, base, cookie):
    """Print what the browser really holds: its page and every open tab.

    Read from the browser's own target list, not from the agent's view of it, so it
    is independent evidence of what the person and the bot are both looking at.
    """
    view = status(base, cookie)
    tabs = [(tab["id"][:8], tab["url"][:52], tab["active"]) for tab in view.get("tabs", [])]
    info(f"{label}: url={view.get('url')!r} tabs={tabs}")


def wait_for(predicate, timeout=60.0, interval=0.5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    return last


def refs_from_snapshot(tree, role_pattern, require=None):
    """Pull element refs out of a snapshot.

    The snapshot arrives as JSON text with escaped newlines, so it is split on those
    first: matching line by line is what keeps one element from swallowing the next.
    """
    lines = tree.replace("\\n", "\n").split("\n")
    found = []
    for line in lines:
        if not re.search(role_pattern, line):
            continue
        if require and not re.search(require, line):
            continue
        match = re.search(r"\[ref=([^\]]+)\]", line)
        if match:
            found.append(match.group(1))
    return found


def phase_browse(base, cookie, browser_navigate, browser_snapshot):
    """The bot browses on its own, and interacts with a real form."""
    info("phase 1: the bot navigates with its own browser_navigate")
    first = browser_navigate(SITE, task_id="e2e")
    info(f"browser_navigate -> {first[:400]}")
    check("the bot's browser_navigate succeeds through the gateway",
          '"success": true' in first, first[:200])

    snapshot = browser_snapshot(task_id="e2e")
    info(f"browser_snapshot -> {snapshot[:600]}")
    check("the bot's browser_snapshot reaches the real page",
          "https://example.com" in snapshot and '"success": true' in snapshot)


def phase_focused_tools(base, cookie, navigate, snapshot, fill, click, console, cdp):
    """Pinned-image contract: real native tools, disposable DOM, no model calls.

    Only navigation loads a public page. Inputs and clicks affect a synthetic
    client-side DOM; no form, message or transaction is submitted externally.
    """
    def result(raw):
        value = json.loads(raw)
        assert isinstance(value, dict), "Native tool response must be an object"
        return value

    def succeeds(label, raw):
        value = result(raw)
        assert value.get("success") is True, label + ": " + json.dumps(value)[:700]
        print("[PASS] " + label, flush=True)
        return value

    succeeds("pinned Hermes navigates through HOB's broker", navigate(SITE, task_id="e2e"))
    assert status(base, cookie)["url"].rstrip("/") == SITE.rstrip("/")
    fixture = """(() => {
      const draft = document.createElement('input'); draft.id = 'hob-fixture';
      const label = document.createElement('label'); label.textContent = 'Fixture draft'; label.append(draft);
      const button = document.createElement('button'); button.id = 'hob-apply'; button.textContent = 'Apply fixture';
      const output = document.createElement('p'); output.id = 'hob-result';
      document.body.replaceChildren(label, button, output);
      window.hobFixtureClicks = 0;
      document.getElementById('hob-apply').onclick = () => {
        window.hobFixtureClicks++;
        document.getElementById('hob-result').textContent = 'clicked ' + window.hobFixtureClicks;
      };
      return 'fixture-ready';
    })()"""
    succeeds("native console creates only the disposable DOM fixture", console(expression=fixture, task_id="e2e"))
    tree = snapshot(task_id="e2e")
    succeeds("native snapshot reads the disposable controls", tree)
    boxes = refs_from_snapshot(tree, r"\btextbox\b", require="Fixture draft")
    buttons = refs_from_snapshot(tree, r"\bbutton\b", require="Apply fixture")
    assert len(boxes) == len(buttons) == 1, "Native snapshot must expose both fixture refs"
    succeeds("native typing reaches the actual input", fill(boxes[0], "reviewed value", task_id="e2e"))
    succeeds("native clicking invokes the actual button", click(buttons[0], task_id="e2e"))
    expression = "({value: document.getElementById('hob-fixture').value, clicks: window.hobFixtureClicks})"
    expected = {"value": "reviewed value", "clicks": 1}
    assert succeeds("native evaluation verifies the final DOM", console(expression=expression, task_id="e2e"))["result"] == expected
    assert control(base, cookie, "take")["control"]["holder"] == "human"
    before_url = status(base, cookie)["url"]
    attempts = [
        ("navigation", lambda: navigate(SITE + "?blocked=1", task_id="e2e")),
        ("typing", lambda: fill(boxes[0], "forbidden", task_id="e2e")),
        ("clicking", lambda: click(buttons[0], task_id="e2e")),
        ("console evaluation", lambda: console(expression="window.hobFixtureClicks = 99", task_id="e2e")),
    ]
    for label, attempt in attempts:
        assert result(attempt()).get("success") is False, "Human takeover must refuse native " + label
        print("[PASS] human takeover refuses native " + label, flush=True)
    raw = cdp(method="Page.navigate", params={"url": SITE + "?raw-blocked=1"}, task_id="e2e")
    assert "-32001" in raw, "Raw native CDP must surface the broker's lease refusal: " + raw[:700]
    assert status(base, cookie)["url"] == before_url, "No refused path may navigate"
    assert control(base, cookie, "release")["control"]["holder"] == "agent"
    assert succeeds("native tools resume after human handback", console(expression=expression, task_id="e2e"))["result"] == expected
    succeeds("a native click succeeds after handback", click(buttons[0], task_id="e2e"))
    assert succeeds("handback preserves the same DOM and input", console(expression=expression, task_id="e2e"))["result"] == {**expected, "clicks": 2}
    print("[PASS] pinned native browser tools and raw CDP honor the human lease", flush=True)


def phase_type_and_click(base, cookie, browser_navigate, browser_snapshot, browser_type, browser_click):
    info("phase 1b: the bot types and clicks on a real page")
    opened = browser_navigate(FORM_SITE, task_id="e2e")
    check("the bot can open a page with a form", '"success": true' in opened, opened[:200])
    tree = browser_snapshot(task_id="e2e")
    boxes = refs_from_snapshot(tree, r"\b(textbox|searchbox|combobox)\b")
    buttons = refs_from_snapshot(tree, r"\bbutton\b", require=r"[Ss]earch")
    check("the form is in the bot's snapshot", bool(boxes), f"fields={boxes} buttons={buttons}")
    if not boxes:
        notes.append("no form field found in the snapshot; type/click not exercised")
        return
    typed = browser_type(boxes[0], "Chromium DevTools Protocol", task_id="e2e")
    info(f"browser_type -> {typed[:300]}")
    check("the bot's browser_type succeeds", '"success": true' in typed, typed[:200])
    if not buttons:
        notes.append("no button found in the snapshot; click not exercised")
        return
    clicked = browser_click(buttons[0], task_id="e2e")
    info(f"browser_click -> {clicked[:300]}")
    check("the bot's browser_click succeeds", '"success": true' in clicked, clicked[:200])
    searched = wait_for(lambda: (lambda s: s if "search=" in s["url"].lower() or "Search" in s["title"]
                                 else None)(status(base, cookie)), timeout=30)
    check("typing and clicking actually changed the page", bool(searched), (searched or {}).get("url", ""))


def phase_watching(base, cookie):
    """The dashboard can see the bot's page, connection and control - and no credential."""
    watcher = wait_for(lambda: (lambda s: s if s["state"] == "running" and s["url"].startswith("https://example.com")
                                else None)(status(base, cookie)), timeout=30)
    check("the dashboard sees the bot's page", bool(watcher), json.dumps(watcher or {})[:300])
    check("the dashboard sees the bot attached to the browser",
          bool(watcher and watcher["agentConnections"] >= 1),
          f"agentConnections={watcher and watcher['agentConnections']}")
    check("the dashboard sees the bot holding control",
          bool(watcher and watcher["control"]["holder"] == "agent"))
    check("the dashboard view carries no agent credential",
          bool(watcher) and "cdpUrl" not in watcher and "profileDir" not in watcher)


def phase_takeover(base, cookie, browser_navigate):
    """A person takes control, and the bot cannot change anything - by any route."""
    info("phase 2: the person takes control")
    taken = control(base, cookie, "take")
    check("the person holds control", taken["control"]["holder"] == "human", json.dumps(taken.get("control")))

    info("phase 3: the bot tries to change the page while the person is in control")
    before_view = status(base, cookie)
    before = before_view["url"]
    tab_before = before_view["tabs"][0]["id"] if before_view["tabs"] else None
    info(f"the page the person is looking at: {before} (tab {tab_before})")

    blocked = browser_navigate(HUMAN_SITE, task_id="e2e")
    info(f"blocked browser_navigate -> {blocked[:400]}")
    time.sleep(2)
    during = status(base, cookie)
    check("the bot's navigation could not change the page", during["url"] == before,
          f"{before!r} -> {during['url']!r}")
    check("the refusal is reported to the bot rather than hanging",
          '"success": false' in blocked, blocked[:200])

    # The same attempt through the bot's raw CDP tool: the escape hatch a UI-only
    # takeover flag would leave wide open.
    try:
        from tools.browser_cdp_tool import browser_cdp
        raw = browser_cdp(method="Page.navigate", params={"url": HUMAN_SITE}, task_id="e2e")
        info(f"raw browser_cdp Page.navigate -> {raw[:400]}")
        check("raw CDP is refused loudly", "-32001" in raw, raw[:200])
        time.sleep(2)
        after_raw = status(base, cookie)
        check("raw CDP from the bot cannot change the page either", after_raw["url"] == before,
              f"{before!r} -> {after_raw['url']!r}")
    except Exception as error:  # pragma: no cover - the tool may not be importable here
        notes.append(f"browser_cdp check skipped: {error}")
    return tab_before


def phase_handback(base, cookie, browser_snapshot, browser_navigate, tab_before):
    """The person drives over the real viewer socket; the bot resumes in the same tab."""
    info("phase 4: the person drives the browser")
    import requests
    from websockets.sync.client import connect
    minted = requests.post(f"{base}/api/hermes/browser/viewer", params={"profile": BOT}, cookies=cookie,
                           timeout=30).json()
    ws_url = f"{base.replace('http://', 'ws://')}{minted['wsPath']}?profile={BOT}&token={minted['viewerToken']}"
    with connect(ws_url, open_timeout=30) as socket:
        hello = json.loads(socket.recv(timeout=30))
        check("the viewer socket greets the person", hello.get("t") == "hello", json.dumps(hello)[:200])
        check("the viewer is told the person has control", hello.get("control", {}).get("holder") == "human")
        socket.send(json.dumps({"t": "navigate", "url": HUMAN_SITE}))
        driven = wait_for(lambda: (lambda s: s if s["url"] == HUMAN_SITE else None)(status(base, cookie)), timeout=30)
        check("the person can drive the browser while holding control", bool(driven), (driven or {}).get("url", ""))
        diag("after the person navigated", base, cookie)

        info("phase 5: control is handed back")
        released = control(base, cookie, "release")
        check("the bot has control again", released["control"]["holder"] == "agent")

        info("phase 6: the bot carries on in the same browser")
        diag("before the bot's first command after handback", base, cookie)
        handback = status(base, cookie)
        same_tab = [tab for tab in handback["tabs"] if tab["id"] == tab_before]
        check("the browser still holds the very same tab, on the page the person left it on",
              bool(same_tab) and same_tab[0]["url"] == HUMAN_SITE, json.dumps(handback["tabs"])[:200])
        # The person handed back the moment the URL committed. Chromium can still be
        # building the accessibility tree for that document, and a snapshot taken in
        # that window is legitimately empty; the bot's own retry does the same. Poll
        # rather than assert on the first frame.
        resumed = ""

        def sees_page():
            nonlocal resumed
            resumed = browser_snapshot(task_id="e2e")
            return resumed if "Example Domains" in resumed else None

        wait_for(sees_page, timeout=15)
        info(f"browser_snapshot after handback -> {resumed[:400]}")
        check("the bot sees the page the person left it on", "Example Domains" in resumed, resumed[:200])
        again = browser_navigate(f"{SITE}/?agent=2", task_id="e2e")
        check("the bot's navigation works again after handback", '"success": true' in again, again[:200])


def phase_idle_and_restart(base, cookie, browser_navigate, gateway_port):
    info("phase 7: the browser idles down once nobody is watching")
    idle_ms = float(os.environ.get("HOB_E2E_IDLE_MS", 15000))
    stopped = wait_for(lambda: (lambda s: s if s["state"] == "stopped" else None)(status(base, cookie)),
                       timeout=max(120.0, 6 * idle_ms / 1000))
    check("an idle browser is shut down", bool(stopped), json.dumps(stopped or {})[:200])

    info("phase 8: the bot uses its browser again")
    revived = browser_navigate(SITE, task_id="e2e")
    check("the bot's browser comes back after an idle shutdown", '"success": true' in revived, revived[:200])
    back = status(base, cookie)
    check("it comes back on the same endpoint, so the bot's config still holds",
          bool(back) and back["state"] == "running", json.dumps(back)[:200])
    # The bot's profile still names one URL; that only stays true if the restarted
    # browser came back on the port and token the profile was written with.
    records = json.loads((STATE / "browsers.json").read_text(encoding="utf-8"))["browsers"]
    record = next(entry for entry in records if entry["bot"] == BOT)
    check("the restarted browser kept the endpoint the bot's profile names",
          record["gatewayPort"] == gateway_port, f"{record['gatewayPort']} vs {gateway_port}")


def viewer_url(base, profile, token, ws_path="/api/hermes/browser/viewer"):
    """The URL `@atriumjs/react` builds for the viewer socket."""
    return f"{base.replace('http://', 'ws://')}{ws_path}?profile={profile}&token={token}"


def mint_ticket(base, cookie, profile=BOT):
    import requests
    return requests.post(f"{base}/api/hermes/browser/viewer", params={"profile": profile},
                         cookies=cookie, timeout=30).json()


def ws_connect(url, cookie=None, timeout=30):
    """Open a viewer socket, with or without the person's session cookie.

    The websockets client renamed this header kwarg mid-life
    (``extra_headers`` -> ``additional_headers``), so accept either.
    """
    from websockets.sync.client import connect
    attempts = [{}]
    if cookie:
        header = "; ".join(f"{name}={value}" for name, value in cookie.items())
        attempts = [{"additional_headers": {"Cookie": header}}, {"extra_headers": {"Cookie": header}}]
    last = None
    for kwargs in attempts:
        try:
            return connect(url, open_timeout=timeout, **kwargs)
        except TypeError as error:  # pragma: no cover - depends on the websockets build
            last = error
    raise last


def recv_json(socket, timeout=30):
    """The viewer's greeting, and nothing else: it is always the first message."""
    data = socket.recv(timeout=timeout)
    return json.loads(data) if not isinstance(data, (bytes, bytearray)) else {"t": "frame"}


def wait_for_frame(socket, timeout=30.0):
    """A screencast frame: the viewer is being *shown* the browser, not just told about it."""
    from websockets.exceptions import ConnectionClosed
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = socket.recv(timeout=max(0.2, deadline - time.time()))
        except (TimeoutError, ConnectionClosed):
            return False
        if isinstance(data, (bytes, bytearray)):
            return True
    return False


def socket_refused(url, cookie=None):
    """True when the upgrade does not complete, which is what a bad credential gets."""
    try:
        socket = ws_connect(url, cookie=cookie, timeout=15)
    except Exception:
        return True
    socket.close()
    return False


def phase_access_control(base, cookie):
    """The dashboard API answers only the person who is signed in, about their own bots."""
    info("phase 9: the dashboard API is not open to the world")
    import requests
    anonymous = requests.get(f"{base}/api/hermes/browser", params={"profile": BOT}, timeout=20)
    check("an unauthenticated dashboard request is refused", anonymous.status_code == 401,
          f"status={anonymous.status_code}")
    stranger = requests.get(f"{base}/api/hermes/browser", params={"profile": "someone-elses-bot"},
                            cookies=cookie, timeout=20)
    check("a bot that is not in the dashboard is a 404, not a view", stranger.status_code == 404,
          f"status={stranger.status_code}")


def phase_ticket_security(base, cookie):
    """A viewer ticket is a one-shot bearer credential: forged, spent and absent all fail."""
    info("phase 10: viewer ticket security")
    minted = mint_ticket(base, cookie)
    url = viewer_url(base, BOT, minted["viewerToken"], minted["wsPath"])
    check("a viewer ticket expires", minted.get("expiresAt", 0) > time.time() * 1000,
          str(minted.get("expiresAt")))

    check("a forged ticket is refused", socket_refused(viewer_url(base, BOT, "not-a-real-ticket", minted["wsPath"])),
          "the upgrade must not complete")

    with ws_connect(url) as socket:
        hello = recv_json(socket)
        check("a fresh ticket opens the stream", hello.get("t") == "hello", json.dumps(hello)[:200])

    check("a spent ticket cannot be replayed", socket_refused(url), "tickets are single use")
    check("no ticket and no session is refused",
          socket_refused(viewer_url(base, BOT, "", minted["wsPath"])), "the upgrade must not complete")

    # A long-lived tab has no live ticket after a reload or a dropped socket. Its
    # same-origin session cookie is the credential, and that is only safe because
    # the upgrade also insists on a same-origin request.
    with ws_connect(url, cookie=cookie) as socket:
        hello = recv_json(socket)
        check("a spent ticket is accepted again when the person's own session is attached",
              hello.get("t") == "hello", json.dumps(hello)[:200])


def phase_multi_viewer(base, cookie, browser_navigate):
    """Two people watch one bot: both are served from a single screencast, and one leaving is not the other's problem."""
    info("phase 11: two viewers watch the same bot")
    first = mint_ticket(base, cookie)
    second = mint_ticket(base, cookie)
    a = b = None
    try:
        a = ws_connect(viewer_url(base, BOT, first["viewerToken"], first["wsPath"]))
        b = ws_connect(viewer_url(base, BOT, second["viewerToken"], second["wsPath"]))
        hello_a, hello_b = recv_json(a), recv_json(b)
        check("both viewers are greeted", hello_a.get("t") == "hello" and hello_b.get("t") == "hello",
              f"{hello_a.get('t')}/{hello_b.get('t')}")
        check("both viewers are told the same thing about control",
              hello_a.get("control", {}).get("holder") == hello_b.get("control", {}).get("holder"),
              json.dumps(hello_a.get("control")))
        counted = wait_for(lambda: (lambda s: s if s["viewers"] == 2 else None)(status(base, cookie)), timeout=30)
        check("the dashboard counts both viewers", bool(counted), f"viewers={counted and counted['viewers']}")

        # A repaint has to reach *both* panels; one screencast feeds them all.
        browser_navigate(f"{SITE}/?frames=two", task_id="e2e")
        check("the first viewer receives screencast frames", wait_for_frame(a, timeout=45))
        check("the second viewer receives screencast frames", wait_for_frame(b, timeout=45))
    finally:
        for socket in (a, b):
            if socket is not None:
                socket.close()

    remaining = wait_for(lambda: (lambda s: s if s["viewers"] == 0 else None)(status(base, cookie)), timeout=30)
    check("closing the panels leaves the bot's browser alone",
          bool(remaining) and remaining["state"] == "running", json.dumps(remaining or {})[:200])

    # Reconnecting is the normal case for a dropped socket: a new ticket, a fresh
    # hello, and a panel that comes back *live* rather than blank.
    again = mint_ticket(base, cookie)
    with ws_connect(viewer_url(base, BOT, again["viewerToken"], again["wsPath"])) as socket:
        hello = recv_json(socket)
        check("a reconnecting viewer is greeted again", hello.get("t") == "hello", json.dumps(hello)[:200])
        browser_navigate(f"{SITE}/?frames=reconnect", task_id="e2e")
        check("the reconnected viewer receives frames again", wait_for_frame(socket, timeout=45))


def phase_multiple_bots(base, cookie, facts):
    """A second bot gets its own browser, its own port and its own page."""
    info("phase 12: a second bot has its own browser")
    others = [name for name in facts.get("bots", []) if name != BOT]
    if not others:
        notes.append("only one bot profile was configured; cross-bot isolation not exercised here")
        return
    other = others[0]
    here = status(base, cookie)
    check("the two bots are given different endpoints",
          facts["endpoints"][other]["gatewayPort"] != facts["gatewayPort"],
          f"{facts['gatewayPort']} vs {facts['endpoints'][other]['gatewayPort']}")

    minted = mint_ticket(base, cookie, other)
    with ws_connect(viewer_url(base, other, minted["viewerToken"], minted["wsPath"])) as socket:
        hello = recv_json(socket)
        check(f"the second bot ({other}) attaches a viewer of its own", hello.get("t") == "hello",
              json.dumps(hello)[:200])
        there = wait_for(lambda: (lambda s: s if s["state"] == "running" else None)(status(base, cookie, other)),
                         timeout=60)
        check("the second bot starts a browser of its own", bool(there), json.dumps(there or {})[:200])
        check("the second bot's browser is not the first bot's browser",
              bool(there) and there["url"] != here["url"], f"{here['url']} vs {there and there['url']}")
        check("the second bot's browser holds its own blank page, not the first bot's page",
              bool(there) and "example.com" not in (there["url"] or ""), (there or {}).get("url", ""))
    # And the isolation holds in the other direction: the first bot is untouched.
    check("the first bot's page is unaffected by the second bot coming up",
          status(base, cookie)["url"] == here["url"], f"{here['url']} -> {status(base, cookie)['url']}")


def phase_store_session_state(browser_console):
    """Store a *session* cookie and local state, to be looked for after the restart.

    Session cookies are the ones a browser normally drops on exit, so this is the
    check that decides whether "the bot is still signed in" survives a restart.
    """
    info("phase 13: the bot stores a session cookie and local state")
    try:
        planted = browser_console(
            expression="document.cookie = 'e2e_session=kept; path=/';"
                       " localStorage.setItem('e2e_persist', 'kept');"
                       " 'COOKIE=' + document.cookie + ';STORE=' + localStorage.getItem('e2e_persist')",
            task_id="e2e")
    except Exception as error:  # pragma: no cover - the tool may not be importable here
        notes.append(f"session state could not be planted: {error}")
        return False
    info(f"browser_console -> {planted[:300]}")
    return check("the bot can store a session cookie and local state",
                 "COOKIE=e2e_session=kept" in planted, planted[:300])


def phase_check_session_state(browser_console, browser_navigate):
    """After a restart, the session cookie and local state must still be there."""
    info("phase 15: the restarted browser is still signed in")
    browser_navigate(f"{SITE}/?after-restart=1", task_id="e2e")
    try:
        seen = browser_console(
            expression="'COOKIE=' + document.cookie + ';STORE=' + localStorage.getItem('e2e_persist')",
            task_id="e2e")
    except Exception as error:  # pragma: no cover
        notes.append(f"session state could not be read back: {error}")
        return
    info(f"browser_console -> {seen[:300]}")
    check("the session cookie survived the restart", "COOKIE=e2e_session=kept" in seen, seen[:300])
    check("page storage survived the restart", "STORE=kept" in seen, seen[:300])


def kill_browser(profile_dir):
    """Kill the browser process outright - a crash, not a shutdown.

    Found by profile directory rather than by name, so nothing else on the host
    can be hit by accident, and the count is reported back as evidence that
    something really did die.
    """
    if os.name == "nt":
        script = (
            "$p = Get-CimInstance Win32_Process | Where-Object { "
            f"$_.Name -like 'chrome*' -and $_.CommandLine -like '*{profile_dir}*' }}; "
            "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; $p.Count"
        )
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                                capture_output=True, text=True)
        killed = (result.stdout or "").strip().splitlines()
        return int(killed[-1]) if killed and killed[-1].isdigit() else 0
    result = subprocess.run(["pkill", "-9", "-f", profile_dir], capture_output=True)
    return 1 if result.returncode == 0 else 0


def phase_crash_recovery(base, cookie, browser_navigate, facts):
    """The browser dies while a person holds control; the bot gets a working one back."""
    info("phase 16: the browser crashes while the person is in control")
    control(base, cookie, "take")
    killed = kill_browser(facts["profileDirs"][BOT])
    check("the browser process was killed outright", killed > 0, f"processes killed={killed}")
    crashed = wait_for(lambda: (lambda s: s if s["lastError"] else None)(status(base, cookie)), timeout=60)
    check("the dashboard reports the crash instead of pretending", bool(crashed),
          json.dumps(crashed or {})[:200])
    control(base, cookie, "release")
    revived = browser_navigate(SITE, task_id="e2e")
    check("the bot gets a working browser back after the crash", '"success": true' in revived, revived[:200])
    back = wait_for(lambda: (lambda s: s if s["state"] == "running" else None)(status(base, cookie)), timeout=60)
    check("the recovered browser is running again", bool(back), json.dumps(back or {})[:200])
    check("the recovered browser is usable, on the page the bot asked for",
          bool(back) and back["url"].startswith("https://example.com"), (back or {}).get("url", ""))


def devtools_listeners(profile_dir):
    """Every TCP port the browser's own process tree is listening on.

    Empty is the secure answer in pipe mode. ``None`` means the process tree could
    not be found, which the caller reports as a limited check rather than a pass.
    """
    if os.name == "nt":
        script = (
            "$p = @(Get-CimInstance Win32_Process | Where-Object { "
            f"$_.Name -match '^(chrome|chromium)' -and $_.CommandLine -like '*{profile_dir}*' }} | "
            "ForEach-Object { $_.ProcessId }); "
            "if ($p.Count -eq 0) { 'NO-PROCESS' } else { "
            "$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
            "Where-Object { $p -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort }); "
            "if ($ports.Count -eq 0) { 'NONE' } else { $ports -join ',' } }"
        )
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                                capture_output=True, text=True)
        text = (result.stdout or "").strip()
        if text == "NONE":
            return []
        if text == "NO-PROCESS" or not text:
            return None
        return [int(port) for port in text.split(",") if port.isdigit()]

    tree = subprocess.run(["pgrep", "-f", profile_dir], capture_output=True, text=True)
    pids = set((tree.stdout or "").split())
    if not pids:
        return None
    listing = subprocess.run(["sh", "-c", "ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null"],
                             capture_output=True, text=True).stdout
    ports = []
    for line in listing.splitlines():
        owner = re.search(r"pid=(\d+)", line)
        if not owner or owner.group(1) not in pids:
            continue
        port = re.search(r":(\d+)\s", line)
        if port:
            ports.append(int(port.group(1)))
    return ports


def phase_no_devtools_port(base, cookie, facts):
    """Phase 17: production mode leaves no raw DevTools TCP door (finding H1)."""
    info("phase 17: the browser exposes no raw DevTools port")
    live = status(base, cookie)
    check("the dashboard reports the pipe transport", live.get("transport") == "pipe",
          json.dumps({"state": live.get("state"), "transport": live.get("transport")}))

    offenders = []
    checked = 0
    for name, profile in facts["profileDirs"].items():
        if os.path.exists(os.path.join(profile, "DevToolsActivePort")):
            offenders.append(f"{name}:DevToolsActivePort")
        ports = devtools_listeners(profile)
        if ports is None:
            # No browser process for this bot at the moment: nothing to inspect,
            # and nothing that could be listening.
            continue
        checked += 1
        for port in ports:
            for path in ("/json/version", "/json/list"):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
                        body = response.read(400)
                except Exception:
                    continue
                if b"webSocketDebuggerUrl" in body:
                    offenders.append(f"{name}:{port}{path}")
        if ports:
            notes.append(f"{name}: the browser tree listens on {ports}")

    check("no raw DevTools endpoint and no DevToolsActivePort anywhere",
          not offenders, ", ".join(offenders) or f"no listeners across {checked} browser(s)")
    check("at least one running browser was actually inspected", checked > 0,
          f"inspected={checked}")


def main():
    shutil.rmtree(STATE, ignore_errors=True)
    shutil.rmtree(HOME, ignore_errors=True)
    HOME.mkdir(parents=True, exist_ok=True)

    environment = {**os.environ}
    if CHROME:
        environment["HOB_CHROMIUM_PATH"] = CHROME
    environment["HOB_E2E_BOTS"] = ",".join([BOT, *EXTRA_BOTS])
    server = subprocess.Popen(
        ["node", "e2e/harness-server.mjs", BOT, PASSWORD, str(STATE)],
        cwd=str(SERVER_DIR), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, env=environment,
    )
    try:
        ready = server.stdout.readline()
        if not ready.startswith("READY "):
            print("the harness server did not start:", ready, flush=True)
            print(server.stdout.read()[-4000:], flush=True)
            return 1
        facts = json.loads(ready[len("READY "):])
        base = f"http://127.0.0.1:{facts['httpPort']}"
        info(f"hob listening on {base}")
        info(f"bot {BOT} uses its private broker endpoint")

        # The bot's Hermes profile is pointed at the managed browser exactly the way
        # the product does it: browser.backend=off plus browser.cdp_url.
        (HOME / "config.yaml").write_text(
            'browser:\n  backend: "off"\n' f"  cdp_url: {facts['cdpUrl']}\n", encoding="utf-8")
        os.environ["HERMES_HOME"] = str(HOME)
        sys.path.insert(0, str(HERMES_REPO))

        from tools.browser_tool import browser_navigate, browser_snapshot
        try:
            from tools.browser_tool import browser_click, browser_type
        except ImportError as error:  # pragma: no cover
            browser_click = browser_type = None
            notes.append(f"browser_click/browser_type unavailable: {error}")
        try:
            from tools.browser_cdp_tool import browser_cdp
        except ImportError as error:  # pragma: no cover
            browser_cdp = None
            notes.append(f"browser_cdp unavailable: {error}")
        # `browser_cdp` speaks browser-level CDP, and `Runtime.evaluate` is a *page*
        # domain method that Chromium only accepts on an attached target session.
        # The bot's own console tool is the supported way to run JS in the page.
        try:
            from tools.browser_tool import browser_console
        except ImportError as error:  # pragma: no cover
            browser_console = None
            notes.append(f"browser_console unavailable: {error}")

        cookie = login(base)
        if os.environ.get("HOB_E2E_FOCUSED") == "1":
            assert all([browser_click, browser_type, browser_console, browser_cdp]), "All pinned native browser tools are required; no skipped contracts"
            phase_focused_tools(base, cookie, browser_navigate, browser_snapshot, browser_type, browser_click, browser_console, browser_cdp)
            return 0
        phase_browse(base, cookie, browser_navigate, browser_snapshot)
        if browser_click and browser_type:
            phase_type_and_click(base, cookie, browser_navigate, browser_snapshot, browser_type, browser_click)
        browser_navigate(SITE, task_id="e2e")
        diag("after the bot's own browsing", base, cookie)

        phase_watching(base, cookie)
        tab_before = phase_takeover(base, cookie, browser_navigate)
        phase_handback(base, cookie, browser_snapshot, browser_navigate, tab_before)

        phase_access_control(base, cookie)
        phase_ticket_security(base, cookie)
        phase_multi_viewer(base, cookie, browser_navigate)
        phase_multiple_bots(base, cookie, facts)

        stored = phase_store_session_state(browser_console) if browser_console else False
        if not browser_console:
            notes.append("browser_console unavailable; session-cookie persistence not exercised")
        phase_idle_and_restart(base, cookie, browser_navigate, facts["gatewayPort"])
        if stored:
            phase_check_session_state(browser_console, browser_navigate)
        phase_crash_recovery(base, cookie, browser_navigate, facts)
        phase_no_devtools_port(base, cookie, facts)
    finally:
        if os.environ.get("HOB_E2E_FOCUSED") == "1" and "tools.browser_tool" in sys.modules:
            try:
                from tools.browser_tool_lifecycle import cleanup_browser
                cleanup_browser("e2e")
            except Exception as error:
                info("Native fixture cleanup reported " + type(error).__name__)
        try:
            server.stdin.close()
        except Exception:  # pragma: no cover
            pass
        server.terminate()
        try:
            server.wait(timeout=30)
        except subprocess.TimeoutExpired:  # pragma: no cover
            server.kill()
        tail = server.stdout.read()[-2000:] if server.stdout else ""
        if tail.strip():
            info("harness server output tail:\n" + tail)

    print("\n== notes ==", flush=True)
    for note in notes:
        print(" -", note, flush=True)
    print(f"\n== {len(failures)} failure(s) ==", flush=True)
    for failure in failures:
        print(" -", failure, flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
