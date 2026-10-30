"""Real HTTP-boundary tests; no request leaves the loopback fixture server."""
import asyncio
import ast
import __future__
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

import httpx


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


context = load("team_context", "hob-team-context.py")
package = types.ModuleType("agent")
package.hob_team_context = context
with patch.dict(sys.modules, {"agent": package}):
    execution = load("team_execution", "hob-team-execution.py")


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="hob-team-execution-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "native" / "writer"
        self.home.mkdir(parents=True)
        self.db = sqlite3.connect(self.root / "employee-team.sqlite")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_profiles(profile TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE runtime_sessions(profile TEXT,session TEXT,kind TEXT,assignment TEXT);
            CREATE TABLE core_versions(revision INTEGER,content TEXT,digest TEXT);
            CREATE TABLE execution_routes(id TEXT PRIMARY KEY,profile TEXT,value TEXT,created INTEGER,revoked INTEGER);
        """)
        self.policy = {"nativeContext": True, "paidExecution": False, "allowSubscriptions": True}
        self.db.execute("INSERT INTO settings VALUES(1,?)", (json.dumps(self.policy),))
        self.db.execute("INSERT INTO runtime_profiles VALUES('writer',?)", (json.dumps({"home": str(self.home)}),))
        self.db.execute("INSERT INTO runtime_sessions VALUES('writer','session','user','')")
        self.db.commit()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HERMES_HOB_TEAM_STATE_DB": str(self.root / "employee-team.sqlite")}).start()
        patch.object(context, "_home", return_value=self.home).start()
        patch.object(context, "_room", return_value=None).start()
        self.agent = types.SimpleNamespace(session_id="session", api_mode="chat_completions", provider="fixture")
        self.observed = []
        observed = self.observed
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                observed.append({"path": self.path, "model": body.get("model")})
                data = json.dumps({"id": "fixture", "object": "chat.completion", "created": 1, "model": body["model"],
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixture answer"}, "finish_reason": "stop"}]}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}/v1/chat/completions"
        self.scope = execution._scope(self.agent)

    def approve(self, *, endpoint=None, token=None, model="included-model", billing="local"):
        credentials = {"authorization": "Bearer " + token} if token else {}
        fingerprint = hashlib.sha256(json.dumps(credentials, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        receipt = {"endpoint": endpoint or self.endpoint, "models": [model], "billingMode": billing,
                   "credentialDigest": fingerprint, "confirmNoUsageCharges": True}
        self.db.execute("INSERT INTO execution_routes VALUES(?,?,?,?,NULL)", (str(self.db.total_changes), "writer", json.dumps(receipt), 1))
        self.db.commit()

    def test_sync_guard_blocks_unreviewed_models_credentials_features_and_fallbacks_before_wire(self):
        with httpx.Client(trust_env=False) as client:
            wrapped = types.SimpleNamespace(_client=client)
            self.assertIs(execution.guard_client(wrapped, self.scope), wrapped)
            self.assertIs(execution.guard_client(wrapped, self.scope), wrapped)
            self.assertEqual(len(client.event_hooks["request"]), 1)
            with self.assertRaisesRegex(context.TeamContextError, "credential SHA-256"):
                client.post(self.endpoint, json={"model": "included-model"})
            self.assertEqual(self.observed, [])
            self.approve()
            self.assertEqual(client.post(self.endpoint, json={"model": "included-model"}).status_code, 200)
            for body in ({"model": "paid-model"}, {"model": "included-model", "models": ["paid-model"]},
                         {"model": "included-model", "plugins": [{"id": "web"}]}, {"model": "included-model", "tools": [{"type": "web_search"}]},
                         {"model": "included-model", "service_tier": "priority"}, {"model": "included-model", "preset": "paid-default"}):
                with self.assertRaises(context.TeamContextError):
                    client.post(self.endpoint, json=body)
            with self.assertRaises(context.TeamContextError):
                client.post(self.endpoint, json={"model": "included-model"}, headers={"Authorization": "Bearer changed-account"})
            with self.assertRaises(context.TeamContextError):
                client.post(self.endpoint, json={"model": "included-model"}, headers={"OpenAI-Project": "another-billing-project"})
            with self.assertRaises(context.TeamContextError):
                client.post(self.endpoint + "?override=1", json={"model": "included-model"})
            with self.assertRaisesRegex(context.TeamContextError, "payload"):
                client.post(self.endpoint, content=b'{"model":"paid-model","model":"included-model"}')
            self.assertEqual(len(self.observed), 1)
            client.post(self.endpoint, json={"model": "included-model", "tools": [{"type": "function", "function": {"name": "read_file"}}]})
            self.assertEqual(len(self.observed), 2)
            late = lambda request: None
            client.event_hooks["request"].append(late)
            with self.assertRaisesRegex(context.TeamContextError, "reordered"):
                client.post(self.endpoint, json={"model": "included-model"})
            with self.assertRaisesRegex(context.TeamContextError, "removed or reordered"):
                execution.guard_client(wrapped, self.scope)
            client.event_hooks["request"].remove(late)
            self.db.execute("UPDATE execution_routes SET revoked=2"); self.db.commit()
            with self.assertRaises(context.TeamContextError):
                client.post(self.endpoint, json={"model": "included-model"})
            self.assertEqual(len(self.observed), 2)

    def test_async_and_cached_clients_recheck_authority_and_do_not_cross_profiles(self):
        self.approve(token="synthetic")
        @execution.client_factory(agent_arg=True)
        def cached(agent, client):
            return types.SimpleNamespace(_real_client=types.SimpleNamespace(_client=client)), "included-model"
        async def run():
            async with httpx.AsyncClient(trust_env=False) as client:
                cached(self.agent, client)
                await client.post(self.endpoint, json={"model": "included-model"}, headers={"Authorization": "Bearer synthetic"})
                with self.assertRaisesRegex(context.TeamContextError, "across bot profiles"):
                    execution.guard_client(types.SimpleNamespace(_client=client), (self.scope[0], "another-bot", self.scope[2]))
                self.db.execute("DELETE FROM runtime_profiles"); self.db.commit()
                with self.assertRaisesRegex(context.TeamContextError, "unavailable or revoked"):
                    await client.post(self.endpoint, json={"model": "included-model"}, headers={"Authorization": "Bearer synthetic"})
        asyncio.run(run())
        self.assertEqual(len(self.observed), 1)

    def test_existing_native_request_hooks_cannot_replace_the_reviewed_model(self):
        self.approve()
        def replace(request):
            request._content = json.dumps({"model": "paid-model"}).encode()
            request.headers["content-length"] = str(len(request._content))
        with httpx.Client(trust_env=False, event_hooks={"request": [replace]}) as client:
            execution.guard_client(types.SimpleNamespace(_client=client), self.scope)
            with self.assertRaisesRegex(context.TeamContextError, "Unapproved model route"):
                client.post(self.endpoint, json={"model": "included-model"})
        self.assertEqual(self.observed, [])

    def test_unknown_transports_refused_and_ordinary_mode_does_not_change_clients(self):
        with self.assertRaisesRegex(context.TeamContextError, "qualified no-paid-lane"):
            execution.guard_client(object(), self.scope)
        self.agent.api_mode = "bedrock_converse"
        with self.assertRaisesRegex(context.TeamContextError, "qualified no-paid-lane"):
            execution.require_supported_transport(self.agent)
        self.policy["nativeContext"] = False
        self.db.execute("UPDATE settings SET value=?", (json.dumps(self.policy),)); self.db.commit()
        self.agent._hob_team_enabled = False
        client = object()
        self.assertIs(execution.client_factory()(lambda: client)(), client)
        execution.require_supported_transport(self.agent)
        with self.assertRaisesRegex(context.TeamContextError, "unavailable or revoked"):
            execution.check_request(self.scope, httpx.Request("POST", self.endpoint, json={"model": "included-model"}))

    def test_real_openai_sdk_uses_guarded_physical_http_client(self):
        try:
            from openai import OpenAI
        except ImportError:
            if os.environ.get("HOB_NATIVE_SDK_PROBE") == "1":
                raise
            self.skipTest("Pinned OpenAI SDK unavailable; mandatory in image CI")
        self.approve(token="synthetic")
        @execution.client_factory(agent_arg=True)
        def cached(agent, sdk):
            return sdk
        with OpenAI(api_key="synthetic", base_url=self.endpoint.removesuffix("/chat/completions"), max_retries=0,
                    http_client=httpx.Client(trust_env=False)) as sdk:
            if os.environ.get("HOB_QUALIFIED_RUNTIME"):
                # Execute the actual patched native cache-hit path. Cached
                # clients created before activation need the same guard as new
                # clients; checking constructors alone would leave this bypass.
                compat = load("team_compat", "apply-hermes-team-compat.py")
                root = Path(os.environ["HOB_QUALIFIED_RUNTIME"])
                source = {name: (root / name).read_text(encoding="utf-8") for name in compat.SOURCES}
                revised_sources = compat.revisions(source)
                revised = revised_sources["agent/client_lifecycle.py"]
                function = next(node for node in ast.walk(ast.parse(revised)) if isinstance(node, ast.FunctionDef) and node.name == "_create_request_openai_client")
                package.hob_team_execution = execution
                namespace = {"base_url_host_matches": lambda *args: False, "_OPENAI_SLOT": "slot"}
                self.agent._ensure_primary_openai_client = lambda **kwargs: sdk
                self.agent._openai_client_lock = threading.RLock
                self.agent._client_kwargs = {"base_url": str(sdk.base_url)}
                self.agent._checkout_request_slot = lambda *args: (sdk, None)
                with patch.dict(sys.modules, {"agent": package, "agent.hob_team_execution": execution}):
                    exec(compile(ast.Module(body=[function], type_ignores=[]), "qualified-client-lifecycle", "exec", flags=__future__.annotations.compiler_flag), namespace)
                self.assertIs(namespace["_create_request_openai_client"](self.agent, reason="fixture-cache-hit"), sdk)
            cached(self.agent, sdk)
            answer = sdk.chat.completions.create(model="included-model", messages=[{"role": "user", "content": "fixture"}])
            self.assertEqual(answer.choices[0].message.content, "fixture answer")
            self.db.execute("UPDATE execution_routes SET revoked=2"); self.db.commit()
            with self.assertRaises(Exception) as rejected:
                sdk.chat.completions.create(model="included-model", messages=[{"role": "user", "content": "refused before wire"}])
            cause = rejected.exception
            while cause is not None and not isinstance(cause, context.TeamContextError):
                cause = cause.__cause__
            self.assertIsInstance(cause, context.TeamContextError)
            if os.environ.get("HOB_QUALIFIED_RUNTIME"):
                revised_summary = revised_sources["agent/api_error_summary.py"]
                node = next(node for node in ast.walk(ast.parse(revised_summary)) if isinstance(node, ast.FunctionDef) and node.name == "_summarize_api_error")
                with patch.dict(sys.modules, {"agent": package, "agent.hob_team_context": context}):
                    exec(compile(ast.Module(body=[node], type_ignores=[]), "qualified-api-error-summary", "exec", flags=__future__.annotations.compiler_flag), namespace)
                    summary = namespace["_summarize_api_error"](rejected.exception)
                self.assertTrue(summary.startswith("Unapproved model route; credential SHA-256: "))
                self.assertLessEqual(len(summary), 150)
                self.assertIn(cause.args[0].split(": ")[-1], summary)
        self.assertEqual(len(self.observed), 1)


if __name__ == "__main__":
    unittest.main()
