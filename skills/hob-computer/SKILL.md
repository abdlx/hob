# hob-computer

You have a bundled Linux computer with a real desktop browser. Use it whenever the user asks you to do something on a computer or in a browser — open a site, click, fill a form, take a screenshot, read or write files, or run a terminal command. Do not ask the user to do it themselves, and do not claim you cannot use a browser.

## What it is

- **The computer** is a persistent Linux desktop (the `hob_computer` MCP server). It has its own workspace, filesystem, terminal, and a Camoufox browser (Firefox-based, with a real profile).
- **The browser** is Camoufox. It can navigate, click, fill forms, read page content, take screenshots, and use saved credentials from the vault. It is a real browser, not a fetch.
- **The workspace** is the bot's HOB working directory. Files you write there persist. The computer and the bot share it.

## Tools (hob_computer MCP)

- **Lifecycle**: `computer_list`, `computer_status`, `computer_wake`, `computer_sleep` — list computers, check status, wake/sleep.
- **Browser**: `browser_navigate`, `browser_click`, `browser_fill`, `browser_read`, `browser_screenshot`, `browser_back`, `browser_forward`, `browser_tabs` — drive the Camoufox browser. Use `browser_navigate` to open a URL, `browser_click` / `browser_fill` to interact, `browser_read` to get page text, `browser_screenshot` to see the page.
- **Files**: `fs_list`, `fs_read`, `fs_write`, `fs_delete` — read and write files in the workspace.
- **Terminal**: `terminal_exec` — run a shell command in the computer's sandboxed terminal.
- **Credentials**: `credentials_read` — read a saved credential from the vault for a site (the browser uses it to sign in).
- **Batch**: `batch` — run several computer calls in one step.

## When to use it

- The user asks you to open, check, or do something on a website → use the browser (`browser_navigate`, then interact).
- The user asks you to do something on a computer (open an app, run a program, check a file) → use the computer tools.
- The user asks you to download, upload, or move a file → use `fs_*` and the browser.
- You need to see a page visually (layout, a CAPTCHA, a login form) → use `browser_screenshot`.

## Rules

- Prefer the computer's browser over fetching a page yourself: it handles logins, JavaScript, and interactive pages.
- Wake the computer first (`computer_wake`) if `computer_status` says it is asleep.
- Do not run destructive commands (`rm -rf`, formatting, mass deletes) without the user's explicit say.
- Never put credentials, tokens, or secrets in messages, files, or tool arguments outside the vault. Use `credentials_read` for sign-ins.
- If a computer tool fails with an auth error, say so plainly and stop — do not retry the same call in a loop.
