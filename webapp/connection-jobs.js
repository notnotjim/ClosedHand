// webapp/connection-jobs.js: what a connected service can do in Closedhand's
// place.
//
// Closedhand does some jobs itself: it speaks, writes out speech and searches
// the web. When someone connects a service that does one of those jobs (an
// MCP server, or a key for a plain API), it takes over that job, with no code
// for that service: its tools are read once when it is connected or tested,
// the person's own model says which tool does which job and how to call it,
// and this file keeps only what the tools' own definitions bear out. Each job
// found gets a switch on the connection's tile, on from the start, since
// connecting a service that does the job is the sign it's wanted; one
// connection does a job at a time. The bot uses it first and falls back to
// its own when it fails (lib/voice-connections.js for the voice,
// lib/connection-jobs.js for the rest).
//
// Saved in the connection's caps: voice (speak and hear, one switch) in
// caps.voice, every other job in caps.jobs.<job>.
//
// A new job is an entry in tool-jobs.js: the Closedhand tool it replaces,
// what a service's tool must do, and the inputs it is given.

// Closedhand's own tools a service can take over, and what each takes
// (tool-jobs.js, shared with the bot).
const TOOL_JOBS = require("./tool-jobs").JOBS;

// Only tools that could do one of the jobs go to the model, so most services
// cost nothing to check.
const MAYBE_VOICE = /speech|speak|voice|audio|tts|stt|transcri|dictat|narrat|sound/i;
function maybeAJob(tool) {
  const said = `${tool.name} ${tool.description || ""}`;
  return MAYBE_VOICE.test(said) || Object.values(TOOL_JOBS).some((j) => j.words.test(said));
}

const CHOOSE = {
  choose_argument: { type: "string", description: "A required argument that is an id from the person's own account, such as a voice id, or empty." },
  choose_from: { type: "string", description: "The tool that lists the values for choose_argument, or empty." },
};

function toolJobReport(job) {
  const properties = { found: { type: "boolean" }, tool: { type: "string" } };
  for (const [input, spec] of Object.entries(job.inputs)) properties[`${input}_argument`] = { type: "string", description: `The argument for ${spec.about}${spec.required ? "" : ", or empty if it takes none"}.` };
  properties.fixed_arguments = { type: "object", description: "Values for other required arguments, only where the definition makes the value clear." };
  return { type: "object", properties, required: ["found"] };
}

const REPORT = {
  name: "report_jobs",
  description: "Report which tool, if any, does each of Closedhand's jobs.",
  input_schema: {
    type: "object",
    properties: {
      speak: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          tool: { type: "string" },
          text_argument: { type: "string", description: "The argument that holds the words to say." },
          format_argument: { type: "string", description: "The argument that chooses the audio format, or empty." },
          fixed_arguments: { type: "object", description: "Values for other required arguments, only where the definition makes the value clear." },
          ...CHOOSE,
        },
        required: ["found"],
      },
      hear: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          tool: { type: "string" },
          audio_argument: { type: "string", description: "The argument that holds the recording." },
          audio_as: { type: "string", enum: ["base64", "path", "file", "url"] },
          fixed_arguments: { type: "object" },
          ...CHOOSE,
        },
        required: ["found"],
      },
      ...Object.fromEntries(Object.entries(TOOL_JOBS).map(([name, job]) => [name, toolJobReport(job)])),
    },
    required: ["speak", "hear", ...Object.keys(TOOL_JOBS)],
  },
};

const SYSTEM = "You read the tools of a service someone has connected to Closedhand, their personal assistant, and report which of them can do one of Closedhand's own jobs, so Closedhand can use the service for it. Report only with the report_jobs tool.";

function prompt(tools) {
  return `Tool definitions:
${JSON.stringify(tools.map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 1500), inputSchema: t.inputSchema || {} })), null, 1)}

Report, for each job:
- speak: a tool that takes words and returns them spoken, as audio or as a link to audio. text_argument is the argument for the words. format_argument is the argument that picks the audio format or encoding, if there is one.
- hear: a tool that takes a recording of speech and returns the words. audio_argument is the argument for the recording, and audio_as is how it wants it: "base64" (the audio as base64 text), "path" (a file on the same computer), "file" (a file upload, an argument of format binary) or "url" (a web address).
${Object.entries(TOOL_JOBS).map(([name, job]) => `- ${name}: a tool that ${job.does}. ${Object.entries(job.inputs).map(([input, spec]) => `${input}_argument is the argument for ${spec.about}${spec.required ? "" : ", if it takes one"}.`).join(" ")}`).join("\n")}
- fixed_arguments: values for any other required arguments, only when the definition makes the value clear, such as a default, an example it gives, or the one sensible choice of an enum. Never make up ids, such as a voice id.
- choose_argument and choose_from (speak and hear): when a required argument is an id from the person's own account (a voice id, say) and another tool here lists them, name the argument and that listing tool, and Closedhand picks one from the list.
- Tools that make music or sound effects, change one voice into another, or manage voices, agents, accounts or files are not speak or hear. A tool that searches only the service's own records, not the web, is not search. Report a tool for a job only when doing that job is what the tool is for.
- found is false when no tool fits.`;
}

// The other required arguments a report fills in, checked against the
// tool's definition: each one is the tool's own, and allowed by its list.
function fixedFrom(props, report, taken) {
  const fixed = {};
  for (const [k, v] of Object.entries(report.fixed_arguments || {})) {
    if (!props[k] || taken.has(k)) return null;
    if (Array.isArray(props[k].enum) && !props[k].enum.includes(v)) return null;
    fixed[k] = v;
  }
  return fixed;
}

// An id from the person's account, picked from the tool that lists them
// when the connection is made: a listing needs nothing else to call.
function chooseFrom(tools, tool, props, report, fixed) {
  if (!report.choose_argument || !props[report.choose_argument] || report.choose_argument in fixed) return undefined;
  const lister = tools.find((t) => t.name === report.choose_from);
  if (!lister || lister.name === tool.name || (lister.inputSchema?.required || []).length) return null;
  return { arg: report.choose_argument, from: lister.name };
}

function requiredMet(schema, props, given) {
  return (schema.required || []).every((r) => given.has(r) || props[r]?.default !== undefined);
}

// Keeps a reported voice tool only when its definition bears it out.
function check(tools, report, job) {
  if (!report || report.found !== true) return null;
  const tool = tools.find((t) => t.name === report.tool);
  if (!tool) return null;
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const main = job === "speak" ? report.text_argument : report.audio_argument;
  if (!main || !props[main]) return null;
  const fixed = fixedFrom(props, report, new Set([main]));
  if (!fixed) return null;
  let format = null;
  if (job === "speak" && report.format_argument) {
    const arg = report.format_argument;
    if (!props[arg]) return null;
    const values = Array.isArray(props[arg].enum) ? props[arg].enum.filter((v) => typeof v === "string") : null;
    if (values && values.length) format = { arg, values };
    else if ((schema.required || []).includes(arg) && !(arg in fixed)) return null;
  }
  const choose = chooseFrom(tools, tool, props, report, fixed);
  if (choose === null) return null;
  const given = new Set([main, ...Object.keys(fixed), ...(format ? [format.arg] : []), ...(choose ? [choose.arg] : [])]);
  if (!requiredMet(schema, props, given)) return null;
  if (job === "speak") return { tool: tool.name, text: main, format, fixed, ...(choose ? { choose } : {}) };
  // A web address would need the recording put online first; that isn't
  // done. An upload has to be what the definition says takes a file.
  if (!["base64", "path", "file"].includes(report.audio_as)) return null;
  if (report.audio_as === "file" && props[main].format !== "binary") return null;
  return { tool: tool.name, audio: main, as: report.audio_as, fixed, ...(choose ? { choose } : {}) };
}

// Keeps a reported tool for one of the jobs only when its definition bears
// it out: each of Closedhand's required inputs, and any other it names, goes
// to an argument the tool has, and nothing the tool requires is left out.
// { tool, args: { input: argument }, fixed }.
function checkTool(tools, report, name) {
  const job = TOOL_JOBS[name];
  if (!job || !report || report.found !== true) return null;
  const tool = tools.find((t) => t.name === report.tool);
  if (!tool) return null;
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const args = {};
  for (const [input, spec] of Object.entries(job.inputs)) {
    const arg = report[`${input}_argument`];
    if (!arg) { if (spec.required) return null; continue; }
    if (!props[arg] || Object.values(args).includes(arg)) return null;
    args[input] = arg;
  }
  if (!Object.keys(args).length) return null;
  const fixed = fixedFrom(props, report, new Set(Object.values(args)));
  if (!fixed) return null;
  if (!requiredMet(schema, props, new Set([...Object.values(args), ...Object.keys(fixed)]))) return null;
  return { tool: tool.name, args, fixed };
}

// tools: [{ name, description, inputSchema }]; selected: the person's model
// (model-policy getRole). Returns { voice, jobs }: voice { speak, hear } with
// null for a part no tool does, or null; jobs { search: plan or null, ... }.
// undefined in place of either when it couldn't be checked (no model, or
// the model failed), so what was found before can stand.
async function findJobs(tools, selected, deps = {}) {
  const candidates = (tools || []).filter(maybeAJob);
  const none = { voice: null, jobs: Object.fromEntries(Object.keys(TOOL_JOBS).map((j) => [j, null])) };
  if (!candidates.length) return none;
  if (!selected) return { voice: undefined, jobs: undefined };
  const request = deps.request || require("./model-wire").request;
  let report;
  try {
    const response = await request(selected, {
      model: selected.model, effort: "fast", system: SYSTEM, max_tokens: 2048,
      messages: [{ role: "user", content: prompt(candidates) }],
      tools: [REPORT], tool_choice: { type: "tool", name: REPORT.name },
    }, { signal: AbortSignal.timeout(45000) });
    report = response.content?.find((b) => b.type === "tool_use" && b.name === REPORT.name)?.input || null;
  } catch (e) {
    console.log("[connection-jobs] could not check: " + e.message);
    return { voice: undefined, jobs: undefined };
  }
  if (!report) return { voice: undefined, jobs: undefined };
  const speak = check(candidates, report.speak, "speak");
  const hear = check(candidates, report.hear, "hear");
  const jobs = Object.fromEntries(Object.keys(TOOL_JOBS).map((name) => [name, checkTool(candidates, report[name], name)]));
  return { voice: speak || hear ? { speak, hear } : null, jobs };
}

// What was found, as saved: each job switched on the first time it is found,
// and left as the person set it after that. A check that couldn't run keeps
// what was found before.
function saved(found, previousVoice, previousJobs) {
  const now = new Date().toISOString();
  let voice = previousVoice || null;
  if (found.voice !== undefined) {
    voice = found.voice ? { ...found.voice, on: previousVoice ? !!previousVoice.on : true, checked_at: now, ...(previousVoice?.fallback ? { fallback: previousVoice.fallback } : {}) } : null;
  }
  const jobs = { ...(previousJobs || {}) };
  if (found.jobs !== undefined) {
    for (const [name, plan] of Object.entries(found.jobs)) {
      const before = previousJobs?.[name];
      if (plan) jobs[name] = { ...plan, on: before ? !!before.on : true, checked_at: now, ...(before?.fallback ? { fallback: before.fallback } : {}) };
      else delete jobs[name];
    }
  }
  return { voice, jobs };
}

module.exports = { findJobs, saved, check, checkTool, maybeAJob, TOOL_JOBS, MAYBE_VOICE, REPORT };
