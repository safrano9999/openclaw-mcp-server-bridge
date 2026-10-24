import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("bridge_init", Path(__file__).resolve().parents[1] / "image/init/20-openclaw-mcp-bridge.py")
init = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init)


class InitializationTests(unittest.TestCase):
    def test_pairs_skip_unknown_agents_and_missing_values(self):
        config = {"agents": {"entries": {"carassistant": {}, "seo": {}, "mail": {}}}}
        env = {
            "OPENCLAW_MCP_BRIDGE_AGENT": " carassistant ", "OPENCLAW_MCP_BRIDGE_BEARER": "a" * 64,
            "OPENCLAW_MCP_BRIDGE_AGENT_02": "missing", "OPENCLAW_MCP_BRIDGE_BEARER_02": "b" * 64,
            "OPENCLAW_MCP_BRIDGE_AGENT_03": "seo",
            "OPENCLAW_MCP_BRIDGE_BEARER_04": "c" * 64,
            "OPENCLAW_MCP_BRIDGE_AGENT_10": "mail", "OPENCLAW_MCP_BRIDGE_BEARER_10": "d" * 64,
        }
        self.assertEqual(init.selected_pairs(env, config), (["carassistant", "mail"], {"carassistant": "a" * 64, "mail": "d" * 64}))

    def test_duplicate_agents_or_tokens_are_rejected_without_exposing_bearers(self):
        config = {"agents": {"entries": {"a": {}, "b": {}}}}
        env = {"OPENCLAW_MCP_BRIDGE_AGENT": "a", "OPENCLAW_MCP_BRIDGE_BEARER": "a" * 64,
               "OPENCLAW_MCP_BRIDGE_AGENT_02": "b", "OPENCLAW_MCP_BRIDGE_BEARER_02": "a" * 64}
        with self.assertRaisesRegex(ValueError, "must be unique"):
            init.selected_pairs(env, config)
        env["OPENCLAW_MCP_BRIDGE_AGENT_02"] = "a"
        env["OPENCLAW_MCP_BRIDGE_BEARER_02"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "must be unique"):
            init.selected_pairs(env, config)

    def test_invalid_bearer_is_not_echoed(self):
        with self.assertRaisesRegex(ValueError, "invalid agent or bearer") as caught:
            init.selected_pairs({"OPENCLAW_MCP_BRIDGE_AGENT": "a", "OPENCLAW_MCP_BRIDGE_BEARER": "bad secret"},
                                {"agents": {"entries": {"a": {}}}})
        self.assertNotIn("bad secret", str(caught.exception))

    def test_native_atomic_batch_replaces_pairs_and_preserves_other_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "openclaw.json"
            config = {"agents": {"entries": {"carassistant": {}}}, "gateway": {"port": 18789},
                      "plugins": {"entries": {init.PLUGIN: {"enabled": True, "config": {
                          "agentIds": ["old"], "credentials": {"old": "b" * 64}, "allowedOrigins": ["https://example.com"]}}}}}
            path.write_text(json.dumps(config))
            calls = []
            def runner(args, **kwargs):
                self.assertEqual(args[:4], ["openclaw", "config", "set", "--batch-file"])
                batch = Path(args[4])
                self.assertEqual(batch.stat().st_mode & 0o777, 0o600)
                calls.append((args, json.loads(batch.read_text()), kwargs))
            env = {"OPENCLAW_CONFIG": str(path), "OPENCLAW_MCP_BRIDGE_AGENT": "carassistant", "OPENCLAW_MCP_BRIDGE_BEARER": "a" * 64}
            self.assertTrue(init.configure(env, runner=runner))
            args, operations, kwargs = calls[0]
            expected = {"agentIds": ["carassistant"], "credentials": {"carassistant": "a" * 64}, "allowedOrigins": ["https://example.com"]}
            self.assertEqual(operations, [{"path": f"plugins.entries.{init.PLUGIN}.config", "value": expected}])
            self.assertFalse(Path(args[4]).exists())
            self.assertEqual(json.loads(path.read_text()), config)
            self.assertEqual(kwargs["env"]["OPENCLAW_CONFIG_PATH"], str(path))
            config["plugins"]["entries"][init.PLUGIN]["config"] = expected
            path.write_text(json.dumps(config))
            self.assertFalse(init.configure(env, runner=lambda *_a, **_kw: self.fail("unexpected write")))

    def test_absent_pairs_leave_manual_configuration_untouched(self):
        self.assertFalse(init.configure({}))

    def test_empty_pairs_clear_old_selection_and_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "openclaw.json"
            config = {"agents": {"entries": {"carassistant": {}}}, "plugins": {"entries": {init.PLUGIN: {"config": {
                "agentIds": ["carassistant"], "credentials": {"carassistant": "a" * 64}}}}}}
            path.write_text(json.dumps(config))
            def runner(args, **kwargs):
                self.assertEqual(json.loads(Path(args[4]).read_text())[0]["value"], {"agentIds": [], "credentials": {}})
            self.assertTrue(init.configure({"OPENCLAW_CONFIG": str(path), "OPENCLAW_MCP_BRIDGE_AGENT": ""}, runner=runner))


if __name__ == "__main__":
    unittest.main()
