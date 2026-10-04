// Durable completion notices. An uncertain transport result is never auto-repeated.
const { createHash } = require("crypto");
const { responsePresentation } = require("./response-presentation");
async function deliverOnce(db, info, send) {
  const key = createHash("sha256").update(JSON.stringify([info.platform, info.chatId])).digest("hex");
  const { error: insertError } = await db.from("task_deliveries").insert({ task_table: info.table, task_id: info.id,
    user_id: info.userId, destination: key, platform: info.platform, chat_id: String(info.chatId), message: info.message });
  if (insertError && insertError.code !== "23505") throw insertError;
  // Supabase updates must precede filters.
  const update = fields => db.from("task_deliveries").update(fields).eq("task_table", info.table).eq("task_id", info.id).eq("destination", key);
  const { data, error } = await update({ status: "sending", updated_at: new Date().toISOString() }).eq("status", "pending").select();
  if (error) throw error;
  if (!data?.length) return;
  let receipt;
  try {
    receipt = await send(info.platform, info.chatId, data[0].message);
    if (receipt?.error || receipt?.isError) throw new Error("Delivery returned an error");
  }
  catch (error) {
    const { error: saveError } = await update({ status: "uncertain", error: String(error.message).slice(0, 300) }).eq("status", "sending");
    if (saveError) throw saveError;
    return;
  }
  const { error: saveError } = await update({ status: "sent", receipt: receipt == null ? null : JSON.stringify(receipt), updated_at: new Date().toISOString() }).eq("status", "sending");
  if (saveError) throw saveError;
  return data[0].message;
}
// A task that ended with nothing to show says what it was, what stopped it in
// plain words, and how to start it again. "The details are on your dashboard"
// sent people looking for an explanation that was not there.
function failedNote(row) {
  const asked = String(row.goal || row.task_prompt || "").split(/\n\[Picking up work/)[0].replace(/\s+/g, " ").trim();
  const what = asked.length > 90 ? asked.slice(0, 90).replace(/\s+\S*$/, "") + "…" : asked;
  const error = String(row.error || "");
  const why = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(error) ? "the connection to the AI provider kept dropping"
    : /allowance|budget/i.test(error) ? "it reached the work allowance for one task"
    : /timed out|timeout/i.test(error) ? "it took too long and was stopped"
    : /stopped|cancel/i.test(error) ? "it was stopped"
    : "something went wrong partway through";
  return `I couldn't finish ${what ? `"${what}"` : "that"}: ${why}. Say "try again" and I'll start it fresh.`;
}

// A run is a report only when it earns one: the person asked for a document,
// or the answer is too long for chat to carry whole. Everything else is an
// answer, and stays one: no report page advertised, no link, no downloads.
const REPORT_LENGTH = 3500;
function isReportWorthy(row, report) {
  return String(report || "").length > REPORT_LENGTH
    || /\b(report|write-?up|document|pdf|spreadsheet|excel|word doc(ument)?)\b/i.test(String(row?.goal || "").split(/\n\[Picking up work/)[0]);
}

async function reportDigest(report, platform, userId, store, reportId = null) {
  if (!report) return "I could not complete that task. The details are on your dashboard.";
  const links = require("./dashboard-links");
  const withReport = async (text) => reportId ? text + "\n\n" + await links.reportLinkNotice(platform, reportId) : text;
  // Ordinary answers need no second model call. Tables still need adaptation
  // for messaging apps; web chat can render them directly.
  const needsTableAdaptation = platform !== "web" && /\|[^\n]+\|/.test(report);
  if (platform === "dashboard" || (report.length <= REPORT_LENGTH && !needsTableAdaptation)) return withReport(report);
  let digest;
  try {
    const { client, model } = require("./llm").getInternalClient(userId, store);
    const response = await require("./agent-context").createAgentResponse(client, { model, max_tokens: 800,
      system: "Write a useful phone digest of the whole report. Preserve key findings, exact numbers, dates and unresolved outcomes. Lead with the answer; use short lists or labelled comparisons when helpful. Do not invent completed actions or omit important caveats.\n" + responsePresentation(platform),
      messages: [{ role: "user", content: report }] }, store?.profile?.settings?.llm_provider, { purpose: "delivery_digest", timeoutMs: 20000 });
    digest = require("./task-evidence").textOf(response.content).trim();
  } catch (error) { console.error("[task-delivery] digest unavailable:", error.code || "provider_error"); }
  // The chat carries the answer; the full version is the report page when the
  // run earned one, or the dashboard card when it did not.
  const text = digest || report.slice(0, 2400) + (report.length > 2400 ? "\n[The rest continues at the link below.]" : "");
  return reportId ? withReport(text) : text + "\n\n" + await links.agentLinkNotice(platform, "Full result");
}
async function destinationsFor(db, table, row) {
  if (table === "agent_tasks") return row.platform === "dashboard" ? [] : [{ platform: row.platform, chatId: row.chat_id }];
  const config = row.runtime?.config || {};
  if (!(config.output_destinations || ["chat_platforms"]).includes("chat_platforms")) return [];
  const { data: profile, error } = await db.from("profiles").select("settings").eq("id", row.user_id).single();
  if (error) throw error;
  const settings = profile?.settings || {};
  const selected = (settings.pulse_settings || settings.pulse || {}).deliveryPlatforms || [];
  const { data: links, error: linkError } = await db.from("chat_links").select("platform, platform_user_id").eq("user_id", row.user_id);
  if (linkError) throw linkError;
  const destinations = selected.map(p => {
    const link = (links || []).find(l => l.platform === (typeof p === "string" ? p : p.platform));
    return link && { platform: link.platform, chatId: link.platform_user_id };
  }).filter(Boolean);
  if (!destinations.length && row.platform !== "dashboard" && row.chat_id !== "dashboard") destinations.push({ platform: row.platform, chatId: row.chat_id });
  if (config.output_urgent) for (const d of settings.pulse?.deliveryPlatforms || []) {
    if (d.platform && d.chatId) destinations.push(d);
  }
  return [...new Map(destinations.map(d => [JSON.stringify([d.platform, String(d.chatId)]), d])).values()];
}
let polling = false;
async function deliverFinished() {
  if (polling) return;
  polling = true;
  try {
    const { supabase: db } = require("./db");
    for (const table of ["agent_tasks", "automation_runs"]) {
      const { data: rows, error } = await db.from(table).select("*").eq("delivery_status", "pending").limit(10);
      if (error) throw error;
      for (const row of rows || []) {
        const destinations = await destinationsFor(db, table, row);
        // Context-sensitive transports need the same isolated user context as chat.
        await require("./context").runWithInheritedContext(async () => {
          const store = await require("../user-store").UserStore.load(row.user_id);
          require("./storage").swapToCloudStore(store, row.user_id, row.chat_id);
          const report = row.result || row.full_report;
          const asReport = table === "agent_tasks" && isReportWorthy(row, report);
          // Marked once, so the dashboard offers the report page and its files
          // only for runs that are reports.
          if (asReport && !row.runtime?.report) {
            const { error: markError } = await db.from("agent_tasks").update({ runtime: { ...(row.runtime || {}), report: true } }).eq("id", row.id);
            if (markError) console.error("[task-delivery] could not mark the report:", markError.message);
          }
          let sentText = null;
          for (const dest of destinations) {
            require("./context").activePlatform = dest.platform;
            const { data: existing, error: existingError } = await db.from("task_deliveries").select("id")
              .eq("task_table", table).eq("task_id", row.id).eq("platform", dest.platform).eq("chat_id", String(dest.chatId)).limit(1);
            if (existingError) throw existingError;
            // Avoid paying to summarise a previously queued/delivered destination.
            const message = existing?.length ? "" : await require("./task-model").withTaskRun({ userId: row.user_id, taskId: row.id, kind: "delivery", budget: require("./task-model").makeBudget(row.runtime?.budget, store.profile?.settings?.agent_budget || {}) }, async () => {
              if (!report) return failedNote(row);
              const header = ["success", "completed"].includes(row.status) ? "" : "I couldn't finish all of this, but here is what I found.\n\n";
              return header + await reportDigest(report, dest.platform, row.user_id, store, asReport ? row.id : null);
            });
            // The web chat's live progress line for this task goes as the result lands.
            if (dest.platform === "web") {
              try { require("./web-chat-ws").sendToUser(String(dest.chatId), { type: "agent_progress", taskId: row.id, done: true }); } catch (_) { /* no open page */ }
            }
            const sent = await deliverOnce(db, { table, id: row.id, userId: row.user_id, ...dest, message: require("./follow-on").withBreaks(message) }, require("./messaging").sendToPlatform);
            if (sent && !sentText) sentText = sent;
          }
          // What the person was sent belongs in the conversation too: the
          // model then knows "those hotels" without a lookup, and reopening
          // the conversation shows the result. Under the user's lock, so a
          // reply being written at the same moment is not overwritten.
          if (sentText) await require("./user-mutex").acquireUserMutex(row.user_id, async () => {
            const current = await require("../user-store").UserStore.load(row.user_id);
            current.conversations.push({ role: "assistant", content: sentText });
            current.markDirty("conversations");
            await current.save();
          });
        });
        const { data: receipts, error: receiptError } = await db.from("task_deliveries").select("status").eq("task_table", table).eq("task_id", row.id);
        if (receiptError) throw receiptError;
        const status = (receipts || []).some(r => r.status !== "sent") ? "uncertain" : "sent";
        const { error: doneError } = await db.from(table).update({ delivery_status: status }).eq("id", row.id).eq("delivery_status", "pending");
        if (doneError) throw doneError;
      }
    }
  } catch (error) { console.error("[task-delivery] recovery:", error.message); }
  finally { polling = false; }
}
module.exports = { deliverOnce, reportDigest, deliverFinished, destinationsFor, failedNote, isReportWorthy };
