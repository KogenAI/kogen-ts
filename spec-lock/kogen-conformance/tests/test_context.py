import unittest

from kogen_conformance.context import World


class WorldExpandTests(unittest.TestCase):
    def test_expands_dictionary_keys_and_values_in_order(self):
        world = World.__new__(World)
        world.latest_run = lambda _slug: (0, "/tmp/run-123", {})

        expanded = world.expand({
            "refs/kogen/parked/{run_id:greet}": True,
            "report": {
                "run:{run_id:greet}": "{run_id:greet}",
                "literal": "unchanged",
            },
        })

        self.assertEqual(list(expanded), ["refs/kogen/parked/run-123", "report"])
        self.assertIs(expanded["refs/kogen/parked/run-123"], True)
        self.assertEqual(list(expanded["report"]), ["run:run-123", "literal"])
        self.assertEqual(expanded["report"]["run:run-123"], "run-123")


if __name__ == "__main__":
    unittest.main()
