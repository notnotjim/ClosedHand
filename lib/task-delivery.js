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
}
async function reportDigest(report, platform, userId, store) {
  if (!report) return "I could not complete that task. The details are on your dashboard.";
  if (platform === "dashboard" || (report.length <= 1200 && !/\|[^\n]+\|/.test(report))) return report;
  let digest;
  try {
    const { client, model } = require("./llm").getInternalClient(userId, store);
    const response = await require("./agent-context").createAgentResponse(client, { model, max_tokens: 800,
      system: "Write a useful phone digest of the whole report. Preserve key findings, exact numbers, dates and unresolved outcomes. Lead with the answer; use short lists or labelled comparisons when helpful. Do not invent completed actions or omit important caveats.\n" + responsePresentation(platform),
      messages: [{ role: "user", content: report }] }, store?.profile?.settings?.llm_provider, { purpose: "delivery_digest", timeoutMs: 20000 });
    digest = require("./task-evidence").textOf(response.content).trim();
  } catch (error) { console.error("[task-delivery] digest unavailable:", error.code || "provider_error"); }
  return (digest || report.slice(0, 2400) + (report.length > 2400 ? "\n[Report continues on your dashboard.]" : ""))
    + "\n\n" + await require("./dashboard-links").agentLinkNotice(platform, "Full report");
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
          for (const dest of destinations) {
            require("./context").activePlatform = dest.platform;
            const { data: existing, error: existingError } = await db.from("task_deliveries").select("id")
              .eq("task_table", table).eq("task_id", row.id).eq("platform", dest.platform).eq("chat_id", String(dest.chatId)).limit(1);
            if (existingError) throw existingError;
            // Avoid paying to summarise a previously queued/delivered destination.
            const message = existing?.length ? "" : await require("./task-model").withTaskRun({ userId: row.user_id, taskId: row.id, kind: "delivery", budget: require("./task-model").makeBudget(row.runtime?.budget, store.profile?.settings?.agent_budget || {}) }, async () => {
              const header = ["success", "completed"].includes(row.status) ? "Done.\n\n" : "This task is incomplete.\n\n";
              return header + await reportDigest(report, dest.platform, row.user_id, store);
            });
            await deliverOnce(db, { table, id: row.id, userId: row.user_id, ...dest, message }, require("./messaging").sendToPlatform);
          }
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
module.exports = { deliverOnce, reportDigest, deliverFinished, destinationsFor };
