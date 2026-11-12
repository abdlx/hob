import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


coordinator = load('hob_coordinator', 'hob-coordinator.py')
installer = load('hob_coordinator_installer', 'apply-hermes-coordinator.py')


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        finite = types.ModuleType('gateway.session_finite')
        finite.finite_turn_required = Mock(return_value=False)
        agent = types.ModuleType('agent')
        agent.hob_coordinator = coordinator
        self.finite = finite
        self.modules = patch.dict(sys.modules, {'gateway.session_finite': finite, 'agent': agent})
        self.modules.start(); self.addCleanup(self.modules.stop)
        self.env = patch.dict(os.environ, HERMES_HOB_COORDINATOR='1')
        self.env.start(); self.addCleanup(self.env.stop)
        self.parent = types.SimpleNamespace(_delegate_depth=0)
        self.child = types.SimpleNamespace(_delegate_depth=1)

    def test_only_interactive_parent_is_coordinator(self):
        self.assertTrue(coordinator.enabled(self.parent))
        self.assertFalse(coordinator.enabled(self.child))
        self.finite.finite_turn_required.return_value = None
        self.assertFalse(coordinator.enabled(self.parent))
        self.finite.finite_turn_required.return_value = True
        self.assertFalse(coordinator.enabled(self.parent))
        os.environ['HERMES_HOB_COORDINATOR'] = '0'
        self.assertFalse(coordinator.enabled(self.parent))

    def test_direct_execution_blocked_but_controls_and_workers_work(self):
        for tool in ('terminal', 'execute_code', 'read_file', 'browser', 'mcp_external', 'skill_manage'):
            self.assertIn('delegate', coordinator.tool_block(self.parent, tool))
            self.assertIsNone(coordinator.tool_block(self.child, tool))
        for tool in ('delegate_task', 'todo', 'clarify', 'tool_search'):
            self.assertIsNone(coordinator.tool_block(self.parent, tool))

    def test_prompt_is_parent_only_and_idempotent(self):
        value = coordinator.prompt(self.parent, 'Original role')
        self.assertIn('END YOUR TURN', value)
        self.assertTrue(value.endswith('Original role'))
        self.assertEqual(coordinator.prompt(self.parent, value), value)
        self.assertEqual(coordinator.prompt(self.child, 'Worker role'), 'Worker role')

    def test_restored_existing_prompt_gets_policy_without_changing_history(self):
        original = ['existing private user message']
        agent = types.SimpleNamespace(_delegate_depth=0, messages=original)
        @coordinator.restore_prompt
        def restore(owner):
            owner._cached_system_prompt = 'Existing identity and history'
            owner._cached_system_prompt_static = 'Existing identity'
        restore(agent)
        self.assertTrue(agent._cached_system_prompt.startswith(coordinator.INSTRUCTIONS))
        self.assertTrue(agent._cached_system_prompt.startswith(agent._cached_system_prompt_static))
        self.assertIs(agent.messages, original)
        self.assertEqual(agent.messages, ['existing private user message'])

    def revised(self):
        root = os.environ.get('HOB_QUALIFIED_RUNTIME')
        if not root:
            self.skipTest('Exact pinned source checkout not supplied')
        return installer.revisions({name: (Path(root) / name).read_text(encoding='utf-8') for name in installer.SOURCES})

    def function(self, source, name, namespace):
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), node], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), '<qualified-native-hook>', 'exec'), namespace)
        return namespace[name]

    def test_actual_native_dispatch_blocks_before_side_effect_and_releases_start_gate(self):
        source = self.revised()['agent/tool_executor.py']
        blocked = Mock(return_value='blocked')
        execute, advance = Mock(), Mock()
        namespace = {'_blocked_tool_result': blocked}
        dispatch = self.function(source, '_dispatch_authorized_once', namespace)
        state = types.SimpleNamespace(blocked=False)
        ref = types.SimpleNamespace(name='terminal', args={})
        result = dispatch(self.parent, state, ref, execute=execute, scope_block=None,
                          display_index=None, begin_execution=advance, authorization_gate=None)
        self.assertEqual(result, 'blocked'); self.assertTrue(state.blocked)
        execute.assert_not_called(); advance.assert_called_once_with(None)
        self.assertIn('delegate', blocked.call_args.kwargs['block_body']['error'])

    def test_actual_native_dispatch_forces_background_only_for_parent(self):
        source = self.revised()['tools/delegate_tool_dispatch.py']
        background, foreground = Mock(return_value='background'), Mock(return_value={})
        namespace = {'begin_delegation_run': Mock(), '_dispatch_background': background,
                     '_execute_and_aggregate': foreground, 'json': json}
        run = self.function(source, '_run_batch', namespace)
        batch = types.SimpleNamespace(parent_agent=self.parent, children=[], task_list=[])
        self.assertEqual(run(batch, False), 'background'); foreground.assert_not_called()
        batch.parent_agent = self.child
        run(batch, False); foreground.assert_called_once_with(batch)

    def test_native_capacity_fallback_never_executes_foreground(self):
        source = self.revised()['tools/delegate_tool_dispatch.py']
        execute = Mock(side_effect=AssertionError('must never execute'))
        run = self.function(source, '_run_sync_with_note', {'_execute_and_aggregate': execute, 'json': json})
        with patch.object(coordinator, 'refuse_inline', return_value='not-dispatched') as refused:
            batch = types.SimpleNamespace(parent_agent=self.parent)
            self.assertEqual(run(batch, 'at_capacity'), 'not-dispatched')
            refused.assert_called_once_with(batch, 'at_capacity')
        execute.assert_not_called()

    def test_installer_refuses_unknown_upstream_before_mutation(self):
        root = os.environ.get('HOB_QUALIFIED_RUNTIME')
        if not root:
            self.skipTest('Exact pinned source checkout not supplied')
        with tempfile.TemporaryDirectory(prefix='hob-coordinator-') as directory:
            target = Path(directory)
            for relative in installer.SOURCES:
                dest = target / relative; dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((Path(root) / relative).read_bytes())
            changed = target / 'tools/delegate_tool_dispatch.py'
            changed.write_bytes(changed.read_bytes() + b'\n# unreviewed upstream change\n')
            original = (target / 'agent/tool_executor.py').read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                installer.install(target)
            self.assertEqual((target / 'agent/tool_executor.py').read_bytes(), original)
            self.assertFalse((target / 'agent/hob_coordinator.py').exists())


if __name__ == '__main__':
    unittest.main()
