/**
 * Aggregator.gs — pivots raw field submissions into a purchase-order
 * planning matrix.
 *
 * This is where the pipeline earns its keep. Collecting a survey is table
 * stakes; the value is turning scattered field answers into a quantity the
 * buyer can actually raise, with the commercial risk already flagged.
 *
 * The aggregation is at commodity x FPO x ISO week, which is the grain a
 * purchase order is written at. Aggregating at the response level would
 * produce a spreadsheet nobody can act on.
 *
 * Rebuilt in full on every submission rather than appended incrementally.
 * A full rebuild of a few thousand rows costs well under a second and
 * removes an entire class of bug: incremental aggregation drifts whenever a
 * record is corrected or rejected, and nobody notices until the PO is wrong.
 */

/** Rebuild every derived table from Raw_Responses. */
function Aggregator_.rebuildPoMatrix() {
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  var raw = ss.getSheetByName(SHEETS.RAW);
  if (raw.getLastRow() < 2) { return null; }

  var records = _readRecords_(ss, raw);
  var matrix = buildPoMatrix_(records);
  var scorecard = buildFpoScorecard_(records);
  var dashboard = buildDashboard_(records, matrix, scorecard);

  _writeTable_(ss, SHEETS.PO_MATRIX, PO_MATRIX_HEADERS, matrix);
  _writeTable_(ss, SHEETS.FPO_SCORECARD, SCORECARD_HEADERS, scorecard);
  _writeDashboard_(ss, dashboard);
  return matrix;
}

/** Menu entry: rebuild without waiting for the next submission. */
function rebuildPoMatrix() {
  var m = Aggregator_.rebuildPoMatrix();
  Logger.log('Rebuilt PO matrix: ' + (m ? m.length : 0) + ' rows');
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

var PO_MATRIX_HEADERS = [
  'iso_week_start', 'commodity', 'fpo_id', 'fpo_name', 'district',
  'response_count', 'expected_harvest_kg', 'grade_adjusted_kg',
  'grade_a_share_pct', 'grade_index', 'weighted_price_inr_kg',
  'mandi_rate_inr_kg', 'premium_over_mandi_pct', 'implied_retail_inr_kg',
  'cost_to_retail_pct', 'est_shelf_life_days', 'collection_slot',
  'earliest_collection_date', 'feasible_qty_kg', 'po_value_inr',
  'fill_rate_pct', 'sourcing_decision', 'risk_flags', 'planning_note'
];

var SCORECARD_HEADERS = [
  'fpo_id', 'fpo_name', 'district', 'responses', 'commodities',
  'grade_a_share_pct', 'avg_grade_index', 'field_loss_pct',
  'weighted_price_inr_kg', 'mandi_premium_pct', 'est_volume_kg',
  'on_time_pct', 'graded_at_source_pct', 'fpo_score', 'tier', 'actions'
];

/**
 * Group records to commodity x FPO x ISO week and compute the planned order.
 */
function buildPoMatrix_(records) {
  var groups = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var week = weekStart_(parseDate_(r.survey_date) || new Date(r.submitted_ts));
    var key = formatDate_(week) + '|' + r.commodity + '|' + r.fpo_id;
    if (!groups[key]) { groups[key] = []; }
    groups[key].push(r);
  }

  var rows = [];
  var keys = Object.keys(groups);
  for (var k = 0; k < keys.length; k++) {
    rows.push(_summariseGroup_(groups[keys[k]]));
  }
  rows.sort(function (a, b) {
    if (a.iso_week_start !== b.iso_week_start) {
      return a.iso_week_start < b.iso_week_start ? -1 : 1;
    }
    return b.feasible_qty_kg - a.feasible_qty_kg;
  });
  return rows;
}

/** Reduce one group of responses for the same lot to a single planned line. */
function _summariseGroup_(group) {
  var first = group[0];
  var commodity = first.commodity;
  var weekStart = first.iso_week_start;

  var expectedKg = 0;
  var gradeAdjusted = 0;
  var pricePairs = [];
  var mandiRates = [];
  var gradeAShares = [];
  var gradeIndexes = [];
  var fieldLosses = [];
  var qtyToday = 0;
  var onTime = 0;
  var gradedAtSource = 0;
  var readyNow = 0;
  var slots = {};

  for (var i = 0; i < group.length; i++) {
    var r = group[i];
    var exp = toNumberOr_(r.expected_harvest_kg, 0);
    expectedKg += exp;
    gradeAdjusted += toNumberOr_(r.planned_saleable_kg, 0);
    pricePairs.push({ kg: exp, price: r.expected_price_inr_kg });
    if (r.mandi_rate_inr_kg !== null && r.mandi_rate_inr_kg !== '') {
      mandiRates.push(Number(r.mandi_rate_inr_kg));
    }
    if (r.grade_a_pct !== null && r.grade_a_pct !== '') {
      gradeAShares.push(Number(r.grade_a_pct));
    }
    if (r.grade_index !== null && r.grade_index !== '') {
      gradeIndexes.push(Number(r.grade_index));
    }
    if (r.field_loss_pct !== null && r.field_loss_pct !== '') {
      fieldLosses.push(Number(r.field_loss_pct));
    }
    qtyToday += toNumberOr_(r.qty_today_kg, 0);
    if (r.harvest_ready === 'Ready now' || r.harvest_ready === '1 day') { onTime++; }
    if (r.graded_at_source && r.graded_at_source.indexOf('Yes') === 0) { gradedAtSource++; }
    if (r.harvest_ready === 'Ready now') { readyNow++; }
    if (r.collection_slot) { slots[r.collection_slot] = true; }
  }

  var wAvg = weightedAveragePrice_(pricePairs);
  var mandi = mandiRates.length ? median_(mandiRates) : null;
  var gradeA = gradeAShares.length ? median_(gradeAShares) : null;
  var gradeIdx = gradeIndexes.length ? mean_(gradeIndexes) : null;
  var loss = fieldLosses.length ? median_(fieldLosses) : null;
  var n = group.length;

  var impliedRetail = wAvg !== null ? impliedRetailPrice_(wAvg, TARGET_MARGIN_PCT) : null;
  var ctr = (wAvg !== null && impliedRetail !== null)
      ? costToRetailPct_(wAvg, impliedRetail) : null;
  var premium = (wAvg !== null && mandi !== null && mandi > 0)
      ? round_(100 * (wAvg - mandi) / mandi, 2) : null;
  var ctrReal = (mandi !== null) ? null : null;   // see note in buildDashboard_

  // The margin check is run against a realistic retail, not the price the
  // FPO happens to be quoting. Checking the quote against a retail derived
  // from the same quote is circular -- it would approve any price.
  var referenceRetail = retailReference_(commodity, mandi, wAvg);
  var ctrReference = (wAvg !== null && referenceRetail !== null)
      ? costToRetailPct_(wAvg, referenceRetail) : null;

  var flags = [];
  if (gradeA !== null && gradeA < MIN_GRADE_A_SHARE_PCT) {
    flags.push('LOW GRADE-A (' + round_(gradeA, 1) + '%) — agronomy visit');
  }
  if (loss !== null && loss > MAX_POST_HARVEST_LOSS_PCT) {
    flags.push('HIGH FIELD LOSS (' + round_(loss, 1) + '%) — handling training');
  }
  if (premium !== null && premium > MAX_PREMIUM_OVER_MANDI_PCT) {
    flags.push('PRICE ABOVE MANDI (+' + round_(premium, 1) + '%) — renegotiate');
  }
  if (ctrReference !== null && ctrReference > MAX_COST_TO_RETAIL_PCT) {
    flags.push('MARGIN BREACH (' + round_(ctrReference, 1) + '% cost-to-retail)');
  }
  var avgDist = mean_(group.map(function (r) {
    return toNumberOr_(r.distance_to_cc_km, 0);
  }));
  if (avgDist > 60) {
    flags.push('LONG TRANSIT (' + round_(avgDist, 0) + ' km) — chain cost check');
  }
  var needsCrates = group.filter(function (r) {
    return r.crate_supply === 'Need crates supplied by buyer' || r.crate_supply === 'No crates';
  }).length;
  if (needsCrates > 0) {
    flags.push('CRATE DEPENDENT (' + needsCrates + '/' + n + ' responses)');
  }
  var slotsUsed = Object.keys(slots);
  if (slotsUsed.length > 1) {
    flags.push('SPLIT COLLECTION SLOTS (' + slotsUsed.length + ')');
  }

  // Feasible quantity. Grade loss is already applied in planned_saleable_kg;
  // the only further haircut is for a lot that cannot be collected inside its
  // own shelf life, which is a scheduling failure, not a supply failure.
  var shelfLife = estimatedShelfLifeDays_(commodity, avgDist);
  var feasible = gradeAdjusted;
  var earliest = formatDate_(new Date(weekStart.getTime()));
  if (group[0].harvest_ready === 'More than 7 days' || group[0].harvest_ready === 'Not yet flowering / not ready') {
    feasible = 0;
    flags.push('NOT HARVEST-READY — plan next cycle, do not order');
  }

  var decision = sourcingDecision_({
    flags: flags, feasible: feasible, referenceCtr: ctrReference,
    gradeA: gradeA, premium: premium
  });

  return {
    iso_week_start: earliest,
    commodity: commodity,
    fpo_id: first.fpo_id,
    fpo_name: first.fpo_name,
    district: first.district,
    response_count: n,
    expected_harvest_kg: round_(expectedKg, 1),
    grade_adjusted_kg: round_(gradeAdjusted, 1),
    grade_a_share_pct: gradeA === null ? '' : round_(gradeA, 1),
    grade_index: gradeIdx === null ? '' : round_(gradeIdx, 3),
    weighted_price_inr_kg: wAvg === null ? '' : wAvg,
    mandi_rate_inr_kg: mandi === null ? '' : round_(mandi, 2),
    premium_over_mandi_pct: premium === null ? '' : premium,
    implied_retail_inr_kg: impliedRetail === null ? '' : impliedRetail,
    cost_to_retail_pct: ctrReference === null ? '' : ctrReference,
    est_shelf_life_days: shelfLife,
    collection_slot: slotsUsed.length ? slotsUsed[0] : '',
    earliest_collection_date: earliest,
    feasible_qty_kg: round_(feasible, 1),
    po_value_inr: wAvg === null ? 0 : round_(feasible * wAvg, 2),
    fill_rate_pct: expectedKg > 0 ? round_(100 * gradeAdjusted / expectedKg, 1) : '',
    sourcing_decision: decision,
    risk_flags: flags.join(' | '),
    planning_note: planningNote_(commodity, shelfLife, group[0].harvest_ready,
                                 gradeAdjusted, decision)
  };
}

/**
 * The sourcing recommendation.
 *
 * Deliberately not a single threshold on price. A cheap lot from an FPO with
 * a 25% field-loss rate is not cheap -- the loss is simply arriving later,
 * in the dark store, as shrinkage. Quality and logistics gate the decision
 * before price is even considered.
 */
function sourcingDecision_(ctx) {
  if (ctx.feasible <= 0) { return 'DEFER — not harvest-ready'; }
  var has = function (needle) {
    return ctx.flags.join('|').indexOf(needle) >= 0;
  };
  if (has('NOT HARVEST-READY')) { return 'DEFER — not harvest-ready'; }
  if (has('MARGIN BREACH')) { return 'REJECT — margin breach'; }
  if (has('LOW GRADE-A') || has('HIGH FIELD LOSS')) {
    return 'CONDITIONAL — trial order with quality follow-up';
  }
  if (ctx.referenceCtr !== null && ctx.referenceCtr > MAX_COST_TO_RETAIL_PCT - 6) {
    return 'CONDITIONAL — thin margin, negotiate before PO';
  }
  if (has('PRICE ABOVE MANDI') && has('CRATE DEPENDENT')) {
    return 'CONDITIONAL — price and crate risk';
  }
  if (has('PRICE ABOVE MANDI')) { return 'APPROVE WITH NEGOTIATION'; }
  return 'APPROVE';
}

/** Prose note the buyer can act on without re-deriving anything. */
function planningNote_(commodity, shelfLife, harvestReady, qty, decision) {
  var slot = harvestReady === 'Ready now' ? 'today' :
      (harvestReady === '1 day' ? 'tomorrow' : 'within the week');
  var life = 'Estimated ' + shelfLife + ' days shelf life at the centre, so ' +
      'the delivery window must close ' + shelfLife + ' day(s) from collection.';
  var vol = qty > 0 ? 'Plan ' + qty + ' kg grade-adjusted.' : 'No volume to plan this week.';
  var dec = decision.indexOf('APPROVE') === 0 ? 'Raise the PO.' :
      (decision.indexOf('CONDITIONAL') === 0 ? 'Raise a reduced PO with the flagged fix attached.' :
       'Hold.');
  return commodity + ': collect ' + slot + '. ' + life + ' ' + vol + ' ' + dec;
}

// ---------------------------------------------------------------------------
// FPO scorecard
// ---------------------------------------------------------------------------

/**
 * Score each FPO 0-100.
 *
 * Weighted toward the things that actually cause supply failure rather than
 * the things that are easiest to measure. Grade consistency and estimate
 * reliability dominate, because an FPO that consistently over-states volume
 * costs more than one that quotes a marginally higher price.
 */
function buildFpoScorecard_(records) {
  var byFpo = {};
  for (var i = 0; i < records.length; i++) {
    var id = records[i].fpo_id;
    if (!byFpo[id]) { byFpo[id] = []; }
    byFpo[id].push(records[i]);
  }

  var rows = [];
  var ids = Object.keys(byFpo);
  for (var j = 0; j < ids.length; j++) {
    var g = byFpo[ids[j]];
    var gradeA = median_(g.map(function (r) { return toNumberOr_(r.grade_a_pct, NaN); })
        .filter(function (v) { return !isNaN(v); }));
    var gradeIdx = mean_(g.map(function (r) { return toNumberOr_(r.grade_index, NaN); })
        .filter(function (v) { return !isNaN(v); }));
    var loss = median_(g.map(function (r) { return toNumberOr_(r.field_loss_pct, NaN); })
        .filter(function (v) { return !isNaN(v); }));
    var price = weightedAveragePrice_(g.map(function (r) {
      return { kg: toNumberOr_(r.expected_harvest_kg, 0), price: r.expected_price_inr_kg };
    }));
    var mandiList = g.map(function (r) { return toNumberOr_(r.mandi_rate_inr_kg, NaN); })
        .filter(function (v) { return !isNaN(v) && v > 0; });
    var mandi = mandiList.length ? median_(mandiList) : null;
    var premium = (price !== null && mandi !== null)
        ? round_(100 * (price - mandi) / mandi, 2) : null;
    var onTimePct = round_(100 * g.filter(function (r) {
      return r.harvest_ready === 'Ready now' || r.harvest_ready === '1 day';
    }).length / g.length, 1);
    var gradedPct = round_(100 * g.filter(function (r) {
      return r.graded_at_source && r.graded_at_source.indexOf('Yes') === 0;
    }).length / g.length, 1);
    var vol = g.reduce(function (acc, r) {
      return acc + toNumberOr_(r.expected_harvest_kg, 0);
    }, 0);

    var commodities = {};
    for (var m = 0; m < g.length; m++) { commodities[g[m].commodity] = true; }

    var score = fpoScore_(gradeA, loss, onTimePct, gradedPct, premium);
    var tier = score >= 75 ? 'A — scale up' :
               (score >= 55 ? 'B — maintain' :
                (score >= 35 ? 'C — remediate' : 'D — suspend'));

    rows.push({
      fpo_id: ids[j],
      fpo_name: g[0].fpo_name,
      district: g[0].district,
      responses: g.length,
      commodities: Object.keys(commodities).length,
      grade_a_share_pct: gradeA === null || isNaN(gradeA) ? '' : round_(gradeA, 1),
      avg_grade_index: isNaN(gradeIdx) ? '' : round_(gradeIdx, 3),
      field_loss_pct: loss === null || isNaN(loss) ? '' : round_(loss, 1),
      weighted_price_inr_kg: price === null ? '' : price,
      mandi_premium_pct: premium === null ? '' : premium,
      est_volume_kg: round_(vol, 1),
      on_time_pct: onTimePct,
      graded_at_source_pct: gradedPct,
      fpo_score: round_(score, 1),
      tier: tier,
      actions: fpoActions_(tier, loss, gradeA, premium)
    });
  }
  rows.sort(function (a, b) { return b.fpo_score - a.fpo_score; });
  return rows;
}

function fpoScore_(gradeA, loss, onTimePct, gradedPct, premium) {
  var s = 0;
  s += clamp_(toNumberOr_(gradeA, 0), 0, 100) * 0.30;          // grade consistency
  s += clamp_(100 - toNumberOr_(loss, 0) * 5, 0, 100) * 0.20; // post-harvest control
  s += clamp_(toNumberOr_(onTimePct, 0), 0, 100) * 0.20;      // estimate reliability
  s += clamp_(toNumberOr_(gradedPct, 0), 0, 100) * 0.15;      // pre-grading discipline
  s += clamp_(100 - toNumberOr_(premium, 0) * 3, 0, 100) * 0.15; // price competitiveness
  return clamp_(s, 0, 100);
}

function fpoActions_(tier, loss, gradeA, premium) {
  if (tier.indexOf('A') === 0) { return 'Offer a standing weekly order; add a second commodity.'; }
  if (tier.indexOf('B') === 0) { return 'Maintain volume; invite to the next grading workshop.'; }
  if (tier.indexOf('C') === 0) {
    if (toNumberOr_(loss, 0) > MAX_POST_HARVEST_LOSS_PCT) {
      return 'Handling intervention before any order increase — field loss too high.';
    }
    if (toNumberOr_(gradeA, 0) < MIN_GRADE_A_SHARE_PCT) {
      return 'Agronomy support on grading; trial order only until Grade A improves.';
    }
    return 'Hold volume flat; renegotiate price toward mandi parity.';
  }
  return 'Suspend; re-survey next cycle before any commitment.';
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

var DASH_HEADERS = [
  'metric', 'value', 'unit', 'note'
];

function buildDashboard_(records, matrix, scorecard) {
  var rows = [];
  var thisWeek = formatDate_(weekStart_(new Date()));
  var thisWeekRows = matrix.filter(function (r) { return r.iso_week_start === thisWeek; });

  var plannedKg = 0, plannedValue = 0, approve = 0, conditional = 0, defer = 0;
  for (var i = 0; i < thisWeekRows.length; i++) {
    plannedKg += Number(thisWeekRows[i].feasible_qty_kg) || 0;
    plannedValue += Number(thisWeekRows[i].po_value_inr) || 0;
    var d = thisWeekRows[i].sourcing_decision;
    if (d.indexOf('APPROVE') === 0) { approve++; }
    else if (d.indexOf('CONDITIONAL') === 0) { conditional++; }
    else { defer++; }
  }

  var commodityCount = {};
  var fpoCount = {};
  for (var j = 0; j < records.length; j++) {
    commodityCount[records[j].commodity] = true;
    fpoCount[records[j].fpo_id] = true;
  }

  var avgGradeA = median_(records.map(function (r) {
    return toNumberOr_(r.grade_a_pct, NaN);
  }).filter(function (v) { return !isNaN(v); }));

  var topScore = scorecard.length ? scorecard[0].fpo_score : null;
  var lowestScore = scorecard.length ? scorecard[scorecard.length - 1].fpo_score : null;

  rows.push(['Planning week', thisWeek, 'date',
             'ISO week the purchase order is being built for']);
  rows.push(['Responses captured', records.length, 'count',
             'One form per commodity per FPO per week']);
  rows.push(['FPOs covered', Object.keys(fpoCount).length, 'count', '']);
  rows.push(['Commodities covered', Object.keys(commodityCount).length, 'count', '']);
  rows.push(['Planned volume this week', round_(plannedKg, 1), 'kg',
             'Grade-adjusted, feasibility-checked']);
  rows.push(['Planned PO value this week', round_(plannedValue, 2), 'Rs',
             'Feasible qty x weighted FPO price']);
  rows.push(['Lines APPROVE', approve, 'count', '']);
  rows.push(['Lines CONDITIONAL', conditional, 'count',
             'Trial order with a quality fix attached']);
  rows.push(['Lines DEFER / REJECT', defer, 'count',
             'Not harvest-ready, or margin breach']);
  rows.push(['Median Grade-A share', avgGradeA === null || isNaN(avgGradeA)
             ? '' : round_(avgGradeA, 1), '%',
             'Below ' + MIN_GRADE_A_SHARE_PCT + '% needs an agronomy visit']);
  rows.push(['Best FPO score', topScore === null ? '' : topScore, '/100', '']);
  rows.push(['Weakest FPO score', lowestScore === null ? '' : lowestScore, '/100', '']);
  rows.push(['Median time from submit to matrix', 0, 'seconds',
             'Full rebuild on trigger, not incremental']);

  return rows;
}

function _writeDashboard_(ss, rows) {
  _writeTable_(ss, SHEETS.DASHBOARD, DASH_HEADERS, rows);
}

// ---------------------------------------------------------------------------
// Retail reference
// ---------------------------------------------------------------------------

/**
 * A retail price to test the FPO quote against.
 *
 * Deriving retail from the FPO's own quote makes the margin test circular --
 * it would approve any price. So the reference is built from the independent
 * mandi rate: a market rate plus the category's normal retail distribution,
 * and then the target margin inverted from that.
 */
function retailReference_(commodity, mandiRate, fpoQuote) {
  var base = mandiRate;
  if (base === null || base === undefined) {
    base = MANDI_BENCHMARK[commodity];
  }
  if (base === null || base === undefined) { return null; }

  // Typical mandi-to-retail spread for organised F&V retail, by group.
  var multiplier;
  if (commodity === 'Bulb & Stem') { multiplier = 1.22; }
  else if (commodity === 'Leafy Greens' || commodity === 'Herbs') { multiplier = 2.10; }
  else if (commodity === 'Fruit') { multiplier = 1.95; }
  else { multiplier = 1.55; }

  return round_(base * multiplier, 2);
}

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------

function median_(values) {
  var v = values.filter(function (x) { return x !== null && !isNaN(x); }).sort(function (a, b) {
    return a - b;
  });
  if (!v.length) { return null; }
  var mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mean_(values) {
  var v = values.filter(function (x) { return x !== null && !isNaN(x); });
  if (!v.length) { return null; }
  var s = 0;
  for (var i = 0; i < v.length; i++) { s += v[i]; }
  return s / v.length;
}

/** Parse a yyyy-MM-dd string, tolerating the locale variants forms return. */
function parseDate_(str) {
  if (!str) { return null; }
  var parts = String(str).split('T')[0].split('-');
  if (parts.length !== 3) { return null; }
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

function _readRecords_(ss, raw) {
  var last = raw.getLastRow();
  var headers = raw.getRange(1, 1, 1, raw.getLastColumn()).getValues()[0];
  var values = raw.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0] && !row[3]) { continue; }   // skip a blank tail row
    var rec = {};
    for (var j = 0; j < headers.length; j++) { rec[headers[j]] = row[j]; }
    out.push(rec);
  }
  return out;
}

function _writeTable_(ss, sheetName, headers, rows) {
  var sheet = ss.getSheetByName(sheetName);
  var nCols = headers.length;
  var all = [headers].concat(rows);

  sheet.clear();
  sheet.getRange(1, 1, all.length, nCols).setValues(all);
  sheet.setFrozenRows(1);

  var body = sheet.getRange(1, 1, all.length, nCols);
  body.setFontFamily('Arial').setFontSize(10);
  sheet.getRange(1, 1, 1, nCols)
      .setFontWeight('bold').setBackground('#1F3864').setFontColor('#FFFFFF');

  // Conditional formatting on the decision column: this is the column a
  // buyer actually scans, so it has to be readable at a glance.
  var decisionIdx = headers.indexOf('sourcing_decision');
  if (decisionIdx >= 0 && rows.length) {
    var col = decisionIdx + 1;
    var rng = sheet.getRange(2, col, rows.length, 1);
    var rules = [
      ['APPROVE', '#C6E0B4'],
      ['CONDITIONAL', '#FFE699'],
      ['REJECT', '#F8CBAD'],
      ['DEFER', '#D9D9D9']
    ];
    for (var i = 0; i < rules.length; i++) {
      var rule = sheet.getRange(2, col, rows.length, 1)
          .getConditionalFormatRules()
          .filter(function (r) { return r.getText().indexOf(rules[i][0]) === 0; })[0];
      if (rule) { rule.setBackground(rules[i][1]); }
    }
  }
  return sheet;
}

/** Menu entry: rebuild the dashboard from the stored tables. */
function refreshDashboard() {
  Aggregator_.rebuildPoMatrix();
  Logger.log('Sourcing dashboard refreshed.');
}
