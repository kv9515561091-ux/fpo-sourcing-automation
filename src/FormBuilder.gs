/**
 * FormBuilder.gs — builds the multi-section field survey.
 *
 * Five sections separated by page breaks, because a single scrolling page
 * makes a 30-field form unusable on a phone with patchy rural connectivity.
 * A field agent filling this on a ₹6,000 handset at the farm gate will
 * abandon it; page breaks let a partial response be a useful partial
 * response rather than a lost one.
 *
 * Every question title comes from Config.QUESTIONS, so the form and the
 * trigger's title matching cannot drift apart.
 */

/** All menu entries, in one place. */
function onOpen() {
  FormApp.getUi()
    .createMenu('FPO Sourcing Tools')
    .addItem('1. Build the field survey form', 'buildSurvey')
    .addItem('2. Create the tracking workbook', 'setupSpreadsheet')
    .addItem('3. Install the submit trigger', 'installTrigger')
    .addItem('4. Rebuild the PO planning matrix', 'rebuildPoMatrix')
    .addItem('5. Refresh the sourcing dashboard', 'refreshDashboard')
    .addItem('6. Show the submit-trigger log', 'showSubmitLog')
    .addToUi();
}

/**
 * Build the form. Destroys any previous version so re-running is safe --
 * an agent-facing form must never have two copies in circulation.
 */
function buildSurvey() {
  var existing = _findExistingForm_();
  if (existing) {
    var ui = FormApp.getUi();
    var answer = ui.alert(
      'Replace the existing form?',
      'A form named "' + existing.getName() + '" already exists and will be ' +
      'unlinked from its response sheet. Existing submissions are kept. Continue?',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) { return; }
    DriveApp.getFileById(existing.getId()).setTrashed(true);
  }

  var form = FormApp.create('FPO Field Sourcing Survey — Harvest, Quality & Price');
  form.setDescription(
    'Filed by a sourcing agent at the farm gate or collection centre. ' +
    'Takes about 4 minutes. ' +
    'All fields are used to plan next week\'s purchase order — please be as ' +
    'accurate as you can; an honest low estimate is more useful than an ' +
    'optimistic one.');
  form.setConfirmationMessage(
    'Thank you. Your submission has been logged and will be visible in the ' +
    'PO planning matrix within a minute. If the quantity turns out to be ' +
    'wrong, submit again with a note rather than editing — we need the ' +
    'history to see how reliable estimates are over time.');

  _sectionIdentity_(form);
  _sectionHarvest_(form);
  _sectionQuality_(form);
  _sectionPricing_(form);
  _sectionLogistics_(form);

  // Link the response sheet explicitly. The form and its sheet are separate
  // Drive objects, so this has to be done by ID.
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  form.setDestination(FormApp.newResponseDestination().setSpreadsheetId(ss.getId()));

  var url = form.getPublishedUrl();
  _log_('Built form: ' + form.getId() + ' -> ' + url);
  return form;
}

// ---------------------------------------------------------------------------
// Section 1 — identity
// ---------------------------------------------------------------------------
function _sectionIdentity_(form) {
  form.addPageBreakItem().setTitle('Section 1 of 5 — Who and where');

  form.addTextItem()
    .setTitle(QUESTIONS.AGENT_NAME).setRequired(true);
  form.addTextItem()
    .setTitle(QUESTIONS.AGENT_ID).setRequired(true);
  form.addTextItem()
    .setTitle(QUESTIONS.FPO_NAME).setRequired(true);
  form.addTextItem()
    .setTitle(QUESTIONS.FPO_ID).setRequired(true);

  var district = form.addTextItem().setTitle(QUESTIONS.DISTRICT).setRequired(true);
  district.setHelpText('District of the farm, not of the collection centre.');

  form.addTextItem().setTitle(QUESTIONS.VILLAGE);

  // Paired coordinates. A single "location" field fails on older Android
  // builds that do not expose the geolocation API to forms, so the agent can
  // type the numbers read off their own phone instead.
  var lat = form.addTextItem()
    .setTitle(QUESTIONS.GPS_LAT)
    .setHelpText('Decimal degrees, e.g. 12.9716. Optional but it is how we ' +
                 'verify a new cluster is where it claims to be.')
    .setValidation(FormApp.createTextValidation()
      .setTextInputType(FormApp.TextInputType.NUMBER)
      .setRequired(false)
      .build());
  var lng = form.addTextItem()
    .setTitle(QUESTIONS.GPS_LNG)
    .setHelpText('Decimal degrees, e.g. 77.5946.')
    .setValidation(FormApp.createTextValidation()
      .setTextInputType(FormApp.TextInputType.NUMBER)
      .setRequired(false)
      .build());

  var dateItem = form.addDateItem().setTitle(QUESTIONS.SURVEY_DATE).setRequired(true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.WEATHER_48H)
    .setHelpText('Rain or heat in the next 48 hours changes both the harvest ' +
                 'window and the transit risk, so it drives the collection slot.')
    .setChoices(['Dry and cool', 'Dry and hot', 'Light rain likely',
                 'Heavy rain likely', 'Storm / extreme heat warning'])
    .setRequired(true);
}

// ---------------------------------------------------------------------------
// Section 2 — harvest readiness
// ---------------------------------------------------------------------------
function _sectionHarvest_(form) {
  form.addPageBreakItem().setTitle('Section 2 of 5 — Harvest readiness');

  var commodity = form.addChoiceItem()
    .setTitle(QUESTIONS.COMMODITY).setRequired(true)
    .setChoices(Object.keys(COMMODITY_SHELF_LIFE_DAYS).sort());
  commodity.setHelpText('Pick the primary commodity being surveyed. ' +
      'One form per commodity per FPO per week.');

  form.addTextItem()
    .setTitle(QUESTIONS.VARIETY)
    .setHelpText('e.g. Sharbati, Desi, Hybrid, Red 2. A variety we have not ' +
                 'bought before gets a trial order, not a full one.');

  form.addChoiceItem()
    .setTitle(QUESTIONS.HARVEST_READY_DAYS)
    .setHelpText('Days until this lot can be picked. Under 2 means it is ' +
                 'ready now and is a same-day collection candidate.')
    .setChoices(['Ready now', '1 day', '2 days', '3-4 days', '5-7 days',
                 'More than 7 days', 'Not yet flowering / not ready'])
    .setRequired(true);

  _numberItem_(form, QUESTIONS.EXPECTED_HARVEST_KG,
    'Your best estimate for the next 7 days. A number, no units.', true,
    'Over-estimating here is the single most common cause of a rejected ' +
    'load at the collection centre. If you are unsure, say so in the ' +
    'confidence field rather than rounding up.');

  _numberItem_(form, QUESTIONS.EXPECTED_HARVEST_KG_NEXT,
    'Expected volume for the following week. This is what lets us plan a ' +
    'standing order instead of a spot buy.', false);

  form.addChoiceItem()
    .setTitle(QUESTIONS.HARVEST_METHOD)
    .setChoices(['Hand picking', 'Machine harvest', 'Cutting whole plant',
                 'Root / tuber pull', 'Mixed'])
    .setRequired(true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.IRRIGATION)
    .setHelpText('Borewell tend to give more consistent grade than rain-fed, ' +
                 'which is why the scorecard weights it.')
    .setChoices(['Borewell', 'Canal', 'Rain-fed', 'Drip', 'Mixed / unknown'])
    .setRequired(true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.ESTIMATE_CONFIDENCE)
    .setHelpText('Be honest. A "Low" answer is not penalised — it applies a ' +
                 '20% haircut to the planned order, which protects you from ' +
                 'taking a load you cannot fill.')
    .setChoices(['High', 'Medium', 'Low'])
    .setRequired(true);
}

// ---------------------------------------------------------------------------
// Section 3 — quality
// ---------------------------------------------------------------------------
function _sectionQuality_(form) {
  form.addPageBreakItem().setTitle('Section 3 of 5 — Quality and grading');

  _numberItem_(form, QUESTIONS.GRADE_A_PCT,
    'Share that would pass an A-grade retail gate (%)', true,
    'Estimate by eye against last week\'s accepted lot if you have one.');
  _numberItem_(form, QUESTIONS.GRADE_B_PCT,
    'Share that would pass B grade (%)', true);
  _numberItem_(form, QUESTIONS.GRADE_C_PCT,
    'Share that is process / divert only (%)', true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.GRADING_DONE_AT_SOURCE)
    .setHelpText('If grading happens here, the load arrives pre-sorted and ' +
                 'the intake gate is far faster.')
    .setChoices(['Yes — graded at the farm', 'Yes — graded at a collection point',
                 'No — ungraded', 'Partially'])
    .setRequired(true);

  form.addTextItem()
    .setTitle(QUESTIONS.FIELD_PHOTO)
    .setHelpText('File name or Drive link. A photo of a rejected lot is worth ' +
                 'more in a supplier review than any volume figure.');

  _numberItem_(form, QUESTIONS.POST_HARVEST_LOSS_PCT,
    'Roughly what share of harvested produce is lost before it reaches us (%)',
    false,
    'Above 8% we will send someone to look at handling before we scale the ' +
    'order, whatever the price.');

  form.addTextItem()
    .setTitle(QUESTIONS.PEST_ISSUES)
    .setHelpText('Free text. Leave blank if none.');
}

// ---------------------------------------------------------------------------
// Section 4 — pricing
// ---------------------------------------------------------------------------
function _sectionPricing_(form) {
  form.addPageBreakItem().setTitle('Section 4 of 5 — Price expectations');

  _numberItem_(form, QUESTIONS.EXPECTED_PRICE_PER_KG,
    'What the FPO expects to be paid, at the collection centre (Rs/kg)', true,
    'The farm-gate expectation. This is what the negotiation starts from.');

  _numberItem_(form, QUESTIONS.MANDI_RATE_TODAY,
    'Today\'s mandi rate you are aware of (Rs/kg)', false,
    'If you know today\'s rate, this lets us show the FPO where the gap is ' +
    'between the two. If you do not, leave it blank.');

  form.addChoiceItem()
    .setTitle(QUESTIONS.PRICE_BASIS)
    .setHelpText('Which rate the expected price is quoted against.')
    .setChoices(['Farm gate, ex-harvest', 'Collection centre, delivered',
                 'Mandi rate parity', 'Open to discussion'])
    .setRequired(true);

  _numberItem_(form, QUESTIONS.MIN_ACCEPTABLE_PRICE,
    'The lowest price at which this lot still makes sense to deliver (Rs/kg)',
    false);

  form.addChoiceItem()
    .setTitle(QUESTIONS.PAYMENT_TERMS)
    .setHelpText('Payment terms are worth as much as price to a cash-constrained ' +
                 'farmer, and we can often move on terms rather than on rate.')
    .setChoices(['Immediate on delivery', 'Same day', '7 days', '15 days',
                 '30 days', 'On consignment sale'])
    .setRequired(true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.TRANSPORT_OWNED)
    .setChoices(['FPO owns transport', 'We arrange and pay',
                 'Shared cost', 'Buyer collects from farm'])
    .setRequired(true);
}

// ---------------------------------------------------------------------------
// Section 5 — logistics
// ---------------------------------------------------------------------------
function _sectionLogistics_(form) {
  form.addPageBreakItem().setTitle('Section 5 of 5 — Logistics');

  form.addChoiceItem()
    .setTitle(QUESTIONS.COLLECTION_SLOT)
    .setHelpText('Which slot the collection vehicle can reach the village in.')
    .setChoices(COLLECTION_SLOTS)
    .setRequired(true);

  _numberItem_(form, QUESTIONS.QTY_AVAILABLE_FOR_PICKUP,
    'What could actually be handed over today, right now (kg)', false,
    'This is different from the 7-day forecast. It is what we can collect ' +
    'without waiting.');

  form.addChoiceItem()
    .setTitle(QUESTIONS.CRATE_SUPPLY)
    .setHelpText('Crate availability is a hard constraint on volume, often ' +
                 'before land or water is.')
    .setChoices(['Ample — own crates', 'Limited — own crates',
                 'Need crates supplied by buyer', 'No crates'])
    .setRequired(true);

  form.addChoiceItem()
    .setTitle(QUESTIONS.COLD_CHAIN_AVAILABLE)
    .setChoices(['Pre-cooling available', 'Chilled van available',
                 'Insulated crates only', 'Ambient only'])
    .setRequired(true);

  _numberItem_(form, QUESTIONS.DISTANCE_TO_CC_KG,
    'Road distance to the collection centre (km)', true,
    'Used to estimate transit time, which is deducted from shelf life when ' +
    'the purchase order is scheduled.');

  form.addParagraphTextItem()
    .setTitle(QUESTIONS.REMARKS)
    .setHelpText('Anything the form did not capture.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A numeric text item, with type validation and an optional help string. */
function _numberItem_(form, title, help, required, helpText) {
  var item = form.addTextItem().setTitle(title);
  if (help) { item.setHelpText(helpText); }
  item.setValidation(FormApp.createTextValidation()
    .setTextInputType(FormApp.TextInputType.NUMBER)
    .setRequired(!!required)
    .build());
  return item;
}

/** Find a previously built form by name, so rebuilds can replace it. */
function _findExistingForm_() {
  var forms = DriveApp.getFilesByName('FPO Field Sourcing Survey — Harvest, Quality & Price');
  while (forms.hasNext()) {
    var f = forms.next();
    try {
      return FormApp.openById(f.getId());
    } catch (e) {
      // Not a form; keep looking.
    }
  }
  return null;
}

/** Write a line to the execution log, and to Properties for the log viewer. */
function _log_(message) {
  var ss = _openSpreadsheet_();
  _ensureSheets_(ss);
  var log = ss.getSheetByName(SHEETS.VALIDATION_LOG);
  log.appendRow([new Date(), 'INFO', '', message]);
}
