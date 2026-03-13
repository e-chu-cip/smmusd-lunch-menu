/*******************************************************
 * SMMUSD Lunch Menu Automation (Email + Google Sheets)
 *******************************************************/

var CONFIG = {
  MENU_PAGE_URL: "https://www.smmusd.org/departments/food-nutrition-services/elem-breakfast-lunch-menu",
  OCR_LANGUAGE: "en",
  SHEET_MENU_TAB: "MenuByDay",
  SHEET_LOG_TAB: "NotificationsSent",
  MAX_EMAIL_CHARS: 12000
};

/** Step 1 test: confirms Gmail sending works */
function testEmailOnly() {
  var recipients = getRecipients_();
  var subject = "Test: SMMUSD Lunch Menu Automation";
  var body = "If you received this, email sending works. Next run: runLunchMenuAutomation";
  for (var i = 0; i < recipients.length; i++) {
    MailApp.sendEmail(recipients[i], subject, body);
  }
}

/** Main automation */
function runLunchMenuAutomation() {
  var recipients = getRecipients_();

  // 1) Find PDF URL
  var pdfUrl = findMenuPdfUrl_();
  if (!pdfUrl) throw new Error("Could not find menu PDF URL.");

  // 2) Download PDF
  var pdfBlob = UrlFetchApp.fetch(pdfUrl).getBlob().setName("SMMUSD_Elem_Menu.pdf");

  // 3) OCR -> text
  var fullText = pdfBlobToTextViaDriveOCR_(pdfBlob, CONFIG.OCR_LANGUAGE);

  // 4) Extract lunch only if available; else use full text
  var lunchText = (typeof extractLunchSection_ === "function") ? extractLunchSection_(fullText) : fullText;
  var textToParse = (lunchText && lunchText.trim().length >= 30) ? lunchText : fullText;

  // 5) Parse weeks/days
  var weeks = parseTextToWeeksAndDays_(textToParse);

  // 6) Write to sheet
  writeWeeksToSheet_(weeks, pdfUrl);

  // 7) Format email + dedupe
  var latestWeek = pickLatestWeek_(weeks);
  var message = formatWeekEmail_(latestWeek);

  if (wasMessageAlreadySent_(latestWeek.label, message)) {
    Logger.log("Already sent this week's message. Skipping email.");
    return;
  }

  // 8) Send email
  var subject = "SMMUSD Lunch Menu - " + latestWeek.label;
  var body = message.substring(0, CONFIG.MAX_EMAIL_CHARS);
  for (var j = 0; j < recipients.length; j++) {
    MailApp.sendEmail(recipients[j], subject, body);
  }

  // 9) Log sent
  logMessageSent_(latestWeek.label, message);
}

/**
 * Find the current menu PDF URL.
 * Priority:
 * 1) Script Property override (MENU_PDF_URL_OVERRIDE)
 * 2) Auto-detect from known source pages
 */
function findMenuPdfUrl_() {
  var props = PropertiesService.getScriptProperties();
  var override = props.getProperty("MENU_PDF_URL_OVERRIDE");
  if (override && override.indexOf(".pdf") > -1) return override;

  var sources = [
    "https://www.smmusd.org/departments/food-nutrition-services/elem-breakfast-lunch-menu",
    "https://ca50000164.schoolwires.net/domain/1867"
  ];

  for (var i = 0; i < sources.length; i++) {
    var pageUrl = sources[i];
    var html = UrlFetchApp.fetch(pageUrl, { muteHttpExceptions: true }).getContentText();
    html = normalizeHtmlForLinks_(html);

    var pdf = extractFirstPdfUrlFromHtml_(html);
    if (pdf) return pdf;
  }

  return null;
}

/** Normalize OCR text (entities + boilerplate + whitespace) */
function normalizeOcr_(text) {
  var s = decodeHtmlEntities_(text || "");

  // Strip boilerplate (and anything after it)
  s = s.replace(/Offered with every meal:[\s\S]*$/i, "");
  s = s.replace(/Menu is Subject to Change[\s\S]*$/i, "");
  s = s.replace(/THIS INSTITUTION[\s\S]*$/i, "");

  // Whitespace normalize
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/\r/g, "\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

Logger.log("Target Monday for this send: " + getNextMonday_(new Date()));

/** Normalize HTML pulled from menu pages */
function normalizeHtmlForLinks_(html) {
  if (!html) return "";
  var out = html;

  // Turn \/ into /
  out = out.replace(/\\\//g, "/");

  // Convert \u0026 to &
  out = out.replace(/\\u0026/g, "&");

  // Decode entities if present
  out = decodeHtmlEntities_(out);

  return out;
}

/** Decode common HTML entities (including double-encoded ampersands) */
function decodeHtmlEntities_(s) {
  var out = (s || "");

  // Double-encoded ampersand: &amp;amp; -> &amp; -> &
  out = out.replace(/&amp;amp;/g, "&amp;");
  out = out.replace(/&amp;/g, "&");

  out = out.replace(/&lt;/g, "<");
  out = out.replace(/&gt;/g, ">");
  out = out.replace(/&quot;/g, "\"");
  out = out.replace(/&#39;/g, "'");

  return out;
}

/** Pull the first absolute PDF URL from HTML */
function extractFirstPdfUrlFromHtml_(html) {
  if (!html) return null;
  var m = html.match(/https?:\/\/[^"'<> \n\r\t]+\.pdf(?:\?[^"'<> \n\r\t]+)?/i);
  return (m && m[0]) ? m[0] : null;
}


/** Debug helper: run this to see what PDF URL the script finds */
function debugFindPdfOnly() {
  var url = findMenuPdfUrl_();
  Logger.log("DEBUG pdfUrl = " + url);
}

/** Reads recipients from Script Properties: EMAIL_TO_1, EMAIL_TO_2 */
function getRecipients_() {
  var props = PropertiesService.getScriptProperties();
  var email1 = props.getProperty("EMAIL_TO_1");
  var email2 = props.getProperty("EMAIL_TO_2");

  var recipients = [];
  if (email1) recipients.push(email1);
  if (email2) recipients.push(email2);

  if (recipients.length === 0) {
    throw new Error("No recipients found. Set EMAIL_TO_1 and/or EMAIL_TO_2 in Script Properties.");
  }
  return recipients;
}

/**
 * Finds the first absolute PDF URL in the menu page HTML.
 * Safer than parsing relative hrefs (and usually sufficient).
 */
function findFirstAbsolutePdfUrl_(pageUrl) {
  var html = UrlFetchApp.fetch(pageUrl, { muteHttpExceptions: true }).getContentText();

  // Match absolute PDF links like https://.../something.pdf or .pdf?query=...
  var matches = html.match(/https?:\/\/[^"'\\s>]+\\.pdf(?:\\?[^"'\\s>]*)?/gi);
  if (matches && matches.length > 0) return matches[0];

  return null;
}

/**
 * OCR convert PDF blob -> Google Doc -> extract text -> trash temp doc.
 * Uses Advanced Drive Service (Drive API). [1](https://www.labnol.org/code/20010-convert-pdf-to-text-ocr)[2](https://basescripts.com/read-pdf-to-text-using-google-apps-script-drive-v3-service)
 */
/**
 * Drive API v3 OCR conversion:
 * PDF blob -> Google Doc (OCR) -> extract text -> trash temp doc
 */
function pdfBlobToTextViaDriveOCR_(pdfBlob, language) {
  var name = pdfBlob.getName().replace(/\.pdf$/i, "");

  // In Drive API v3, the metadata object uses "name"
  var docFile = Drive.Files.create(
    { name: name, mimeType: MimeType.GOOGLE_DOCS },
    pdfBlob,
    { ocr: true, ocrLanguage: language }
  );

  var docId = docFile.id;
  var text = DocumentApp.openById(docId).getBody().getText();

  // Cleanup temporary Google Doc
  DriveApp.getFileById(docId).setTrashed(true);

  return text;
}


/** Extract lunch portion only (best effort) */
function extractLunchSection_(text) {
  if (!text) return "";
  var cleaned = normalizeText_(text);

  var idx = indexOfAny_(cleaned, ["\nLUNCH", " LUNCH ", "\nLunch", " Lunch "]);
  if (idx < 0) return "";

  var after = cleaned.substring(idx);

  // If Breakfast appears after lunch (rare), stop there
  var end = indexOfAny_(after, ["\nBREAKFAST", " BREAKFAST ", "\nBreakfast", " Breakfast "]);
  if (end > 0) return after.substring(0, end);

  return after;
}

/** Parse text into week blocks and Monday-Friday items */
function parseTextToWeeksAndDays_(text) {
  var cleaned = normalizeOcr_(text);

  // Matches: Week: MAR 16 - 20  (also accepts MAR 16-20 and different dash types)
  var reWeekBlock = /Week:\s*([A-Z]{3})\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*([\s\S]*?)(?=Week:\s*[A-Z]{3}\s*\d{1,2}\s*[-–]\s*\d{1,2}|$)/g;

  var weeks = [];
  var m;

  while ((m = reWeekBlock.exec(cleaned)) !== null) {
    var mon = m[1];                     // "MAR"
    var startDay = parseInt(m[2], 10);  // 16
    var endDay = parseInt(m[3], 10);    // 20
    var block = m[4] || "";

    var label = "Week: " + mon + " " + startDay + "-" + endDay;

    // Split the block into 5 entries (Mon..Fri) in order
    var entries = splitWeekBlockIntoFiveEntries_(block);

    var dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    var days = {};
    for (var i = 0; i < 5; i++) {
      if (entries[i]) days[dayNames[i]] = entries[i];
    }

    weeks.push({
      label: label,
      monthAbbrev: mon,
      startDay: startDay,
      endDay: endDay,
      days: days
    });
  }

  // fallback if OCR didn't match week blocks
  if (weeks.length === 0) {
    return [{ label: "Latest Menu", monthAbbrev: null, startDay: null, endDay: null, days: {} }];
  }

  return weeks;
}

/** helper to split weeks into 5 blocks */
/** helper to split week row text into 5 day entries (Mon..Fri) */
function splitWeekBlockIntoFiveEntries_(block) {
  var raw = (block || "").trim();
  if (!raw) return ["", "", "", "", ""];

  // Remove headers that can appear mid-stream
  raw = raw.replace(/March\s*LUNCH\s*MENU/ig, "");
  raw = raw.replace(/LUNCH\s*MENU/ig, "");

  // Split into lines
  var lines = raw
    .split(/\n/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x.length > 0; });

  var chunks = [];
  var current = "";
  var carryOr = false; // if we saw standalone "or", next line must attach

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Ignore any stray "Week:" inside the block
    if (/^Week:/i.test(line)) continue;

    // If line is exactly "or", it signals continuation
    if (/^or$/i.test(line)) {
      if (current && !/\bor\b$/i.test(current)) current += " or";
      carryOr = true;
      continue;
    }

    // Continuation rules:
    // - if we just saw standalone "or"
    // - OR if current ends with "or"
    // - OR if line begins with "or", "w/", or "with"
    var isContinuation =
      carryOr ||
      (current && /\bor\b$/i.test(current)) ||
      /^or\b/i.test(line) ||
      /^w\/?/i.test(line) ||
      /^with\b/i.test(line);

    if (!current) {
      current = line;
      carryOr = false;
    } else if (isContinuation) {
      current += " " + line;
      carryOr = false;
    } else {
      chunks.push(cleanEntry_(current));
      current = line;
      carryOr = false;
    }
  }

  if (current) chunks.push(cleanEntry_(current));

  // Keep first 5 entries as Mon..Fri (best effort)
  if (chunks.length >= 5) return chunks.slice(0, 5);

  while (chunks.length < 5) chunks.push("");
  return chunks;
}

function cleanEntry_(s) {
  var t = (s || "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * OPTIONAL: If you no longer use weekday-name parsing, you can remove this.
 * Keeping it here only if other parts of your code still call extractDays_().
 */
/**
 * OPTIONAL: weekday-name parsing. If your project no longer uses this, you can delete it.
 * Keeping it only if some old function still calls extractDays_().
 */
function extractDays_(block) {
  var dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  var out = {};

  for (var i = 0; i < dayNames.length; i++) {
    var day = dayNames[i];
    var re = new RegExp(day + "\\b([\\s\\S]*?)(?=(Monday|Tuesday|Wednesday|Thursday|Friday)\\b|$)", "i");
    var match = block.match(re);
    if (match && match[1]) {
      out[day] = cleanupMenuItem_(match[1]);
    }
  }
  return out;
}

function cleanupMenuItem_(chunk) {
  var s = (chunk || "").trim();

  // cut boilerplate
  s = s.split(/Offered Daily|Milk|Fruit|Vegetable|Menu is subject|USDA|This institution/i)[0].trim();

  // whitespace normalize
  s = s.replace(/\s+/g, " ");

  // keep reasonable length (optional; remove if you want full text)
  if (s.length > 180) s = s.substring(0, 180).trim() + "...";

  // remove leading punctuation junk
  s = s.replace(/^[-:;,.]+\s*/, "");

  return s;
}

function normalizeText_(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function indexOfAny_(text, needles) {
  var best = -1;
  for (var i = 0; i < needles.length; i++) {
    var idx = text.indexOf(needles[i]);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

/**helping to fix missing "t" OCR */
function fixOcrArtifacts_(s) {
  var t = (s || "");

  // Common “missing t” / split-word artifacts seen in your screenshot
  // (safe, targeted replacements)
  var replacements = [
    [/S\s*eak/gi, "Steak"],
    [/Yogur\s*/gi, "Yogurt "],
    [/Briske\s*/gi, "Brisket "],
    [/Roas\s*ed/gi, "Roasted"],
    [/Burr\s*o/gi, "Burrito"],
    [/Fru\s*i/gi, "Fruit"],
    [/Gol\s*d\s*Fisch/gi, "Goldfish"],
    [/Cheeze/gi, "Cheese"],
    [/Lettice/gi, "Lettuce"],
    [/Parfai/gi, "Parfait"],
  ];

  for (var i = 0; i < replacements.length; i++) {
    t = t.replace(replacements[i][0], replacements[i][1]);
  }

  // Clean up stray spacing
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Write output rows to MenuByDay */
function writeWeeksToSheet_(weeks, pdfUrl) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CONFIG.SHEET_MENU_TAB) || ss.insertSheet(CONFIG.SHEET_MENU_TAB);

  if (sh.getLastRow() === 0) {
    sh.appendRow(["WeekLabel", "Day", "LunchItem", "SourcePdfUrl", "ExtractedAt"]);
  }

  var now = new Date();
  var rows = [];

  for (var i = 0; i < weeks.length; i++) {
    var w = weeks[i];
    var days = w.days || {};
    for (var day in days) {
      if (days.hasOwnProperty(day)) {
        rows.push([w.label, day, days[day], pdfUrl, now]);
      }
    }
  }

  if (rows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function pickLatestWeek_(weeks) {
  if (weeks && weeks.length > 0) return weeks[0];
  return { label: "Latest Menu", days: {} };
}

function formatWeekEmail_(week) {
  var order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  var lines = [];
  lines.push(week.label + " (Lunch):");

  for (var i = 0; i < order.length; i++) {
    var d = order[i];
    if (week.days && week.days[d]) {
      lines.push(d + " - " + week.days[d]);
    }
  }
  return lines.join("\n");
}

/** Dedupe and log */
function wasMessageAlreadySent_(weekLabel, message) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CONFIG.SHEET_LOG_TAB) || ss.insertSheet(CONFIG.SHEET_LOG_TAB);

  if (sh.getLastRow() === 0) {
    sh.appendRow(["WeekLabel", "MessageHash", "SentAt"]);
    return false;
  }

  var hash = hash_(message);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();

  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === weekLabel && values[i][1] === hash) return true;
  }
  return false;
}

function logMessageSent_(weekLabel, message) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CONFIG.SHEET_LOG_TAB) || ss.insertSheet(CONFIG.SHEET_LOG_TAB);

  if (sh.getLastRow() === 0) sh.appendRow(["WeekLabel", "MessageHash", "SentAt"]);
  sh.appendRow([weekLabel, hash_(message), new Date()]);
}

function hash_(s) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s || "")
  );
}

function debugOcrSample_FullText() {
  var props = PropertiesService.getScriptProperties();
  var pdfUrl = props.getProperty("MENU_PDF_URL_OVERRIDE");
  if (!pdfUrl) throw new Error("Missing MENU_PDF_URL_OVERRIDE in Script Properties.");

  var pdfBlob = UrlFetchApp.fetch(pdfUrl).getBlob().setName("SMMUSD_Elem_Menu.pdf");
  var fullText = pdfBlobToTextViaDriveOCR_(pdfBlob, "en");

  Logger.log("=== FULL OCR SAMPLE (first 2000 chars) ===");
  Logger.log(fullText.substring(0, 2000));
  Logger.log("=== FULL OCR SAMPLE END ===");
}

function debugOcrSample_LunchOnly() {
  var props = PropertiesService.getScriptProperties();
  var pdfUrl = props.getProperty("MENU_PDF_URL_OVERRIDE");
  if (!pdfUrl) throw new Error("Missing MENU_PDF_URL_OVERRIDE in Script Properties.");

  var pdfBlob = UrlFetchApp.fetch(pdfUrl).getBlob().setName("SMMUSD_Elem_Menu.pdf");
  var fullText = pdfBlobToTextViaDriveOCR_(pdfBlob, "en");

  // Use extractLunchSection_ if it exists, otherwise fall back to full text
  var lunchText = (typeof extractLunchSection_ === "function")
    ? extractLunchSection_(fullText)
    : fullText;

  Logger.log("=== LUNCH OCR SAMPLE (first 2000 chars) ===");
  Logger.log((lunchText || "").substring(0, 2000));
  Logger.log("=== LUNCH OCR SAMPLE END ===");
}

/**
 * Returns a Date object representing the next Monday relative to "now".
 * - If today is Monday, "next Monday" means the Monday of the following week.
 */
function getNextMonday_(fromDate) {
  var d = fromDate ? new Date(fromDate) : new Date();
  d.setHours(0, 0, 0, 0);

  var day = d.getDay(); // Sun=0, Mon=1, ..., Sat=6
  var delta = (8 - day) % 7;
  if (delta === 0) delta = 7; // if already Monday, go to next week's Monday
  d.setDate(d.getDate() + delta);

  return d;
}

/**
 * Returns true if today is exactly 2 days before the next Monday.
 * (i.e., typically Saturday).
 */
function isTwoDaysBeforeNextMonday_() {
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var nextMonday = getNextMonday_(today);

  var twoDaysBefore = new Date(nextMonday);
  twoDaysBefore.setDate(twoDaysBefore.getDate() - 2);

  return today.getTime() === twoDaysBefore.getTime();
}
/**
 * Returns a Date object representing the next Monday relative to "now".
 * - If today is Monday, "next Monday" means the Monday of the following week.
 */
function getNextMonday_(fromDate) {
  var d = fromDate ? new Date(fromDate) : new Date();
  d.setHours(0, 0, 0, 0);

  var day = d.getDay(); // Sun=0, Mon=1, ..., Sat=6
  var delta = (8 - day) % 7;
  if (delta === 0) delta = 7; // if already Monday, go to next week's Monday
  d.setDate(d.getDate() + delta);

  return d;
}

/**
 * Returns true if today is exactly 2 days before the next Monday.
 * (i.e., typically Saturday).
 */
function isTwoDaysBeforeNextMonday_() {
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var nextMonday = getNextMonday_(today);

  var twoDaysBefore = new Date(nextMonday);
  twoDaysBefore.setDate(twoDaysBefore.getDate() - 2);

  return today.getTime() === twoDaysBefore.getTime();
}