import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("bridge_init", Path(__file__).resolve().parents[1] / "image/init/20-openclaw-mcp-bridge.py")
init = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init)


class InitializationTests(unittest.TestCase):
    def test_csv_is_validated_trimmed_and_deduplicated(self):
        config = {"agents": {"entries": {"carassistant": {}, "seo": {}}}}
        self.assertEqual(init.selected_agents(" carassistant,seo,carassistant ", config), ["carassistant", "seo"])
        with self.assertRaises(ValueError):
            init.selected_agents("unknown", config)
        with self.assertRaises(ValueError):
            init.selected_agents("*", config)

    def test_updates_only_agent_ids_through_native_config_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "openclaw.json"
            config = {"agents": {"entries": {"carassistant": {}}}, "gateway": {"port": 18789},
                      "plugins": {"entries": {init.PLUGIN: {"enabled": True, "config": {"credentials": {"other": "preserved"}}}}}}
            path.write_text(json.dumps(config))
            calls = []
            self.assertTrue(init.configure({"OPENCLAW_CONFIG": str(path), init.VARIABLE: "carassistant"},
                                           runner=lambda args, **kwargs: calls.append((args, kwargs))))
            self.assertEqual(calls[0][0], ["openclaw", "config", "set", f"plugins.entries.{init.PLUGIN}.config.agentIds", '["carassistant"]', "--strict-json"])
            self.assertEqual(json.loads(path.read_text()), config)
            self.assertEqual(calls[0][1]["env"]["OPENCLAW_CONFIG_PATH"], str(path))

    def test_absent_variable_does_not_touch_managed_configuration(self):
        self.assertFalse(init.configure({}))

    def test_blank_clears_selection_and_repeated_init_is_a_noop(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "openclaw.json"
            cfg = {"agents": {"entries": {"carassistant": {}}}, "plugins": {"entries": {init.PLUGIN: {"config": {"agentIds": ["carassistant"]}}}}}
            path.write_text(json.dumps(cfg))
            calls = []
            env = {"OPENCLAW_CONFIG": str(path), init.VARIABLE: ""}
            self.assertTrue(init.configure(env, runner=lambda args, **kwargs: calls.append(args)))
            self.assertEqual(calls[0][-2], "[]")
            cfg["plugins"]["entries"][init.PLUGIN]["config"]["agentIds"] = []
            path.write_text(json.dumps(cfg))
            self.assertFalse(init.configure(env, runner=lambda *_a, **_kw: self.fail("unexpected write")))


if __name__ == "__main__":
    unittest.main()
