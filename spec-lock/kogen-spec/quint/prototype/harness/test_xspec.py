#!/usr/bin/env python3
"""Regression tests for fail-closed xspec replay and adapter mutation handling."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


HARNESS = Path(__file__).with_name("xspec.py")
SPEC = importlib.util.spec_from_file_location("xspec_harness_under_test", HARNESS)
xspec = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(xspec)


class XspecFailClosedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="xspec-harness-test-")
        self.root = Path(self.tmp.name)
        self.slice = self.root / "slice"
        (self.slice / "scenarios").mkdir(parents=True)
        self.build = self.root / "build"
        self.golden = self.root / "golden"
        self.old = {
            "SLICE": xspec.SLICE,
            "BUILD": xspec.BUILD,
            "GOLD": xspec.GOLD,
            "CFG": xspec.CFG,
        }
        xspec.SLICE = str(self.slice)
        xspec.BUILD = str(self.build)
        xspec.GOLD = str(self.golden)
        xspec.CFG = {
            "spec": "spec/sample.qnt",
            "module": "sample",
            "invariant": "invariant",
            "fire": "fire",
            "init": "init",
            "obs_var": "obs",
            "ev_var": "ev",
            "coverage": [],
        }

    def tearDown(self):
        for name, value in self.old.items():
            setattr(xspec, name, value)
        self.tmp.cleanup()

    def write_scenario(self, name="final", steps=None):
        scenario = {"name": name, "steps": steps or [{"do": ["Tick"]}]}
        (self.slice / "scenarios" / f"{name}.json").write_text(json.dumps(scenario))

    def test_failing_final_assertion_does_not_publish_hand_golden(self):
        self.write_scenario()

        def quint_failed_final_assertion(command, **_kwargs):
            output = Path(command[command.index("--out-itf") + 1].replace("{test}", "s_finalTest"))
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"states": [{"obs": {"last": "ok"}}, {"obs": {"last": "broken"}}]}))
            return type("Result", (), {
                "returncode": 1,
                "stdout": "1) s_finalTest: invariant failed on the final expectation\n",
                "stderr": "",
            })()

        with mock.patch.object(xspec.subprocess, "run", side_effect=quint_failed_final_assertion):
            self.assertNotEqual(xspec.cmd_spec({}), 0)
        self.assertFalse((self.golden / "hand" / "final.json").exists())

    def test_empty_hand_corpus_is_rejected_without_starting_adapter(self):
        output = []
        with contextlib.redirect_stdout(_Capture(output)):
            status = xspec.cmd_conform({"--only": "hand"}, ["adapter-that-must-not-start"])
        self.assertEqual(status, 2)
        self.assertTrue(any("empty or missing" in line for line in output))

    def test_incomplete_generated_corpus_is_rejected_before_adapter_start(self):
        generated = self.golden / "gen"
        generated.mkdir(parents=True)
        (generated / "g0000.json").write_text(json.dumps({
            "name": "g0000", "source": "gen", "sets": [],
            "events": [], "obs": [{"last": "ok"}],
        }))
        (generated / "manifest.json").write_text(json.dumps({
            "source": "gen", "requested_traces": 2,
            "trace_names": ["g0000", "g0001"],
        }))
        output = []
        with contextlib.redirect_stdout(_Capture(output)):
            status = xspec.cmd_conform({"--only": "gen"}, ["adapter-that-must-not-start"])
        self.assertEqual(status, 2)
        self.assertTrue(any("does not match its complete manifest" in line for line in output))

    def test_requested_generation_count_must_match_emitted_traces(self):
        self.write_scenario()

        def quint_emits_one_of_two(command, **_kwargs):
            out = Path(command[command.index("--out-itf") + 1].replace("{seq}", "0"))
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps({"states": [{"ev": {}, "obs": {"last": "ok"}}]}))
            return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

        with mock.patch.object(xspec.subprocess, "run", side_effect=quint_emits_one_of_two):
            self.assertNotEqual(xspec.cmd_gen({"--traces": "2", "--steps": "1", "--seed": "17"}), 0)
        self.assertFalse((self.golden / "gen" / "manifest.json").exists())

    def test_deliberately_broken_adapter_is_caught_by_conform(self):
        self.write_scenario(name="mutation")
        hand = self.golden / "hand"
        hand.mkdir(parents=True)
        (hand / "mutation.json").write_text(json.dumps({
            "name": "mutation",
            "source": "hand",
            "sets": [],
            "events": [{"tag": "Tick"}],
            "obs": [{"last": "ok"}, {"last": "ok"}],
        }))
        broken = self.root / "broken-adapter"
        broken.write_text(
            "#!/bin/sh\nwhile IFS= read -r request; do printf '%s\\n' '{\"last\":\"mutated\"}'; done\n"
        )
        broken.chmod(0o755)
        output = []
        with contextlib.redirect_stdout(_Capture(output)):
            status = xspec.cmd_conform({"--only": "hand", "--show": "1"}, [str(broken)])
        self.assertEqual(status, 1)
        self.assertTrue(any('got "mutated"' in line for line in output))


class _Capture:
    def __init__(self, lines):
        self.lines = lines

    def write(self, value):
        self.lines.extend(value.splitlines())

    def flush(self):
        pass


if __name__ == "__main__":
    unittest.main()
