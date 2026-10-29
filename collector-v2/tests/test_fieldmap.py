import os
import unittest

from collector.fieldmap import apply_scale, load_map, translate_snapshot, validate_map

MAP = load_map()


class TestFieldMapStructure(unittest.TestCase):
    def test_validates_clean(self):
        self.assertEqual(validate_map(MAP), [])

    def test_version(self):
        self.assertEqual(MAP["version"], 1)

    def test_dnse_renames_enforced(self):
        stds = {s["standard"] for s in MAP["gates"]["dnse"]["fields"].values()}
        self.assertFalse(stds & {"last", "total_volume", "buy_value", "sell_value"})
        self.assertIn("day_low", stds)
        self.assertIn("atc_volume", stds)
        self.assertIn("buy_value_matched", stds)
        self.assertIn("sell_value_matched", stds)

    def test_disputed_fields_not_verified(self):
        dnse = MAP["gates"]["dnse"]["fields"]
        for raw in ("f13", "f22", "f58", "f59"):
            self.assertFalse(dnse[raw]["verified"], raw)

    def test_scales_from_spec(self):
        dnse = MAP["gates"]["dnse"]["fields"]
        self.assertEqual(dnse["f22"]["scale"], 10)
        self.assertEqual(dnse["f25"]["scale"], 1000000000)
        self.assertEqual(dnse["f58"]["scale"], 1000000000)
        self.assertEqual(dnse["f17"]["scale"], 10)
        vci = MAP["gates"]["vci"]["fields"]
        self.assertEqual(vci["accumulatedValue"]["scale"], 1000000)

    def test_measured_scales(self):
        dnse = MAP["gates"]["dnse"]["fields"]
        # Do tu parser collector thu (doc 08:14): f13 khong scale = nghin dong.
        self.assertEqual(dnse["f13"]["scale"], 1000)
        self.assertEqual(dnse["f10"]["scale"], 10)
        with self.assertRaises(ValueError):
            apply_scale(55.0, None)

    def test_translate_dnse_renames(self):
        fields, src = translate_snapshot(
            "dnse", {"last": 55.0, "total_volume": 1000, "total_value": 88000000}, MAP)
        self.assertEqual(fields["day_low"], 55.0)
        self.assertEqual(fields["atc_volume"], 1000)
        self.assertEqual(fields["total_value"], 88000000)
        self.assertNotIn("last", fields)
        self.assertNotIn("total_volume", fields)
        self.assertEqual(src["room"], "MISSING")
        self.assertEqual(src["day_low"], "dnse")

    def test_translate_kbs_keeps_names(self):
        fields, src = translate_snapshot(
            "kbs", {"last": 42.35, "total_volume": 5683700}, MAP)
        self.assertEqual(fields["last"], 42.35)
        self.assertEqual(fields["total_volume"], 5683700)
        self.assertEqual(src["last"], "kbs")

    def test_ssi_foreign_never_in_best_gate_map(self):
        ssi = MAP["gates"]["ssi"]["fields"]
        self.assertEqual(ssi["buyForeignQtty"]["standard"], "buy_volume_ssi_partial")
        self.assertIn("KHONG vao map", ssi["buyForeignQtty"]["use"])


if __name__ == "__main__":
    unittest.main()
