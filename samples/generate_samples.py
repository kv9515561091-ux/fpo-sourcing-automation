"""Generate the sample outputs for the FPO sourcing pipeline.

Apps Script only runs inside Google's runtime, which makes the commercial
logic in `src/*.gs` awkward to review and impossible to test in CI. This is a
line-for-line Python mirror of `Config.gs` + `Utils.gs` + `Aggregator.gs`,
written for exactly one purpose: so a reviewer can see what the pipeline
produces, and so the arithmetic in the .gs files is verifiable.

The same constants, the same order of operations, the same thresholds. Where
the two implementations could legitimately differ (median of an even-length
list, rounding), the Python side matches the JavaScript convention explicitly
rather than inheriting a language default.

Run:
    python samples/generate_samples.py
"""

from __future__ import annotations

import csv
import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Config.gs mirror
# ---------------------------------------------------------------------------

GRADE_YIELD = {"A": 1.00, "B": 0.75, "C": 0.45}

COMMODITY_LOSS_FACTOR = {
    "Leafy Greens": 0.10, "Herbs": 0.08, "Root Vegetables": 0.05,
    "Brinjal & Cucurbit": 0.07, "Bulb & Stem": 0.03, "Fruit": 0.06,
}

COMMODITY_SHELF_LIFE_DAYS = {
    "Leafy Greens": 2, "Herbs": 3, "Root Vegetables": 15,
    "Brinjal & Cucurbit": 8, "Bulb & Stem": 30, "Fruit": 7,
}

CONFIDENCE_FACTOR = {"High": 1.00, "Medium": 0.90, "Low": 0.75}

TARGET_MARGIN_PCT = 22.0
MAX_COST_TO_RETAIL_PCT = 74.0
MIN_GRADE_A_SHARE_PCT = 55.0
MAX_POST_HARVEST_LOSS_PCT = 8.0
MAX_PREMIUM_OVER_MANDI_PCT = 12.0

MANDI_BENCHMARK = {
    "Potato": 12.00, "Onion": 45.00, "Tomato": 30.95, "Tomato (Hybrid)": 30.95,
    "Carrot": 26.00, "Radish": 14.00, "Beetroot": 22.00, "Sweet Potato": 25.00,
    "Brinjal": 24.00, "Bottle Gourd": 19.00, "Bitter Gourd": 28.00,
    "Capsicum": 38.00, "Coriander": 20.00, "Spinach": 18.00, "Methi": 16.00,
    "Ginger": 24.00, "Garlic": 26.00, "Banana": 22.00, "Apple": 118.00,
    "Pomegranate": 95.00, "Pineapple": 42.00,
}

# Group-level mandi -> retail multiplier, used to build an *independent*
# retail reference so the margin test is not circular.
RETAIL_MULTIPLIER = {
    "Bulb & Stem": 1.22,
    "Leafy Greens": 2.10,
    "Herbs": 2.10,
    "Fruit": 1.95,
}

AGENTS = [
    ("Ramesh Gowda", "AG-101"), ("Sunita Bai", "AG-102"),
    ("Prakash Reddy", "AG-103"), ("Anitha Shetty", "AG-104"),
]

# (id, name, district, typical Grade-A %, distance to collection centre km)
#
# The Grade-A baselines span 58-76% because that is a realistic band for
# Indian FPO lots arriving ungraded at a rural collection centre, and it puts
# the 55% intervention threshold somewhere inside the distribution rather
# than flagging every line. A threshold that fires on 83% of lines is not a
# threshold, it is noise.
FPOS = [
    ("FPO-KOL-01", "Kolar Taluk Growers Union", "Kolar", 71, 62),
    ("FPO-CBK-02", "Chikkaballapur Women Farmers Collective", "Chikkaballapur", 76, 38),
    ("FPO-HSR-01", "Hosur Border Producers", "Krishnagiri", 58, 74),
    ("FPO-CMK-04", "Chikmagalur Smallholders Collective", "Chikmagalur", 64, 96),
    ("FPO-MYS-03", "Mysuru Organic Growers", "Mysuru", 73, 44),
    ("FPO-TUM-02", "Tumkur Ridgeline Farmers", "Tumkur", 66, 71),
    ("FPO-MDY-01", "Mandya Rafti Growers", "Mandya", 55, 88),
]

VARIETIES = {
    "Coriander": ["Sarvadarshan", "Local selection"],
    "Spinach": ["Bangar", "Local selection"],
    "Tomato": ["Hybrid 4400", "Arka Vikas", "Desi"],
    "Onion": ["Nashik Red", "Bangar", "Red Kharpur"],
    "Potato": ["Agra", "Kufri"],
    "Carrot": ["Ooty", "Local selection"],
    "Brinjal": ["Purple Long", "Round"],
    "Banana": ["Robusta", "Grand Naine"],
    "Bottle Gourd": ["Local selection"],
    "Beans": ["French Bean", "Local selection"],
    "Carrot": ["Ooty", "Local selection"],
}

COLLECTION_SLOTS = [
    "Slot 1 — 05:00 to 08:00",
    "Slot 2 — 08:00 to 12:00",
    "Slot 3 — 12:00 to 16:00",
]

HARVEST_READY = ["Ready now", "1 day", "2 days", "3-4 days", "5-7 days",
                 "More than 7 days", "Not yet flowering / not ready"]
HARVEST_METHOD = ["Hand picking", "Machine harvest", "Cutting whole plant",
                  "Root / tuber pull", "Mixed"]
IRRIGATION = ["Borewell", "Canal", "Rain-fed", "Drip", "Mixed / unknown"]
CRATE_SUPPLY = ["Ample — own crates", "Limited — own crates",
                "Need crates supplied by buyer", "No crates"]
COLD_CHAIN = ["Pre-cooling available", "Chilled van available",
              "Insulated crates only", "Ambient only"]
PAYMENT_TERMS = ["Immediate on delivery", "Same day", "7 days", "15 days",
                 "30 days", "On consignment sale"]
TRANSPORT = ["FPO owns transport", "We arrange and pay", "Shared cost",
             "Buyer collects from farm"]
WEATHER = ["Dry and cool", "Dry and hot", "Light rain likely",
           "Heavy rain likely", "Storm / extreme heat warning"]

# Per-FPO behaviour. Deliberately varied so the scorecard and the decision
# logic actually separate the field rather than returning a uniform verdict.
FPO_BEHAVIOUR = {
    # id:        (grade_a_bias, volume_bias, price_bias, loss_bias, ready_bias)
    "FPO-KOL-01": (12, 1.10, 1.06, -1.0, 0.30),
    "FPO-CBK-02": (4, 1.00, 1.02, 0.5, 0.45),
    "FPO-HSR-01": (-14, 0.92, 1.10, 3.5, 0.20),
    "FPO-CMK-04": (8, 1.04, 1.01, -0.5, 0.55),
    "FPO-MYS-03": (-4, 1.14, 0.98, 1.0, 0.25),
    "FPO-TUM-02": (2, 0.98, 1.05, 2.0, 0.40),
    "FPO-MDY-01": (-20, 0.85, 1.14, 5.0, 0.15),
}

# Field volumes by commodity, Rs/kg reference.
COMMODITY_PLAN = {
    "Coriander": 420, "Spinach": 380, "Tomato": 1400, "Onion": 2600,
    "Potato": 3200, "Carrot": 640, "Brinjal": 520, "Banana": 900,
    "Bottle Gourd": 380, "Beans": 460,
}

WEEK_OF = date(2026, 10, 5)   # Monday


# ---------------------------------------------------------------------------
# Utils.gs mirror
# ---------------------------------------------------------------------------

def to_number(raw: Any) -> float | None:
    """Coerce a submitted answer to a number, or None.

    Mirrors toNumber_(): an unparseable value is a *missing* value, not zero.
    That distinction decides procurement -- a zero harvest means do not
    order, a missing harvest means ask again.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "":
        return None
    cleaned = s.replace(",", "").replace(" ", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def to_number_or(raw: Any, fallback: float) -> float:
    n = to_number(raw)
    return fallback if n is None else n


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def round_(value: float, decimals: int = 0) -> float:
    """Round half-away-from-zero, matching JavaScript's Math.round.

    Python's round() is banker's rounding, so round(0.5) is 0 while
    Math.round(0.5) is 1. A half-rupee difference per line across a few
    thousand lines is a real reconciliation gap between the two
    implementations, so it is handled explicitly rather than inherited.
    """
    f = 10 ** decimals
    x = value * f
    # Away from zero for .5 exactly, which is what Math.round does.
    r = int(x + 0.5) if x >= 0 else -int(-x + 0.5)
    return r / f


def grade_index(a_pct: float | None, b_pct: float | None, c_pct: float | None) -> float:
    """Weighted saleable yield, 0 to 1.

    Clamped at the top as well as per-share. An agent who reports 120% Grade A
    would otherwise produce a grade index above 1.0 and an order larger than
    their own harvest estimate. `validate()` rejects the implausible sum, but
    a yield figure that can exceed 100% by arithmetic is the wrong kind of
    number to have sitting underneath a purchase order.
    """
    a = clamp(to_number_or(a_pct, 0) / 100, 0, 1)
    b = clamp(to_number_or(b_pct, 0) / 100, 0, 1)
    c = clamp(to_number_or(c_pct, 0) / 100, 0, 1)
    raw = a * GRADE_YIELD["A"] + b * GRADE_YIELD["B"] + c * GRADE_YIELD["C"]
    return clamp(raw, 0.0, 1.0)


def saleable_quantity(expected_kg: float | None, commodity: str,
                      gi: float, confidence: str, field_loss_pct: float | None) -> float:
    base = to_number_or(expected_kg, 0)
    if base <= 0:
        return 0.0
    conf = CONFIDENCE_FACTOR.get(confidence, 0.85)
    loss_factor = COMMODITY_LOSS_FACTOR.get(commodity, 0.06)
    measured = to_number(field_loss_pct)
    if measured is not None:
        loss_factor = clamp(measured / 100, 0, 0.5)
    return round_(base * conf * gi * (1 - loss_factor), 1)


def weighted_average_price(pairs: list[tuple[float, Any]]) -> float | None:
    total_kg = 0.0
    total_value = 0.0
    for kg, price in pairs:
        kg = to_number_or(kg, 0)
        p = to_number(price)
        if kg > 0 and p is not None:
            total_kg += kg
            total_value += kg * p
    if total_kg == 0:
        return None
    return round_(total_value / total_kg, 2)


def implied_retail_price(cost_per_kg: float | None, target_margin_pct: float) -> float | None:
    cost = to_number_or(cost_per_kg, 0)
    margin = clamp(to_number_or(target_margin_pct, TARGET_MARGIN_PCT) / 100, 0.01, 0.95)
    if cost <= 0:
        return None
    return round_(cost / (1 - margin), 2)


def cost_to_retail_pct(cost_per_kg: float | None, retail_per_kg: float | None) -> float | None:
    cost = to_number_or(cost_per_kg, 0)
    retail = to_number_or(retail_per_kg, 0)
    if cost <= 0 or retail <= 0:
        return None
    return round_(100 * cost / retail, 2)


def estimated_shelf_life_days(commodity: str, distance_km: Any) -> int:
    base = COMMODITY_SHELF_LIFE_DAYS.get(commodity, 7)
    transit_penalty = to_number_or(distance_km, 0) / 40
    return max(1, int(round_(base - transit_penalty)))


def week_start(d: date) -> date:
    """ISO week start (Monday)."""
    return d - timedelta(days=d.weekday())


def retail_reference(commodity: str, mandi_rate: float | None) -> float | None:
    """Independent retail reference, so the margin test is not circular."""
    base = mandi_rate if mandi_rate is not None else MANDI_BENCHMARK.get(commodity)
    if base is None:
        return None
    mult = RETAIL_MULTIPLIER.get(commodity, 1.55)
    return round_(base * mult, 2)


# ---------------------------------------------------------------------------
# Synthetic survey responses
# ---------------------------------------------------------------------------

def make_responses(rng: random.Random, weeks: int = 2) -> list[dict]:
    """Simulate field-agent submissions across a set of ISO weeks."""
    rows: list[dict] = []
    resp_id = 0

    for w in range(weeks):
        wk = WEEK_OF + timedelta(weeks=w)
        for fpo_id, fpo_name, district, base_grade, base_dist in FPOS:
            g_bias, v_bias, p_bias, loss_bias, ready_bias = FPO_BEHAVIOUR[fpo_id]
            agent_name, agent_id = rng.choice(AGENTS)
            # Each FPO is surveyed on 3-5 commodities, rotating week to week.
            commodities = rng.sample(list(COMMODITY_PLAN), rng.randint(3, 5))
            for commodity in commodities:
                resp_id += 1
                plan = COMMODITY_PLAN[commodity]
                expected = round_(plan * v_bias * rng.gauss(1.0, 0.12), 0)

                grade_a = clamp(base_grade + g_bias + rng.gauss(0, 6), 15, 92)
                grade_c = clamp(rng.gauss(11, 3) - g_bias * 0.3, 2, 30)
                grade_b = clamp(100 - grade_a - grade_c, 5, 85)
                # Re-derive A so the three shares always sum to 100 exactly.
                grade_a = round_(100 - grade_b - grade_c, 1)

                mandi = MANDI_BENCHMARK.get(commodity, 20.0)
                quote = round_(mandi * p_bias * rng.gauss(1.0, 0.04), 2)

                field_loss = clamp(rng.gauss(6, 2.2) + loss_bias, 0.5, 24)
                confidence = rng.choices(
                    ["High", "Medium", "Low"], weights=[60, 28, 12])[0]
                ready = rng.choices(
                    HARVEST_READY,
                    weights=[ready_bias * 10, ready_bias * 8, 0.25, 0.15, 0.10, 0.08, 0.04],
                )[0]

                gi = grade_index(grade_a, grade_b, grade_c)
                saleable = saleable_quantity(expected, commodity, gi,
                                            confidence, field_loss)
                shelf = estimated_shelf_life_days(commodity, base_dist)

                rows.append({
                    "submitted_at": (wk + timedelta(days=rng.randint(0, 4))
                                     ).isoformat(),
                    "survey_date": (wk + timedelta(days=rng.randint(0, 4))).isoformat(),
                    "agent_name": agent_name,
                    "agent_id": agent_id,
                    "fpo_name": fpo_name,
                    "fpo_id": fpo_id,
                    "district": district,
                    "village": f"{district[:3].upper()}-{rng.randint(1, 24):02d}",
                    "gps_lat": round_(12.30 + rng.random() * 0.90, 4),
                    "gps_lng": round_(76.60 + rng.random() * 1.40, 4),
                    "weather_48h": rng.choices(WEATHER, weights=[40, 30, 20, 8, 2])[0],
                    "commodity": commodity,
                    "variety": rng.choice(VARIETIES.get(commodity, ["Local selection"])),
                    "harvest_ready": ready,
                    "expected_harvest_kg": expected,
                    "expected_next_week_kg": round_(expected * rng.gauss(1.0, 0.15), 0),
                    "harvest_method": rng.choices(
                        HARVEST_METHOD, weights=[80, 8, 6, 4, 2])[0],
                    "irrigation": rng.choices(
                        IRRIGATION, weights=[45, 15, 25, 12, 3])[0],
                    "confidence": confidence,
                    "grade_a_pct": grade_a,
                    "grade_b_pct": grade_b,
                    "grade_c_pct": grade_c,
                    "grade_index": round_(gi, 4),
                    "graded_at_source": rng.choices(
                        ["Yes — graded at the farm", "Yes — graded at a collection point",
                         "No — ungraded", "Partially"], weights=[22, 30, 38, 10])[0],
                    "field_photo": f"field_{resp_id:04d}.jpg",
                    "field_loss_pct": round_(field_loss, 1),
                    "pest_issues": rng.choice(
                        ["", "", "", "Thrips on lower leaves", "Fruit borer",
                         "Wilting after irrigation"]),
                    "expected_price_inr_kg": quote,
                    "mandi_rate_inr_kg": round_(mandi, 2),
                    "premium_over_mandi_pct": round_(100 * (quote - mandi) / mandi, 2),
                    "price_basis": rng.choices(
                        ["Farm gate, ex-harvest", "Collection centre, delivered",
                         "Mandi rate parity", "Open to discussion"],
                        weights=[45, 35, 15, 5])[0],
                    "min_acceptable_price": round_(quote * rng.uniform(0.88, 0.98), 2),
                    "payment_terms": rng.choices(
                        PAYMENT_TERMS, weights=[30, 20, 25, 15, 8, 2])[0],
                    "transport_owned": rng.choices(
                        TRANSPORT, weights=[40, 30, 20, 10])[0],
                    "collection_slot": rng.choice(COLLECTION_SLOTS),
                    "qty_today_kg": round_(max(0, expected * rng.uniform(0, 0.55)), 0),
                    "crate_supply": rng.choices(
                        CRATE_SUPPLY, weights=[35, 35, 22, 8])[0],
                    "cold_chain": rng.choices(
                        COLD_CHAIN, weights=[8, 12, 30, 50])[0],
                    "distance_to_cc_km": base_dist + rng.randint(-6, 6),
                    "est_shelf_life_days": shelf,
                    "planned_saleable_kg": saleable,
                    "retail_needed_for_target": implied_retail_price(quote, TARGET_MARGIN_PCT),
                    "remarks": "",
                    "_shelf_life": shelf,
                })
    return rows


# ---------------------------------------------------------------------------
# Aggregator.gs mirror
# ---------------------------------------------------------------------------

PO_MATRIX_HEADERS = [
    "iso_week_start", "commodity", "fpo_id", "fpo_name", "district",
    "response_count", "expected_harvest_kg", "grade_adjusted_kg",
    "grade_a_share_pct", "grade_index", "weighted_price_inr_kg",
    "mandi_rate_inr_kg", "premium_over_mandi_pct", "implied_retail_inr_kg",
    "cost_to_retail_pct", "est_shelf_life_days", "collection_slot",
    "earliest_collection_date", "feasible_qty_kg", "po_value_inr",
    "fill_rate_pct", "sourcing_decision", "risk_flags", "planning_note",
]

SCORECARD_HEADERS = [
    "fpo_id", "fpo_name", "district", "responses", "commodities",
    "grade_a_share_pct", "avg_grade_index", "field_loss_pct",
    "weighted_price_inr_kg", "mandi_premium_pct", "est_volume_kg",
    "on_time_pct", "graded_at_source_pct", "fpo_score", "tier", "actions",
]


def _median(values: list[float | None]) -> float | None:
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    mid = len(v) // 2
    return v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2


def _mean(values: list[float | None]) -> float | None:
    v = [x for x in values if x is not None]
    return sum(v) / len(v) if v else None


def summarise_group(group: list[dict]) -> dict:
    first = group[0]
    commodity = first["commodity"]
    wk = week_start(date.fromisoformat(first["survey_date"])).isoformat()

    expected = sum(to_number_or(r["expected_harvest_kg"], 0) for r in group)
    grade_adjusted = sum(to_number_or(r["planned_saleable_kg"], 0) for r in group)
    price = weighted_average_price(
        [(to_number_or(r["expected_harvest_kg"], 0), r["expected_price_inr_kg"])
         for r in group])
    mandi = _median([to_number(r["mandi_rate_inr_kg"]) for r in group])
    grade_a = _median([to_number(r["grade_a_pct"]) for r in group])
    gi = _mean([to_number(r["grade_index"]) for r in group])
    loss = _median([to_number(r["field_loss_pct"]) for r in group])
    n = len(group)

    implied_retail = implied_retail_price(price, TARGET_MARGIN_PCT)
    premium = (round_(100 * (price - mandi) / mandi, 2)
               if price is not None and mandi else None)
    reference = retail_reference(commodity, mandi)
    ctr = cost_to_retail_pct(price, reference)

    flags: list[str] = []
    if grade_a is not None and grade_a < MIN_GRADE_A_SHARE_PCT:
        flags.append(f"LOW GRADE-A ({round_(grade_a, 1)}%) — agronomy visit")
    if loss is not None and loss > MAX_POST_HARVEST_LOSS_PCT:
        flags.append(f"HIGH FIELD LOSS ({round_(loss, 1)}%) — handling training")
    if premium is not None and premium > MAX_PREMIUM_OVER_MANDI_PCT:
        flags.append(f"PRICE ABOVE MANDI (+{round_(premium, 1)}%) — renegotiate")
    if ctr is not None and ctr > MAX_COST_TO_RETAIL_PCT:
        flags.append(f"MARGIN BREACH ({round_(ctr, 1)}% cost-to-retail)")
    avg_dist = to_number_or(_mean([to_number(r["distance_to_cc_km"]) for r in group]), 0)
    # 80 km is roughly the point where an unprotected 4-5 hour transit
    # starts eating a one-week shelf life, so this is a chain-cost note
    # rather than a deal-breaker.
    if avg_dist > 80:
        flags.append(f"LONG TRANSIT ({round_(avg_dist, 0)} km) — chain cost check")
    crate_dep = sum(1 for r in group if r["crate_supply"] in
                    ("Need crates supplied by buyer", "No crates"))
    if crate_dep:
        flags.append(f"CRATE DEPENDENT ({crate_dep}/{n} responses)")
    slots = sorted({r["collection_slot"] for r in group if r["collection_slot"]})
    if len(slots) > 1:
        flags.append(f"SPLIT COLLECTION SLOTS ({len(slots)})")

    shelf = estimated_shelf_life_days(commodity, avg_dist)
    feasible = grade_adjusted
    if first["harvest_ready"] in ("More than 7 days", "Not yet flowering / not ready"):
        feasible = 0.0
        flags.append("NOT HARVEST-READY — plan next cycle, do not order")

    decision = sourcing_decision(flags, feasible, ctr)
    flag_text = " | ".join(flags)

    return {
        "iso_week_start": wk,
        "commodity": commodity,
        "fpo_id": first["fpo_id"],
        "fpo_name": first["fpo_name"],
        "district": first["district"],
        "response_count": n,
        "expected_harvest_kg": round_(expected, 1),
        "grade_adjusted_kg": round_(grade_adjusted, 1),
        "grade_a_share_pct": "" if grade_a is None else round_(grade_a, 1),
        "grade_index": "" if gi is None else round_(gi, 3),
        "weighted_price_inr_kg": "" if price is None else price,
        "mandi_rate_inr_kg": "" if mandi is None else round_(mandi, 2),
        "premium_over_mandi_pct": "" if premium is None else premium,
        "implied_retail_inr_kg": "" if implied_retail is None else implied_retail,
        "cost_to_retail_pct": "" if ctr is None else ctr,
        "est_shelf_life_days": shelf,
        "collection_slot": slots[0] if slots else "",
        "earliest_collection_date": wk,
        "feasible_qty_kg": round_(feasible, 1),
        "po_value_inr": 0 if price is None else round_(feasible * price, 2),
        "fill_rate_pct": (round_(100 * grade_adjusted / expected, 1)
                          if expected > 0 else ""),
        "sourcing_decision": decision,
        "risk_flags": flag_text,
        "planning_note": planning_note(commodity, shelf, first["harvest_ready"],
                                       grade_adjusted, decision),
    }


def sourcing_decision(flags: list[str], feasible: float, ctr: float | None) -> str:
    has = lambda n: any(n in f for f in flags)  # noqa: E731
    if feasible <= 0 or has("NOT HARVEST-READY"):
        return "DEFER — not harvest-ready"
    if has("MARGIN BREACH"):
        return "REJECT — margin breach"
    if has("LOW GRADE-A") or has("HIGH FIELD LOSS"):
        return "CONDITIONAL — trial order with quality follow-up"
    if ctr is not None and ctr > MAX_COST_TO_RETAIL_PCT - 6:
        return "CONDITIONAL — thin margin, negotiate before PO"
    if has("PRICE ABOVE MANDI") and has("CRATE DEPENDENT"):
        return "CONDITIONAL — price and crate risk"
    if has("PRICE ABOVE MANDI"):
        return "APPROVE WITH NEGOTIATION"
    return "APPROVE"


def planning_note(commodity: str, shelf: int, ready: str, qty: float,
                  decision: str) -> str:
    slot = ("today" if ready == "Ready now"
            else "tomorrow" if ready == "1 day" else "within the week")
    life = (f"Estimated {shelf} days shelf life at the centre, so the delivery "
            f"window must close {shelf} day(s) from collection.")
    vol = (f"Plan {qty} kg grade-adjusted." if qty > 0
           else "No volume to plan this week.")
    dec = ("Raise the PO." if decision.startswith("APPROVE")
           else "Raise a reduced PO with the flagged fix attached."
           if decision.startswith("CONDITIONAL") else "Hold.")
    return f"{commodity}: collect {slot}. {life} {vol} {dec}"


def build_po_matrix(records: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    for r in records:
        key = (week_start(date.fromisoformat(r["survey_date"])).isoformat(),
               r["commodity"], r["fpo_id"])
        groups.setdefault(key, []).append(r)
    rows = [summarise_group(g) for g in groups.values()]
    rows.sort(key=lambda r: (r["iso_week_start"], -r["feasible_qty_kg"]))
    return rows


def fpo_score(grade_a, loss, on_time_pct, graded_pct, premium) -> float:
    s = clamp(to_number_or(grade_a, 0), 0, 100) * 0.30
    s += clamp(100 - to_number_or(loss, 0) * 5, 0, 100) * 0.20
    s += clamp(to_number_or(on_time_pct, 0), 0, 100) * 0.20
    s += clamp(to_number_or(graded_pct, 0), 0, 100) * 0.15
    s += clamp(100 - to_number_or(premium, 0) * 3, 0, 100) * 0.15
    return clamp(s, 0, 100)


def fpo_actions(tier: str, loss, grade_a, premium) -> str:
    if tier.startswith("A"):
        return "Offer a standing weekly order; add a second commodity."
    if tier.startswith("B"):
        return "Maintain volume; invite to the next grading workshop."
    if tier.startswith("C"):
        if to_number_or(loss, 0) > MAX_POST_HARVEST_LOSS_PCT:
            return "Handling intervention before any order increase — field loss too high."
        if to_number_or(grade_a, 0) < MIN_GRADE_A_SHARE_PCT:
            return "Agronomy support on grading; trial order only until Grade A improves."
        return "Hold volume flat; renegotiate price toward mandi parity."
    return "Suspend; re-survey next cycle before any commitment."


def build_scorecard(records: list[dict]) -> list[dict]:
    by_fpo: dict[str, list[dict]] = {}
    for r in records:
        by_fpo.setdefault(r["fpo_id"], []).append(r)

    rows = []
    for fpo_id, g in by_fpo.items():
        grade_a = _median([to_number(r["grade_a_pct"]) for r in g])
        gi = _mean([to_number(r["grade_index"]) for r in g])
        loss = _median([to_number(r["field_loss_pct"]) for r in g])
        price = weighted_average_price(
            [(to_number_or(r["expected_harvest_kg"], 0), r["expected_price_inr_kg"])
             for r in g])
        mandi = _median([to_number(r["mandi_rate_inr_kg"]) for r in g
                         if to_number(r["mandi_rate_inr_kg"])])
        premium = (round_(100 * (price - mandi) / mandi, 2)
                   if price is not None and mandi else None)
        on_time = round_(100 * sum(1 for r in g if r["harvest_ready"] in
                                   ("Ready now", "1 day")) / len(g), 1)
        graded = round_(100 * sum(1 for r in g
                                  if str(r["graded_at_source"]).startswith("Yes")) / len(g), 1)
        vol = sum(to_number_or(r["expected_harvest_kg"], 0) for r in g)
        score = fpo_score(grade_a, loss, on_time, graded, premium)
        tier = ("A — scale up" if score >= 75 else "B — maintain"
                if score >= 55 else "C — remediate" if score >= 35 else "D — suspend")

        rows.append({
            "fpo_id": fpo_id,
            "fpo_name": g[0]["fpo_name"],
            "district": g[0]["district"],
            "responses": len(g),
            "commodities": len({r["commodity"] for r in g}),
            "grade_a_share_pct": "" if grade_a is None else round_(grade_a, 1),
            "avg_grade_index": "" if gi is None else round_(gi, 3),
            "field_loss_pct": "" if loss is None else round_(loss, 1),
            "weighted_price_inr_kg": "" if price is None else price,
            "mandi_premium_pct": "" if premium is None else premium,
            "est_volume_kg": round_(vol, 1),
            "on_time_pct": on_time,
            "graded_at_source_pct": graded,
            "fpo_score": round_(score, 1),
            "tier": tier,
            "actions": fpo_actions(tier, loss, grade_a, premium),
        })
    rows.sort(key=lambda r: -r["fpo_score"])
    return rows


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_csv(path: Path, rows: list[dict], headers: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=headers, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {path.name}  ({len(rows)} rows)")


def main() -> None:
    rng = random.Random(20261012)
    print("[generate_samples] simulating field responses")
    records = make_responses(rng)

    raw_headers = [h for h in records[0] if not h.startswith("_")]
    write_csv(HERE / "sample_fpo_responses.csv", records, raw_headers)

    matrix = build_po_matrix(records)
    write_csv(HERE / "po_planning_matrix_sample.csv", matrix, PO_MATRIX_HEADERS)

    scorecard = build_scorecard(records)
    write_csv(HERE / "fpo_scorecard_sample.csv", scorecard, SCORECARD_HEADERS)

    this_week = WEEK_OF.isoformat()
    wk_rows = [r for r in matrix if r["iso_week_start"] == this_week]
    decisions: dict[str, int] = {}
    for r in wk_rows:
        key = r["sourcing_decision"].split(" — ")[0]
        decisions[key] = decisions.get(key, 0) + 1
    planned_kg = sum(r["feasible_qty_kg"] for r in wk_rows)
    planned_value = sum(r["po_value_inr"] for r in wk_rows)
    expected_kg = sum(r["expected_harvest_kg"] for r in wk_rows)

    summary = {
        "week": this_week,
        "responses": len(records),
        "fpos": len({r["fpo_id"] for r in records}),
        "commodities": len({r["commodity"] for r in records}),
        "matrix_rows": len(matrix),
        "week_rows": len(wk_rows),
        "expected_harvest_kg": round(expected_kg, 1),
        "grade_adjusted_kg": round(sum(r["grade_adjusted_kg"] for r in wk_rows), 1),
        "feasible_po_kg": round(planned_kg, 1),
        "po_value_inr": round(planned_value, 2),
        "grade_to_feasible_conversion_pct": round(100 * planned_kg / expected_kg, 1),
        "decisions": decisions,
        "fpo_tiers": {r["fpo_id"]: r["tier"] for r in scorecard},
    }
    (HERE / "pipeline_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8")

    print()
    print(f"  week {this_week}: {len(wk_rows)} planning lines, "
          f"{planned_kg:,.0f} kg feasible, Rs {planned_value:,.0f}")
    print(f"  decisions: {decisions}")
    print(f"  tiers: {summary['fpo_tiers']}")


if __name__ == "__main__":
    main()
