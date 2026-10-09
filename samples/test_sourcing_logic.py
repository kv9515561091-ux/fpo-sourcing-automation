"""Tests for the sourcing pipeline's commercial logic.

The `.gs` files cannot be executed without Google's runtime, so the arithmetic
they depend on is mirrored in `generate_samples.py`. These tests pin the
behaviour that a wrong answer would actually cost money, and they cover the
places where Python and JavaScript disagree by default.

Run:
    python -m unittest discover -s samples -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_samples import (  # noqa: E402
    CONFIDENCE_FACTOR, MAX_COST_TO_RETAIL_PCT, MIN_GRADE_A_SHARE_PCT,
    TARGET_MARGIN_PCT, build_po_matrix, build_scorecard, clamp,
    cost_to_retail_pct, estimated_shelf_life_days, fpo_score, grade_index,
    implied_retail_price, make_responses, retail_reference, round_,
    saleable_quantity, sourcing_decision, to_number, weighted_average_price,
    week_start,
)
import random  # noqa: E402
from datetime import date  # noqa: E402


class TestNumberCoercion(unittest.TestCase):
    """A keypad field agent types thousands separators. They must be handled."""

    def test_parses_comma_separated(self):
        self.assertEqual(to_number("1,200"), 1200.0)

    def test_parses_with_spaces(self):
        self.assertEqual(to_number("  450.5 "), 450.5)

    def test_blank_is_none_not_zero(self):
        # A zero harvest and a missing harvest imply opposite decisions:
        # one means do not order, the other means ask again.
        self.assertIsNone(to_number(""))
        self.assertIsNone(to_number(None))
        self.assertIsNone(to_number("   "))

    def test_garbage_is_none(self):
        self.assertIsNone(to_number("about two hundred"))
        self.assertIsNone(to_number("n/a"))


class TestRounding(unittest.TestCase):
    """Python rounds half-to-even; JavaScript rounds half-away-from-zero.

    A half-rupee difference per line is a real reconciliation gap between
    the two implementations, so it is handled explicitly.
    """

    def test_half_rounds_away_from_zero_positive(self):
        self.assertEqual(round_(0.5), 1.0)
        self.assertEqual(round_(1.5), 2.0)
        self.assertEqual(round_(2.5), 3.0)

    def test_half_rounds_away_from_zero_negative(self):
        self.assertEqual(round_(-0.5), -1.0)
        self.assertEqual(round_(-1.5), -2.0)

    def test_decimals(self):
        self.assertEqual(round_(1.23456, 2), 1.23)
        self.assertEqual(round_(1.23556, 2), 1.24)


class TestGradeIndex(unittest.TestCase):
    def test_all_grade_a_is_full_yield(self):
        self.assertAlmostEqual(grade_index(100, 0, 0), 1.0)

    def test_all_grade_c_is_heavily_discounted(self):
        # 100% Grade C has a mean of 1.0 on the share scale but a saleable
        # yield of 0.45. This is the case a naive mean gets wrong.
        self.assertAlmostEqual(grade_index(0, 0, 100), 0.45)

    def test_mixed_is_weighted_not_averaged(self):
        # 50/50 A and B -> 0.5*1.0 + 0.5*0.75 = 0.875
        self.assertAlmostEqual(grade_index(50, 50, 0), 0.875)

    def test_never_exceeds_one(self):
        """Over-reporting grade shares must not produce a superhuman FPO."""
        for a, b, c in [(120, 0, 0), (60, 60, 60), (100, 100, 100)]:
            self.assertLessEqual(grade_index(a, b, c), 1.0)

    def test_never_negative(self):
        self.assertGreaterEqual(grade_index(-20, -10, 0), 0.0)


class TestSaleableQuantity(unittest.TestCase):
    def test_applies_all_three_haircuts(self):
        # 1000 kg, all Grade A, high confidence, 5% field loss
        # -> 1000 * 1.00 * 1.00 * 0.95 = 950
        qty = saleable_quantity(1000, "Root Vegetables", 1.0, "High", 5.0)
        self.assertAlmostEqual(qty, 950.0)

    def test_low_confidence_reduces_further(self):
        high = saleable_quantity(1000, "Root Vegetables", 1.0, "High", 5.0)
        low = saleable_quantity(1000, "Root Vegetables", 1.0, "Low", 5.0)
        self.assertLess(low, high)
        self.assertAlmostEqual(low, 1000 * CONFIDENCE_FACTOR["Low"] * 0.95)

    def test_zero_or_missing_harvest_yields_zero(self):
        self.assertEqual(saleable_quantity(0, "Onion", 1.0, "High", None), 0.0)
        self.assertEqual(saleable_quantity(None, "Onion", 1.0, "High", None), 0.0)

    def test_measured_loss_overrides_commodity_default(self):
        # A leafy default of 10% loss should lose to an agent's measured 2%.
        measured = saleable_quantity(1000, "Leafy Greens", 1.0, "High", 2.0)
        default = saleable_quantity(1000, "Leafy Greens", 1.0, "High", None)
        self.assertGreater(measured, default)

    def test_loss_is_capped(self):
        """A 400% field loss must not produce a negative order."""
        qty = saleable_quantity(1000, "Leafy Greens", 1.0, "High", 400.0)
        self.assertGreaterEqual(qty, 0.0)


class TestMarginMath(unittest.TestCase):
    def test_retail_inverts_the_target_margin(self):
        cost = 30.0
        retail = implied_retail_price(cost, TARGET_MARGIN_PCT)
        # margin = (retail - cost) / retail must equal the target
        margin = 100 * (retail - cost) / retail
        self.assertAlmostEqual(margin, TARGET_MARGIN_PCT, places=2)

    def test_cost_to_retail_is_the_inverse_view(self):
        cost, retail = 30.0, 50.0
        self.assertAlmostEqual(cost_to_retail_pct(cost, retail), 60.0)

    def test_zero_inputs_return_none(self):
        self.assertIsNone(cost_to_retail_pct(0, 50))
        self.assertIsNone(cost_to_retail_pct(30, 0))


class TestWeightedPrice(unittest.TestCase):
    def test_weighted_not_simple_average(self):
        # 1000 kg at Rs 10 = 10,000; 100 kg at Rs 50 = 5,000.
        # 15,000 / 1,100 = 13.64, not the simple mean of 30.
        wap = weighted_average_price([(1000, 10), (100, 50)])
        self.assertAlmostEqual(wap, 13.64, places=2)

    def test_skips_null_prices(self):
        wap = weighted_average_price([(100, 20), (100, None)])
        self.assertAlmostEqual(wap, 20.0)

    def test_no_valid_pairs_returns_none(self):
        self.assertIsNone(weighted_average_price([(0, 20), (100, None)]))


class TestShelfLifeAndScheduling(unittest.TestCase):
    def test_distance_shortens_life(self):
        near = estimated_shelf_life_days("Leafy Greens", 10)
        far = estimated_shelf_life_days("Leafy Greens", 200)
        self.assertLess(far, near)

    def test_never_below_one_day(self):
        self.assertGreaterEqual(estimated_shelf_life_days("Leafy Greens", 9000), 1)

    def test_unknown_commodity_falls_back(self):
        self.assertEqual(estimated_shelf_life_days("Unlisted", 0), 7)


class TestRetailReferenceIsIndependent(unittest.TestCase):
    """The margin test must not grade the FPO's own quote against itself."""

    def test_derived_from_mandi_not_from_the_quote(self):
        reference = retail_reference("Brinjal & Cucurbit", 24.0)
        self.assertIsNotNone(reference)
        self.assertGreater(reference, 24.0)

    def test_falls_back_to_benchmark_when_no_mandi_rate(self):
        self.assertEqual(retail_reference("Potato", None), round_(12.00 * 1.55, 2))

    def test_leafy_gets_a_wider_spread_than_bulbs(self):
        leafy = retail_reference("Leafy Greens", 20.0)
        bulb = retail_reference("Bulb & Stem", 20.0)
        self.assertGreater(leafy / 20.0, bulb / 20.0)


class TestSourcingDecision(unittest.TestCase):
    def test_not_ready_is_deferred_not_rejected(self):
        d = sourcing_decision(["NOT HARVEST-READY"], 0.0, 60.0)
        self.assertTrue(d.startswith("DEFER"))

    def test_margin_breach_rejects(self):
        d = sourcing_decision(["MARGIN BREACH (80.0% cost-to-retail)"], 500.0, 80.0)
        self.assertTrue(d.startswith("REJECT"))

    def test_quality_problem_forces_a_trial_not_a_rejection(self):
        """A low grade is a remediable problem; a low grade should not
        disqualify an FPO outright, it should reduce the commitment."""
        d = sourcing_decision(["LOW GRADE-A (40.0%) — agronomy visit"], 500.0, 65.0)
        self.assertTrue(d.startswith("CONDITIONAL"))
        self.assertIn("trial", d)

    def test_clean_line_approves(self):
        self.assertEqual(sourcing_decision([], 1000.0, 62.0), "APPROVE")

    def test_price_and_crate_risk_together(self):
        d = sourcing_decision(["PRICE ABOVE MANDI (+15.0%) — renegotiate",
                               "CRATE DEPENDENT (2/2 responses)"], 800.0, 66.0)
        self.assertIn("price and crate risk", d)

    def test_thin_margin_needs_negotiation(self):
        d = sourcing_decision([], 800.0, MAX_COST_TO_RETAIL_PCT - 2)
        self.assertIn("negotiate", d)


class TestWeekStart(unittest.TestCase):
    def test_monday_stays_monday(self):
        self.assertEqual(week_start(date(2026, 10, 5)), date(2026, 10, 5))

    def test_sunday_rolls_back_to_monday(self):
        # Python weekday(): Monday=0, Sunday=6. Sunday must map to the
        # *previous* Monday, which is what a naive weekday() call gets wrong.
        self.assertEqual(week_start(date(2026, 10, 11)), date(2026, 10, 5))

    def test_saturday(self):
        self.assertEqual(week_start(date(2026, 10, 10)), date(2026, 10, 5))


class TestAggregation(unittest.TestCase):
    """End-to-end on the sample field: does the grain come out right?"""

    @classmethod
    def setUpClass(cls):
        rng = random.Random(20261012)
        cls.records = make_responses(rng)
        cls.matrix = build_po_matrix(cls.records)
        cls.scorecard = build_scorecard(cls.records)

    def test_matrix_grain_is_week_commodity_fpo(self):
        keys = {(r["iso_week_start"], r["commodity"], r["fpo_id"]) for r in self.matrix}
        self.assertEqual(len(keys), len(self.matrix),
                         "matrix must have one row per week x commodity x FPO")

    def test_feasible_never_exceeds_grade_adjusted(self):
        for r in self.matrix:
            self.assertLessEqual(r["feasible_qty_kg"], r["grade_adjusted_kg"] + 0.05)

    def test_every_line_carries_a_decision(self):
        for r in self.matrix:
            self.assertTrue(r["sourcing_decision"].strip())
            self.assertRegex(r["sourcing_decision"],
                             r"^(APPROVE|CONDITIONAL|REJECT|DEFER)")

    def test_deferred_lines_have_zero_volume(self):
        for r in self.matrix:
            if r["sourcing_decision"].startswith("DEFER"):
                self.assertEqual(r["feasible_qty_kg"], 0.0)

    def test_po_value_matches_qty_times_price(self):
        for r in self.matrix:
            if r["weighted_price_inr_kg"] == "":
                continue
            expected = r["feasible_qty_kg"] * r["weighted_price_inr_kg"]
            self.assertAlmostEqual(r["po_value_inr"], round_(expected, 2), places=1)

    def test_scorecard_covers_every_fpo(self):
        self.assertEqual({r["fpo_id"] for r in self.scorecard},
                         {r["fpo_id"] for r in self.records})

    def test_scorecard_is_ranked_and_bounded(self):
        scores = [r["fpo_score"] for r in self.scorecard]
        self.assertEqual(scores, sorted(scores, reverse=True))
        for s in scores:
            self.assertGreaterEqual(s, 0.0)
            self.assertLessEqual(s, 100.0)

    def test_grade_a_threshold_actually_separates(self):
        """If the threshold fired on nearly every line it would be useless."""
        flagged = sum(1 for r in self.matrix if "LOW GRADE-A" in r["risk_flags"])
        self.assertLess(flagged / len(self.matrix), 0.5,
                        "quality threshold is firing on too many lines")
        self.assertGreater(flagged, 0, "quality threshold never fires at all")

    def test_decisions_are_a_mix_not_uniform(self):
        kinds = {r["sourcing_decision"].split(" ")[0] for r in self.matrix}
        self.assertGreaterEqual(len(kinds), 3,
                                "decision logic is collapsing to one verdict")

    def test_score_responds_monotonically_to_grade(self):
        """Holding everything else fixed, a better Grade-A share must score
        higher. Tested directly on the scoring function because the composite
        score legitimately lets a cheap-but-inconsistent FPO outscore a
        consistent-but-dear one -- asserting a specific FPO ranking would
        encode that accident as a requirement."""
        low = fpo_score(40, 4, 60, 50, 8)
        mid = fpo_score(58, 4, 60, 50, 8)
        high = fpo_score(76, 4, 60, 50, 8)
        self.assertLess(low, mid)
        self.assertLess(mid, high)

    def test_score_responds_to_post_harvest_loss(self):
        low_loss = fpo_score(70, 3, 80, 70, 5)
        high_loss = fpo_score(70, 14, 80, 70, 5)
        self.assertLess(high_loss, low_loss)

    def test_tiers_span_more_than_one_band(self):
        """A scorecard that puts everyone in one tier is not a scorecard."""
        tiers = {r["tier"].split(" ")[0] for r in self.scorecard}
        self.assertGreaterEqual(len(tiers), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
