/**
 * Rial bank-sync relay — Gmail pickup (Phase 3B).
 *
 * Reads ONLY the Gmail label named LABEL_NAME below — never the whole inbox,
 * never any other label. For each thread carrying that label but not yet
 * carrying SENT_LABEL_NAME, POSTs each message's raw content to the Worker
 * built in Phase 2, then labels the thread Sent so it is never re-sent.
 *
 * WORKER_URL and INGEST_SECRET are read from Script Properties (Project
 * Settings → Script Properties in the editor) — never hardcoded here. See
 * APPS-SCRIPT-SETUP.md for setup, testing, and how to revoke/delete this.
 *
 * Logging discipline: every Logger.log() call below prints counts, ids, or
 * HTTP status codes ONLY — never a subject, sender, or body. Grep this file
 * for "Logger.log" if you want to audit that yourself before trusting it
 * with your inbox.
 */

const LABEL_NAME = "Rial";              // the label you put on bank alerts
const SENT_LABEL_NAME = "Rial/Sent";    // applied once a thread is fully relayed
const MAX_THREADS_PER_RUN = 50;         // a safety cap, independent of the time budget below
const TIME_BUDGET_MS = 5 * 60 * 1000;   // leave headroom under Apps Script's 6-minute execution limit

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const workerUrl = (props.getProperty("WORKER_URL") || "").trim().replace(/\/+$/, "");
  const ingestSecret = props.getProperty("INGEST_SECRET") || "";
  if (!workerUrl || !ingestSecret) {
    throw new Error("Set WORKER_URL and INGEST_SECRET in Project Settings → Script Properties first.");
  }
  return { workerUrl, ingestSecret };
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * POSTs one raw message to the Worker's /ingest endpoint. Returns the HTTP
 * status code (or 0 if the request itself failed to go out, e.g. no network).
 * Never throws — a single bad message must never take down the whole run.
 */
function postToIngest_(config, rawMessage) {
  try {
    const response = UrlFetchApp.fetch(config.workerUrl + "/ingest", {
      method: "post",
      contentType: "text/plain",
      payload: rawMessage,
      headers: { "X-Ingest-Secret": config.ingestSecret },
      muteHttpExceptions: true,
    });
    return response.getResponseCode();
  } catch (e) {
    return 0;
  }
}

/**
 * Main entry point — wire this to a time-driven trigger (every 10 minutes).
 * Finds threads labelled LABEL_NAME that aren't labelled SENT_LABEL_NAME yet,
 * relays each message in them, and labels a thread Sent only once every
 * message in it was accepted (2xx). A thread that hits a non-2xx, or that
 * this run simply doesn't get to before the time budget runs out, is left
 * unlabelled — the next run's search picks it up again automatically.
 */
function processRialMessages() {
  const config = getConfig_();
  const sentLabel = getOrCreateLabel_(SENT_LABEL_NAME);

  // Gmail search syntax, not GmailApp.getUserLabelByName+getThreads — this
  // lets Gmail itself exclude already-sent threads server-side, so a run
  // with a huge backlog doesn't have to page through everything already done.
  const query = 'label:"' + LABEL_NAME + '" -label:"' + SENT_LABEL_NAME + '"';
  const threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);

  const startedAt = Date.now();
  let threadsSent = 0, threadsFailed = 0, threadsSkippedOnTimeBudget = 0, messagesSent = 0;

  for (let i = 0; i < threads.length; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      threadsSkippedOnTimeBudget = threads.length - i;
      break; // whatever's left stays unlabelled — next run's query finds it again
    }

    const thread = threads[i];
    const messages = thread.getMessages();
    let allOk = true;

    for (let j = 0; j < messages.length; j++) {
      const status = postToIngest_(config, messages[j].getRawContent());
      if (status >= 200 && status < 300) {
        messagesSent++;
      } else {
        allOk = false;
        Logger.log("ingest failed for one message: HTTP " + status);
        // keep going — a partial failure shouldn't stop the rest of the batch
      }
    }

    if (allOk) {
      thread.addLabel(sentLabel);
      threadsSent++;
    } else {
      threadsFailed++; // left unlabelled on purpose — retried next run
    }
  }

  Logger.log(
    "Rial sync: %s thread(s) sent (%s message(s)), %s thread(s) had a failure and will retry, %s thread(s) deferred to next run (time budget)",
    threadsSent, messagesSent, threadsFailed, threadsSkippedOnTimeBudget
  );
}

/**
 * Run this manually (Run ▸ testConnection, then View ▸ Logs) to confirm the
 * Worker URL and ingest secret are wired up correctly — BEFORE pointing the
 * Rial label at any real mail. Sends a harmless synthetic string, not a real
 * or even fake-looking bank message, and does not touch Gmail at all.
 */
function testConnection() {
  const config = getConfig_();
  const status = postToIngest_(config, "Rial Apps Script test connection — " + new Date().toISOString());
  if (status >= 200 && status < 300) {
    Logger.log("OK — the Worker accepted a test message (HTTP " + status + "). Wiring is correct.");
  } else if (status === 0) {
    Logger.log("FAILED — could not reach " + config.workerUrl + " at all. Check the URL in Script Properties.");
  } else {
    Logger.log("FAILED — the Worker rejected the test message (HTTP " + status + "). Check INGEST_SECRET matches what you set with `wrangler secret put INGEST_SECRET`.");
  }
}

/**
 * Optional one-time convenience: run this once (Run ▸ createTrigger) instead
 * of setting up the time-driven trigger by hand in the Triggers UI. Safe to
 * run more than once — it removes any trigger it previously created for
 * processRialMessages before adding a fresh one, so you never end up with
 * duplicates firing in parallel.
 */
function createTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "processRialMessages") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("processRialMessages").timeBased().everyMinutes(10).create();
  Logger.log("Trigger created: processRialMessages will run every 10 minutes.");
}
