/**
 * Utils.gs — pure calculation helpers.
 *
 * Kept free of SpreadsheetApp and FormApp calls so the commercial logic can
 * be reasoned about (and unit-tested by mirroring it in samples/) without
 * touching a service boundary.
 */

/**
 * Coerce a submitted answer to a number, or return null.
 *
 * Form answers arrive as strings, and a field agent typing "1,200" on a
 * keypad is a routine event, not an edge case. Returning null rather than
 * NaN lets the caller distinguish "not answered" from "answered as zero" --
 * which matters, because a zero harvest and a missing harvest imply
 * opposite procurement decisions.
 */
function toNumber_(raw) {
  if (raw === null || raw === undefined || raw === '') { return null; }
  var cleaned = String(raw).replace(/[,\s]/g, '');
  var n = Number(cleaned);
  return isNaN(n) ? null : n;
}

/** Coerce to a number, falling back to a default. */
function toNumberOr_(raw, fallback) {
  var n = toNumber_(raw);
  return n === null ? fallback : n;
}

/** Clamp a number into a range. */
function clamp_(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/** Round to a given number of decimals without float drift. */
function round_(value, decimals) {
  var f = Math.pow(10, decimals || 0);
  return Math.round(value * f) / f;
}

/**
 * Normalise a checkbox / multi-select answer to a single display string.
 *
 * getResponse() returns an array for checkbox items and a bare string for
 * everything else. Writing the array straight into a cell produces
 * "[object Object]" or a coerced mess, so arrays are joined here.
 */
function normaliseAnswer_(raw) {
  if (raw === null || raw === undefined) { return ''; }
  if (Object.prototype.toString.call(raw) === '[object Array]') {
    return raw.join(', ');
  }
  return String(raw);
}

/** Read a field by question title from a FormResponse, case-insensitively. */
function readAnswer_(itemResponses, title) {
  var target = String(title).toLowerCase();
  for (var i = 0; i < itemResponses.length; i++) {
    if (String(itemResponses[i].getItem().getTitle()).toLowerCase() === target) {
      return normaliseAnswer_(itemResponses[i].getResponse());
    }
  }
  return '';
}

/**
 * Weighted grade index for a lot, 0 to 1.
 *
 * A naive mean of the grade shares would be wrong: 100% Grade C has a mean
 * of 1.0 on the share scale but a saleable yield of 0.45. This weights each
 * share by what that grade is actually worth at retail.
 */
function gradeIndex_(gradeAPct, gradeBPct, gradeCPct) {
  var a = clamp_(toNumberOr_(gradeAPct, 0) / 100, 0, 1);
  var b = clamp_(toNumberOr_(gradeBPct, 0) / 100, 0, 1);
  var c = clamp_(toNumberOr_(gradeCPct, 0) / 100, 0, 1);
  var raw = a * GRADE_YIELD.A + b * GRADE_YIELD.B + c * GRADE_YIELD.C;
  // Clamped at the top as well as per-share. An agent reporting 120% Grade A
  // would otherwise produce an index above 1.0 and an order larger than their
  // own harvest estimate. validate_() rejects the implausible sum, but a yield
  // figure that can exceed 100% by arithmetic is the wrong kind of number to
  // have sitting underneath a purchase order.
  return clamp_(raw, 0, 1);
}

/**
 * Saleable quantity from a raw harvest estimate.
 *
 * Three haircuts are applied in order, each for a distinct reason:
 *   1. confidence      -- the estimate is the agent's judgement, not a weighbridge
 *   2. grade yield     -- Grade C mostly diverts rather than sells
 *   3. field loss      -- loss between picking and the collection centre
 */
function saleableQuantity_(expectedKg, commodity, gradeIndex, confidence, fieldLossPct) {
  var base = toNumberOr_(expectedKg, 0);
  if (base <= 0) { return 0; }
  var conf = CONFIDENCE_FACTOR[confidence];
  if (conf === undefined) { conf = 0.85; }
  var lossFactor = COMMODITY_LOSS_FACTOR[commodity];
  if (lossFactor === undefined) { lossFactor = 0.06; }
  // Field loss overrides the commodity default when the agent measured it.
  var measured = toNumber_(fieldLossPct);
  if (measured !== null) {
    lossFactor = clamp_(measured / 100, 0, 0.5);
  }
  return round_(base * conf * gradeIndex * (1 - lossFactor), 1);
}

/** Volume-weighted average price across several lots, ignoring nulls. */
function weightedAveragePrice_(pairs) {
  var totalKg = 0;
  var totalValue = 0;
  for (var i = 0; i < pairs.length; i++) {
    var kg = toNumberOr_(pairs[i].kg, 0);
    var price = toNumber_(pairs[i].price);
    if (kg > 0 && price !== null) {
      totalKg += kg;
      totalValue += kg * price;
    }
  }
  if (totalKg === 0) { return null; }
  return round_(totalValue / totalKg, 2);
}

/**
 * Implied retail price for a commodity at a target margin on landed cost.
 *
 * Inverts margin = (retail - cost) / retail, so
 *   retail = cost / (1 - margin).
 * Deriving retail this way is what makes the cost-to-retail ceiling check
 * meaningful: the ceiling is a margin policy restated.
 */
function impliedRetailPrice_(landedCostPerKg, targetMarginPct) {
  var cost = toNumberOr_(landedCostPerKg, 0);
  var margin = clamp_(toNumberOr_(targetMarginPct, TARGET_MARGIN_PCT) / 100, 0.01, 0.95);
  return round_(cost / (1 - margin), 2);
}

/** Gross margin percent at a given retail price. Returns null if cost is 0. */
function marginPct_(costPerKg, retailPerKg) {
  var cost = toNumberOr_(costPerKg, 0);
  var retail = toNumberOr_(retailPerKg, 0);
  if (cost <= 0 || retail <= 0) { return null; }
  return round_(100 * (retail - cost) / retail, 2);
}

/**
 * Cost-to-retail ratio expressed as a percentage.
 * The sourcing decision rule is stated on this measure because it is the one
 * that survives a change in either input: a rupee margin can look healthy on
 * a cheap SKU and impossible on an expensive one.
 */
function costToRetailPct_(costPerKg, retailPerKg) {
  var cost = toNumberOr_(costPerKg, 0);
  var retail = toNumberOr_(retailPerKg, 0);
  if (cost <= 0 || retail <= 0) { return null; }
  return round_(100 * cost / retail, 2);
}

/** Estimated shelf life in days, adjusting for collection-slot distance. */
function estimatedShelfLifeDays_(commodity, distanceKm) {
  var base = COMMODITY_SHELF_LIFE_DAYS[commodity];
  if (base === undefined) { base = 7; }
  // Roughly one day of life lost per 40 km of unprotected transit.
  var transitPenalty = toNumberOr_(distanceKm, 0) / 40;
  return Math.max(1, Math.round(base - transitPenalty));
}

/** Format a date for a spreadsheet cell. */
function formatDate_(date) {
  if (!date) { return ''; }
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** ISO week-start (Monday) for a date. */
function weekStart_(date) {
  var d = new Date(date);
  var day = d.getDay();               // 0 = Sunday
  var offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}
