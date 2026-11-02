
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bridge_init", Path(__file__).resolve().parents[1] / "image/init/20-openclaw-mcp-bridge.py")
init = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init)

class InitializationTests(unittest.TestCase):
    def run_init(self, previous, env):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "openclaw.json"
            path.write_text(json.dumps({"plugins":{"entries":{init.PLUGIN:{"config":previous}}}}))
            calls = []
            def runner(args, **kwargs):
                self.assertEqual(args[:4], ["openclaw","config","set","--batch-file"])
                batch = Path(args[4])
                self.assertEqual(batch.stat().st_mode & 0o777, 0o600)
                calls.append(json.loads(batch.read_text())[0]["value"])
            changed = init.configure({"OPENCLAW_CONFIG":str(path), **env}, runner)
            return changed, calls

    def test_migration_replaces_pairs_and_keeps_other_fields(self):
        old = {"agentIds":["old"],"credentials":{"old":"b"*64},"allowedOrigins":["https://example.com"]}
        changed, calls = self.run_init(old, {"OPENCLAW_MCP_BRIDGE_BEARER":"a"*64, "OPENCLAW_DEFAULT_CHANNEL":"telegram"})
        self.assertTrue(changed)
        self.assertEqual(calls,[{"bearer":"a"*64,"defaultChannel":"telegram","allowedOrigins":["https://example.com"]}])

    def test_migration_cannot_accidentally_remove_authentication(self):
        with self.assertRaisesRegex(ValueError,"Inject OPENCLAW_MCP_BRIDGE_BEARER"):
            self.run_init({"credentials":{"old":"a"*64}},{})

    def test_manual_config_and_idempotency(self):
        self.assertEqual(self.run_init({"bearer":"a"*64},{}),(False,[]))
        self.assertEqual(self.run_init({"bearer":"a"*64},{"OPENCLAW_MCP_BRIDGE_BEARER":"a"*64}),(False,[]))

    def test_empty_bearer_disables_auth_without_another_flag(self):
        self.assertEqual(self.run_init({"bearer":"a"*64},{"OPENCLAW_MCP_BRIDGE_BEARER":""})[1],[{"bearer":""}])

    def test_flags_and_validation_do_not_echo_secrets(self):
        self.assertEqual(self.run_init({},{"OPENCLAW_MCP_BRIDGE_DIRECT":"1","OPENCLAW_MCP_BRIDGE_DIRECT_FIFO":"true"})[1],[{"direct":True,"directFifo":True}])
        with self.assertRaisesRegex(ValueError,"Invalid OPENCLAW_MCP_BRIDGE_BEARER") as caught:
            self.run_init({},{"OPENCLAW_MCP_BRIDGE_BEARER":"bad secret"})
        self.assertNotIn("bad secret",str(caught.exception))
        with self.assertRaisesRegex(ValueError,"must be true or false"):
            self.run_init({},{"OPENCLAW_MCP_BRIDGE_DIRECT":"maybe"})

if __name__ == "__main__":
    unittest.main()
