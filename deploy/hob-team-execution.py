"""Request-time enforcement for operator-reviewed, non-metered model routes.

The receipt records the operator's billing-contract review. It is not a price
oracle, spend ledger or a substitute for separate native tool/process isolation.
"""
from __future__ import annotations

from contextlib import closing
from functools import wraps
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import stat
import threading
from urllib.parse import urlsplit

from agent import hob_team_context as context

_lock = threading.RLock()
_MAX_BODY = 64 * 1024 * 1024
_MODEL_FIELDS = frozenset({
    "model", "models", "messages", "input", "instructions", "system", "tools", "tool_choice", "parallel_tool_calls",
    "stream", "stream_options", "max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "top_p", "top_k",
    "presence_penalty", "frequency_penalty", "stop", "stop_sequences", "seed", "response_format", "reasoning", "reasoning_effort",
    "thinking", "text", "verbosity", "logprobs", "top_logprobs", "logit_bias", "n", "store", "metadata", "user", "include",
    "prompt_cache_key", "prompt_cache_retention", "provider", "service_tier", "cache_control", "output_config",
})
_PROVIDER_FIELDS = frozenset({"order", "only", "ignore", "allow_fallbacks", "require_parameters", "data_collection", "zdr", "quantizations", "sort", "max_price"})


def _scope(agent):
    state = context._state(agent)
    if state is None:
        return None
    return (state["authority"], state["profile"], state["metadata"]["home"])


def _endpoint(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.hostname.endswith(".") or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or "%" in value or "\\" in value
            or any(part in (".", "..") for part in parsed.path.split("/"))):
        raise context.TeamContextError("Unqualified model endpoint.")
    port = parsed.port
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    suffix = "" if port is None or (parsed.scheme, port) in (("https", 443), ("http", 80)) else ":" + str(port)
    return parsed.scheme + "://" + host + suffix + parsed.path


def _receipts(scope):
    filename, profile, home = scope
    target = Path(filename)
    try:
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("invalid authority")
        with closing(sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.execute("BEGIN")
            settings = json.loads(db.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])
            if (settings.get("nativeContext") is not True or settings.get("paidExecution") is not False
                    or settings.get("allowSubscriptions") is not True):
                raise ValueError("unavailable policy")
            row = db.execute("SELECT value FROM runtime_profiles WHERE profile=?", (profile,)).fetchone()
            if not row or Path(json.loads(row[0])["home"]).resolve() != Path(home).resolve():
                raise ValueError("revoked profile")
            rows = db.execute("SELECT value FROM execution_routes WHERE profile=? AND revoked IS NULL LIMIT 129", (profile,)).fetchall()
            if len(rows) > 128:
                raise ValueError("unbounded routes")
            return [json.loads(row[0]) for row in rows]
    except Exception:
        raise context.TeamContextError("Non-metered execution authority is unavailable or revoked.") from None


def check_request(scope, request):
    """Called by httpx before every physical SDK request, including retries."""
    receipts = _receipts(scope)
    endpoint = _endpoint(str(request.url))
    if request.method != "POST":
        raise context.TeamContextError("Only reviewed model inference requests are qualified for team SDK clients.")
    try:
        raw = request.content
        if len(raw) > _MAX_BODY:
            raise ValueError("oversized body")
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate JSON key")
                value[key] = item
            return value
        body = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("invalid JSON constant")))
        if not isinstance(body, dict):
            raise ValueError("invalid body")
    except Exception:
        raise context.TeamContextError("Unqualified model request payload.") from None
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise context.TeamContextError("A concrete model is required by the no-paid-lane policy.")
    if set(body) - _MODEL_FIELDS:
        raise context.TeamContextError("Unqualified provider request fields are disabled by the no-paid-lane policy.")
    provider = body.get("provider") or {}
    if not isinstance(provider, dict) or set(provider) - _PROVIDER_FIELDS:
        raise context.TeamContextError("Unqualified provider routing overrides are disabled by the no-paid-lane policy.")
    credentials = {key: value for key, value in request.headers.items()
                   if re.search(r"auth|token|api[-_]?key|credential|subscription|account|organization|project", key, re.I)}
    credential_digest = hashlib.sha256(json.dumps(credentials, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    fallback = body.get("models", [])
    if not isinstance(fallback, list) or len(fallback) > 128 or any(not isinstance(value, str) for value in fallback):
        raise context.TeamContextError("Unqualified model fallback list.")
    # Remote plugins/server tools can carry their own charges, independently of
    # the selected model. Client function tools have separate execution owners.
    tools = body.get("tools") or []
    def client_tool(tool):
        if not isinstance(tool, dict):
            return False
        if tool.get("type") == "function":
            return True
        return (endpoint.endswith("/messages") and "type" not in tool
                and isinstance(tool.get("name"), str) and isinstance(tool.get("input_schema"), dict))
    if (not isinstance(tools, list) or any(not client_tool(tool) for tool in tools)
            or body.get("service_tier") not in (None, "default")):
        raise context.TeamContextError("Unqualified provider-side features are disabled by the no-paid-lane policy.")
    for receipt in receipts:
        if (receipt.get("endpoint") == endpoint and receipt.get("billingMode") in ("free", "local", "subscription")
                and receipt.get("confirmNoUsageCharges") is True and model in receipt.get("models", [])
                and receipt.get("credentialDigest") == credential_digest
                and all(value in receipt["models"] for value in fallback)):
            # The catalog variant itself must be free. Paid fallback SKUs remain
            # forbidden even if a caller supplies routing or provider overrides.
            host = urlsplit(endpoint).hostname
            if (host == "openrouter.ai" or host.endswith(".openrouter.ai")) and any(
                    value != "openrouter/free" and not value.endswith(":free") for value in [model, *fallback]):
                break
            return
    raise context.TeamContextError("Unapproved model route; credential SHA-256: " + credential_digest)


def guard_client(result, scope):
    if scope is None:
        return result
    import httpx
    pending = list(result) if isinstance(result, tuple) else [result]
    seen = set()
    transports = []
    candidates = False
    while pending:
        value = pending.pop()
        if value is None or isinstance(value, (str, int, float, bool)) or id(value) in seen:
            continue
        seen.add(id(value))
        candidates = True
        if isinstance(value, (httpx.Client, httpx.AsyncClient)):
            transports.append(value)
            continue
        if len(seen) > 16:
            raise context.TeamContextError("Unqualified model client wrapper.")
        for key in ("_client", "_real_client"):
            child = getattr(value, key, None)
            if child is not None:
                pending.append(child)
    if candidates and not transports:
        raise context.TeamContextError("This model transport has no qualified no-paid-lane guard.")
    with _lock:
        for transport in transports:
            existing = getattr(transport, "_hob_team_execution_scope", None)
            if existing is not None and existing != scope:
                raise context.TeamContextError("A guarded model client cannot be shared across bot profiles.")
            if existing is not None:
                if not transport.event_hooks["request"] or transport.event_hooks["request"][-1] is not getattr(transport, "_hob_team_execution_hook", None):
                    raise context.TeamContextError("The qualified model request guard was removed or reordered.")
                continue
            # Last request hook sees modifications made by existing native hooks.
            hook = _request_hook(transport, scope)
            transport.event_hooks["request"].append(hook)
            transport._hob_team_execution_scope = scope
            transport._hob_team_execution_hook = hook
    return result


def _request_hook(transport, scope):
    import httpx
    def check(request):
        if transport.event_hooks["request"][-1] is not transport._hob_team_execution_hook:
            raise context.TeamContextError("The qualified model request guard was reordered.")
        check_request(scope, request)
    async def check_async(request):
        check(request)
    return check_async if isinstance(transport, httpx.AsyncClient) else check


def client_factory(*, agent_arg=False):
    """Guard newly built AND cached clients at the native retrieval owners."""
    def decorate(function):
        @wraps(function)
        def guarded(*args, **kwargs):
            scope = _scope(args[0] if agent_arg else None)
            return guard_client(function(*args, **kwargs), scope)
        return guarded
    return decorate


def require_supported_transport(agent):
    if context._state(agent) is not None and (
            getattr(agent, "api_mode", "") not in ("chat_completions", "codex_responses", "anthropic_messages")
            or getattr(agent, "provider", "") == "moa"):
        raise context.TeamContextError("This transport has no qualified no-paid-lane guard.")
