/**
 * TriggerHandler.gs — the form-bound onFormSubmit handler.
 *
 * Context matters here and is the single most common source of failure in
 * this pattern. There are two different trigger contexts:
 *
 *   form-bound   (installed from the Form's script editor)
 *                -> the event carries e.response, a FormResponse.
 *                   THIS is the context this handler expects.
 *
 *   sheet-bound  (installed from the Spreadsheet's script editor)
 *                -> the event carries e.values and e.namedValues, and
 *                   e.response is undefined.
 *
 * If this function is installed from the wrong place it does not error on
 * the first line -- it errors later, on the first e.response access, with
 * "Cannot read properties of undefined", and only after a real submission
 * has been lost. installTrigger() below therefore installs it from the form
 * and asserts the resulting trigger's event source is the form.
 *
 * A second constraint: this must be an INSTALLABLE trigger, not a simple
 * trigger. Simple triggers cannot access SpreadsheetApp reliably, and a
 * failure inside a trigger is invisible to the person who submitted the
 * form -- so every failure path is caught and written to the log sheet.
 */

/** The handler. */
function onFormSubmit(e) {
  if (!e || !e.response) {
    // Wrong trigger context. Recording this explicitly turns a silent
    // downstream failure into one actionable line in the log.
    _log_('FATAL: onFormSubmit fired without e.response. The trigger is ' +
          'sheet-bound; it must be installed from the Form, not the Sheet.');
    return;
  }

  var response = e.response;
  var items = response.getItemResponses();

  try {
    var record = extractRecord_(items, response.getTimestamp());

    // Validate before writing. A malformed row in Raw_Responses poisons
    // every downstream aggregate, and the aggregate is the thing people
    // actually read.
    var problems = validate_(record);
    if (problems.length) {
      _writeValidationLog_(record, problems);
      return;
    }

    _appendRaw_(record);
    Aggregator_.rebuildPoMatrix();
    logSubmit_('OK', record, '');
  } catch (err) {
    _writeValidationLog_(record || { fpo_id: '?', commodity: '?' },
                         ['UNHANDLED: ' + err.message + ' @ ' + (err.stack || '')]);
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Turn a form submission into a flat record.
 *
 * Answers are read by question *title* rather than by position. Positional
 * reads break the moment anyone reorders the form; a documented title is
 * readable, diffable, and fails loudly instead of silently.
 */
function extractRecord_(itemResponses, submittedAt) {
  var q = function (key) { return readAnswer_(itemResponses, QUESTIONS[key]); };

  var gradeA = toNumber_(q('GRADE_A_PCT'));
  var gradeB = toNumber_(q('GRADE_B_PCT'));
  var gradeC = toNumber_(q('GRADE_C_PCT'));
  var fieldLoss = toNumber_(q('POST_HARVEST_LOSS_PCT'));

  var expectedKg = toNumber_(q('EXPECTED_HARVEST_KG'));
  var gradeIdx = gradeIndex_(gradeA, gradeB, gradeC);
  var commodity = q('COMMODITY');
  var confidence = q('ESTIMATE_CONFIDENCE');
  var distanceKm = toNumber_(q('DISTANCE_TO_CC_KM'));

  var saleable = saleableQuantity_(
    expectedKg, commodity, gradeIdx, confidence, fieldLoss);

  var expectedPrice = toNumber_(q('EXPECTED_PRICE_PER_KG'));
  var mandiToday = toNumber_(q('MANDI_RATE_TODAY'));
  var premiumPct = null;
  if (expectedPrice !== null && mandiToday !== null && mandiToday > 0) {
    premiumPct = round_(100 * (expectedPrice - mandiToday) / mandiToday, 2);
  }

  var shelfLife = estimatedShelfLifeDays_(commodity, distanceKm);
  var retailNeeded = impliedRetailPrice_(expectedPrice, TARGET_MARGIN_PCT);

  return {
    submitted_at: formatDate_(submittedAt),
    submitted_ts: submittedAt.getTime(),
    survey_date: q('SURVEY_DATE'),
    agent_name: q('AGENT_NAME'),
    agent_id: q('AGENT_ID'),
    fpo_name: q('FPO_NAME'),
    fpo_id: q('FPO_ID'),
    district: q('DISTRICT'),
    village: q('VILLAGE'),
    gps_lat: q('GPS_LAT'),
    gps_lng: q('GPS_LNG'),
    weather_48h: q('WEATHER_48H'),
    commodity: commodity,
    variety: q('VARIETY'),
    harvest_ready: q('HARVEST_READY_DAYS'),
    expected_harvest_kg: expectedKg,
    expected_next_week_kg: toNumber_(q('EXPECTED_HARVEST_KG_NEXT')),
    harvest_method: q('HARVEST_METHOD'),
    irrigation: q('IRRIGATION'),
    confidence: confidence,
    grade_a_pct: gradeA,
    grade_b_pct: gradeB,
    grade_c_pct: gradeC,
    grade_index: round_(gradeIdx, 4),
    graded_at_source: q('GRADING_DONE_AT_SOURCE'),
    field_photo: q('FIELD_PHOTO'),
    field_loss_pct: fieldLoss,
    pest_issues: q('PEST_ISSUES'),
    expected_price_inr_kg: expectedPrice,
    mandi_rate_inr_kg: mandiToday,
    premium_over_mandi_pct: premiumPct,
    price_basis: q('PRICE_BASIS'),
    min_acceptable_price: toNumber_(q('MIN_ACCEPTABLE_PRICE')),
    payment_terms: q('PAYMENT_TERMS'),
    transport_owned: q('TRANSPORT_OWNED'),
    collection_slot: q('COLLECTION_SLOT'),
    qty_today_kg: toNumber_(q('QTY_AVAILABLE_FOR_PICKUP')),
    crate_supply: q('CRATE_SUPPLY'),
    cold_chain: q('COLD_CHAIN_AVAILABLE'),
    distance_to_cc_km: distanceKm,
    est_shelf_life_days: shelfLife,
    planned_saleable_kg: saleable,
    retail_needed_for_target: retailNeeded,
    remarks: q('REMARKS')
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Field-level checks that stop a bad row reaching the aggregate.
 *
 * The grade-share check is the important one. Three shares summing to 130%
 * is a real and common transcription error on a phone, and it silently
 * produces a grade index above 1.0 — an FPO that looks better than perfect.
 */
function validate_(r) {
  var problems = [];

  if (!r.fpo_id) { problems.push('Missing FPO ID'); }
  if (!r.commodity) { problems.push('Missing commodity'); }
  if (!r.district) { problems.push('Missing district'); }

  var a = r.grade_a_pct, b = r.grade_b_pct, c = r.grade_c_pct;
  if (a === null || b === null || c === null) {
    problems.push('Incomplete grade split');
  } else {
    var total = a + b + c;
    if (total < 90 || total > 110) {
      problems.push('Grade shares sum to ' + round_(total, 1) +
                    '% (expected 100% +/- 10)');
    }
    if (r.grade_index > 1.001) {
      problems.push('Grade index above 1.0 — grade shares are inconsistent');
    }
  }

  if (!r.expected_harvest_kg || r.expected_harvest_kg <= 0) {
    problems.push('Missing or non-positive harvest estimate');
  } else if (r.expected_harvest_kg > 1000000) {
    problems.push('Harvest estimate above 1,000 t — check the unit');
  }

  if (!r.expected_price_inr_kg || r.expected_price_inr_kg <= 0) {
    problems.push('Missing or non-positive expected price');
  }

  if (r.distance_to_cc_km === null || r.distance_to_cc_km < 0) {
    problems.push('Missing or invalid distance to collection centre');
  } else if (r.distance_to_cc_km > 500) {
    problems.push('Distance over 500 km — check whether this cluster is servable');
  }

  if (!r.collection_slot) { problems.push('Missing collection slot'); }

  return problems;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

var RAW_HEADERS = [
  'submitted_at', 'survey_date', 'agent_name', 'agent_id', 'fpo_name', 'fpo_id',
  'district', 'village', 'gps_lat', 'gps_lng', 'weather_48h',
  'commodity', 'variety', 'harvest_ready', 'expected_harvest_kg',
  'expected_next_week_kg', 'harvest_method', 'irrigation', 'confidence',
  'grade_a_pct', 'grade_b_pct', 'grade_c_pct', 'grade_index',
  'graded_at_source', 'field_photo', 'field_loss_pct', 'pest_issues',
  'expected_price_inr_kg', 'mandi_rate_inr_kg', 'premium_over_mandi_pct',
  'price_basis', 'min_acceptable_price', 'payment_terms', 'transport_owned',
  'collection_slot', 'qty_today_kg', 'crate_supply', 'cold_chain',
  'distance_to_cc_km', 'est_shelf_life_days', 'planned_saleable_kg',
  'retail_needed_for_target', 'remarks'
];

function _appendRaw_(r) {
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  var sheet = ss.getSheetByName(SHEETS.RAW);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, RAW_HEADERS.length).setValues([RAW_HEADERS]);
    sheet.setFrozenRows(1);
  }
  var row = RAW_HEADERS.map(function (h) {
    var v = r[h];
    return (v === null || v === undefined) ? '' : v;
  });
  sheet.appendRow(row);
}

function _writeValidationLog_(r, problems) {
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  var sheet = ss.getSheetByName(SHEETS.VALIDATION_LOG);
  sheet.appendRow([
    new Date(),
    'REJECTED',
    (r.fpo_id || '') + ' / ' + (r.commodity || ''),
    problems.join(' | ')
  ]);
  Logger.log('Rejected submission: ' + problems.join('; '));
}

/** Human-readable one-line outcome, for the log sheet's INFO rows. */
function logSubmit_(status, r, note) {
  _log_(status + ': ' + r.fpo_id + ' / ' + r.commodity + ' -> ' +
        r.planned_saleable_kg + ' kg planned at Rs ' +
        r.expected_price_inr_kg + (note ? ' (' + note + ')' : ''));
}

// ---------------------------------------------------------------------------
// Trigger installation
// ---------------------------------------------------------------------------

/**
 * Install the onFormSubmit trigger from the FORM, not the spreadsheet.
 * Asserts the event source afterwards, because getting this wrong produces a
 * failure that only shows up after a real submission is lost.
 */
function installTrigger() {
  var form = _findExistingForm_();
  if (!form) {
    throw new Error('No built form found. Run buildSurvey() first.');
  }

  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  var trigger = ScriptApp.newTrigger('onFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('Installed form-bound trigger ' + trigger.getUniqueId() +
              ' for form ' + form.getId());

  // Verify, rather than assume.
  var installed = ScriptApp.getProjectTriggers();
  for (var j = 0; j < installed.length; j++) {
    if (installed[j].getHandlerFunction() === 'onFormSubmit') {
      var src = installed[j].getTriggerSourceId();
      if (src !== form.getId()) {
        throw new Error('Trigger is bound to ' + src + ', not to the form ' +
                        form.getId() + '. Remove it and re-run.');
      }
      _log_('Verified form-bound onFormSubmit trigger for form ' + form.getId());
      return trigger;
    }
  }
  throw new Error('onFormSubmit trigger was not found after creation.');
}

/** Tail the validation log so a rejected submission is visible. */
function showSubmitLog() {
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  var sheet = ss.getSheetByName(SHEETS.VALIDATION_LOG);
  var last = Math.max(sheet.getLastRow(), 2);
  var start = Math.max(2, last - 24);
  var rows = sheet.getRange(start, 1, last - start + 1, 4).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    out.push([rows[i][0], rows[i][1], rows[i][2], rows[i][3]].join('  |  '));
  }
  Logger.log(out.join('\n'));
  SpreadsheetApp.getActive()
    ? SpreadsheetApp.getActive().toast(out.slice(-8).join('\n'), 'Submit log', 12)
    : null;
}

// ---------------------------------------------------------------------------
// Spreadsheet plumbing
// ---------------------------------------------------------------------------

function _openSpreadsheet_() {
  if (SPREADSHEET_ID.indexOf('REPLACE_WITH') === 0) {
    throw new Error('Set SPREADSHEET_ID in Config.gs to the tracking ' +
                    'workbook ID (the value between /d/ and /edit in its URL).');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function _ensureSheets_(ss) {
  var needed = [SHEETS.RAW, SHEETS.VALIDATION_LOG, SHEETS.PO_MATRIX,
                SHEETS.FPO_SCORECARD, SHEETS.COMMODITY_BENCHMARK, SHEETS.DASHBOARD];
  for (var i = 0; i < needed.length; i++) {
    if (!ss.getSheetByName(needed[i])) {
      ss.insertSheet(needed[i]);
    }
  }
  if (!ss.getSheetByName('Sheet1') && ss.getSheets().length > 1) {
    ss.deleteSheet(ss.getSheetByName('Sheet1'));
  }

  // Seed the benchmark table once, from the Oct-2026 reference rates in
  // Config. Overwrite it with live mandi rates each morning.
  var bench = ss.getSheetByName(SHEETS.COMMODITY_BENCHMARK);
  if (bench.getLastRow() === 0) {
    var rows = [['commodity', 'mandi_rate_inr_kg', 'as_of', 'source']];
    var today = Utilities.formatDate(new Date(),
                                     Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var keys = Object.keys(MANDI_BENCHMARK).sort();
    for (var j = 0; j < keys.length; j++) {
      rows.push([keys[j], MANDI_BENCHMARK[keys[j]], today,
                 'All-India reference, Oct 2026']);
    }
    bench.getRange(1, 1, rows.length, 4).setValues(rows);
    bench.setFrozenRows(1);
  }
}

/** Create the tracking workbook manually and print its ID. */
function setupSpreadsheet() {
  var ss = SpreadsheetApp.create('FPO Sourcing Tracking');
  _ensureSheets_(ss);
  var url = ss.getUrl();
  Logger.log('Created ' + url);
  Logger.log('Set SPREADSHEET_ID in Config.gs to: ' + ss.getId());
  return ss;
}
