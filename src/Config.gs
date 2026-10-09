/**
 * Config.gs — central configuration for the FPO sourcing pipeline.
 *
 * Every tunable lives here rather than being scattered through the codebase.
 * The most operationally important field is SPREADSHEET_ID: the form and its
 * response sheet are separate Drive objects with separate IDs, so the script
 * cannot use getActiveSpreadsheet() and must be given this ID explicitly.
 * See docs/architecture-flowchart.md.
 */

// ---------------------------------------------------------------------------
// Spreadsheet wiring
// ---------------------------------------------------------------------------

/** ID of the tracking workbook. Taken from the sheet URL between /d/ and /edit. */
var SPREADSHEET_ID = 'REPLACE_WITH_YOUR_SPREADSHEET_ID';

/** Sheet names. Created by setupSpreadsheet() if absent. */
var SHEETS = {
  RAW: 'Raw_Responses',
  VALIDATION_LOG: 'Validation_Log',
  PO_MATRIX: 'PO_Planning_Matrix',
  FPO_SCORECARD: 'FPO_Scorecard',
  COMMODITY_BENCHMARK: 'Commodity_Benchmark',
  DASHBOARD: 'Sourcing_Dashboard'
};

/** Question titles, keyed by stable id. Title matching is used deliberately:
 *  item IDs are opaque and change whenever the form is edited, whereas a
 *  documented title is readable and diffable. Titles here must match the
 *  form exactly -- buildSurvey() generates the form from this same object, so
 *  the two cannot drift. */
var QUESTIONS = {
  // Section 1 — identity
  AGENT_NAME: 'Sourcing agent name',
  AGENT_ID: 'Agent ID',
  FPO_NAME: 'FPO / farmer group name',
  FPO_ID: 'FPO ID',
  DISTRICT: 'District',
  VILLAGE: 'Village / cluster',
  GPS_LAT: 'GPS latitude',
  GPS_LNG: 'GPS longitude',
  SURVEY_DATE: 'Survey date',
  WEATHER_48H: 'Weather outlook, next 48 hours',

  // Section 2 — harvest readiness
  COMMODITY: 'Commodity',
  VARIETY: 'Variety',
  HARVEST_READY_DAYS: 'Days to harvest readiness',
  EXPECTED_HARVEST_KG: 'Expected harvest volume (kg) - next 7 days',
  EXPECTED_HARVEST_KG_NEXT: 'Expected harvest volume (kg) - week after',
  HARVEST_METHOD: 'Harvest method',
  IRRIGATION: 'Irrigation source',
  ESTIMATE_CONFIDENCE: 'Confidence in volume estimate',

  // Section 3 — quality
  GRADE_A_PCT: 'Grade A share (%)',
  GRADE_B_PCT: 'Grade B share (%)',
  GRADE_C_PCT: 'Grade C share (%)',
  GRADING_DONE_AT_SOURCE: 'Is grading already done at source?',
  FIELD_PHOTO: 'Field photo reference (file name or drive link)',
  POST_HARVEST_LOSS_PCT: 'Observed post-harvest loss in field (%)',
  PEST_ISSUES: 'Any pest / disease issues',

  // Section 4 — pricing
  EXPECTED_PRICE_PER_KG: 'Expected price (Rs/kg) at collection centre',
  MANDI_RATE_TODAY: 'Today\'s mandi rate for this commodity (Rs/kg)',
  PRICE_BASIS: 'Price basis offered',
  MIN_ACCEPTABLE_PRICE: 'Minimum acceptable price (Rs/kg)',
  PAYMENT_TERMS: 'Payment terms sought',
  TRANSPORT_OWNED: 'Who owns transport to collection centre',

  // Section 5 — logistics
  COLLECTION_SLOT: 'Preferred collection slot',
  QTY_AVAILABLE_FOR_PICKUP: 'Quantity available for pickup today (kg)',
  CRATE_SUPPLY: 'Crate supply position',
  COLD_CHAIN_AVAILABLE: 'Cold chain available at village',
  DISTANCE_TO_CC_KM: 'Distance to collection centre (km)',
  REMARKS: 'Remarks'
};

// ---------------------------------------------------------------------------
// Grade model
// ---------------------------------------------------------------------------

/**
 * Grade yields: the share of a lot that passes a retail-grade gate.
 * A is near-full yield, C is heavily discounted and mostly diverts.
 * These weights are the core of the PO quantity calculation, so they are
 * declared once, here, and never inlined elsewhere.
 */
var GRADE_YIELD = { A: 1.00, B: 0.75, C: 0.45 };

/** Saleable fraction after harvest handling losses, by commodity group. */
var COMMODITY_LOSS_FACTOR = {
  'Leafy Greens': 0.10,
  'Herbs': 0.08,
  'Root Vegetables': 0.05,
  'Brinjal & Cucurbit': 0.07,
  'Bulb & Stem': 0.03,
  'Fruit': 0.06
};

/**
 * Shelf life by commodity, in days at ambient south-Indian conditions.
 * Drives the FEFO ordering of the consolidated purchase order: a lot with
 * three days of life cannot be scheduled into a delivery window four days
 * out, no matter how good the price is.
 */
var COMMODITY_SHELF_LIFE_DAYS = {
  'Leafy Greens': 2,
  'Herbs': 3,
  'Root Vegetables': 15,
  'Brinjal & Cucurbit': 8,
  'Bulb & Stem': 30,
  'Fruit': 7
};

/** Confidence haircut applied to a farmer's volume estimate. */
var CONFIDENCE_FACTOR = {
  'High': 1.00,
  'Medium': 0.90,
  'Low': 0.75
};

// ---------------------------------------------------------------------------
// Commercial thresholds -- the rules that turn data into decisions
// ---------------------------------------------------------------------------

/** Target gross margin on landed cost, for the sourcing recommendation. */
var TARGET_MARGIN_PCT = 22.0;

/** Hard ceiling on procurement cost as a share of planned retail price.
 *  Above this, retail cannot clear the target margin at any sell-through. */
var MAX_COST_TO_RETAIL_PCT = 74.0;

/** Grade-A share below which a lot needs an agronomy intervention rather
 *  than a price negotiation. */
var MIN_GRADE_A_SHARE_PCT = 55.0;

/** Post-harvest loss above which the FPO needs handling training before it
 *  is scaled up, regardless of how cheap its produce is. */
var MAX_POST_HARVEST_LOSS_PCT = 8.0;

/** Farm-gate price premium above the local mandi rate above which the
 *  sourcing team should challenge the quote. */
var MAX_PREMIUM_OVER_MANDI_PCT = 12.0;

var COLLECTION_SLOTS = [
  'Slot 1 — 05:00 to 08:00',
  'Slot 2 — 08:00 to 12:00',
  'Slot 3 — 12:00 to 16:00'
];

/**
 * MANDI_BENCHMARK — reference modal wholesale rates, Rs/kg.
 * Anchored to publicly reported All-India figures for October 2026, which
 * report potato ~Rs 1,200/qtl (Rs 12.00/kg), tomato ~Rs 3,095/qtl
 * (Rs 30.95/kg) and onion ~Rs 4,500/qtl (Rs 45.00/kg). Populate the
 * Commodity_Benchmark sheet from this map on first run, then overwrite it
 * with live mandi rates each morning.
 */
var MANDI_BENCHMARK = {
  'Potato': 12.00,
  'Onion': 45.00,
  'Tomato': 30.95,
  'Tomato (Hybrid)': 30.95,
  'Carrot': 26.00,
  'Radish': 14.00,
  'Beetroot': 22.00,
  'Sweet Potato': 25.00,
  'Brinjal': 24.00,
  'Bottle Gourd': 19.00,
  'Bitter Gourd': 28.00,
  'Capsicum': 38.00,
  'Coriander': 20.00,
  'Spinach': 18.00,
  'Methi': 16.00,
  'Ginger': 24.00,
  'Garlic': 26.00,
  'Banana': 22.00,
  'Apple': 118.00,
  'Pomegranate': 95.00,
  'Pineapple': 42.00
};
