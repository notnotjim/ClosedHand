// webapp/voice-tools.js: can a connected service be Closedhand's voice?
//
// When someone connects a service (or tests it), its tools are read once to
// see whether one turns text into speech or speech into text, and how to call
// it. The person's own model reads the definitions, so no service needs code
// of its own; this file then checks the answer against the definitions
// themselves and keeps only what fits them. The plan is saved in the
// connection's caps.voice, and the bot calls those tools directly for voice
// notes, the web chat's mic, spoken replies and Read aloud
// (lib/voice-connections.js).

// Only tools that could have to do with voice go to the model, so most
// services cost nothing to check.
const MAYBE_VOICE = /speech|speak|voice|audio|tts|stt|transcri|dictat|narrat|sound/i;

const REPORT = {
  name: "report_voice_tools",
  description: "Report which tool, if any, turns text into speech and which turns speech into text.",
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
        },
        required: ["found"],
      },
      hear: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          tool: { type: "string" },
          audio_argument: { type: "string", description: "The argument that holds the recording." },
          audio_as: { type: "string", enum: ["base64", "path", "url"] },
          fixed_arguments: { type: "object" },
        },
        required: ["found"],
      },
    },
    required: ["speak", "hear"],
  },
};

const SYSTEM = "You read the tools of a service someone has connected to Closedhand, their personal assistant, and report whether one of them turns text into speech or recorded speech into text, so Closedhand can use it for its own voice. Report only with the report_voice_tools tool.";

function prompt(tools) {
  return `Tool definitions:
${JSON.stringify(tools.map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 1500), inputSchema: t.inputSchema || {} })), null, 1)}

Report:
- speak: a tool that takes words and returns them spoken, as audio or as a link to audio. text_argument is the argument for the words. format_argument is the argument that picks the audio format or encoding, if there is one.
- hear: a tool that takes a recording of speech and returns the words. audio_argument is the argument for the recording, and audio_as is how it wants it: "base64" (the audio as base64 text), "path" (a file on the same computer) or "url" (a web address).
- fixed_arguments: values for any other required arguments, only when the definition makes the value clear, such as a default or the one sensible choice of an enum. Never make up ids, such as a voice id.
- Tools that make music or sound effects, change one voice into another, or manage voices, agents or accounts are neither.
- found is false when no tool fits.`;
}

// Keeps a reported tool only when its definition bears it out: the tool
// exists, every named argument is one of its own, and every required
// argument is given or has a default.
function check(tools, report, job) {
  if (!report || report.found !== true) return null;
  const tool = tools.find((t) => t.name === report.tool);
  if (!tool) return null;
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const main = job === "speak" ? report.text_argument : report.audio_argument;
  if (!main || !props[main]) return null;
  const fixed = {};
  for (const [k, v] of Object.entries(report.fixed_arguments || {})) {
    if (!props[k] || k === main) return null;
    if (Array.isArray(props[k].enum) && !props[k].enum.includes(v)) return null;
    fixed[k] = v;
  }
  let format = null;
  if (job === "speak" && report.format_argument) {
    const arg = report.format_argument;
    if (!props[arg]) return null;
    const values = Array.isArray(props[arg].enum) ? props[arg].enum.filter((v) => typeof v === "string") : null;
    if (values && values.length) format = { arg, values };
    else if ((schema.required || []).includes(arg) && !(arg in fixed)) return null;
  }
  const given = new Set([main, ...Object.keys(fixed), ...(format ? [format.arg] : [])]);
  for (const r of schema.required || []) if (!given.has(r) && props[r]?.default === undefined) return null;
  if (job === "speak") return { tool: tool.name, text: main, format, fixed };
  // A web address would need the recording put online first; that isn't done.
  if (!["base64", "path"].includes(report.audio_as)) return null;
  return { tool: tool.name, audio: main, as: report.audio_as, fixed };
}

// tools: [{ name, description, inputSchema }]; selected: the person's model
// (model-policy getRole). Returns { speak, hear } with null for a job no tool
// does; null when no tool fits; undefined when it couldn't be checked (no
// model, or the model failed), so what was found before can stand.
async function findVoiceTools(tools, selected, deps = {}) {
  const candidates = (tools || []).filter((t) => MAYBE_VOICE.test(`${t.name} ${t.description || ""}`));
  if (!candidates.length) return null;
  if (!selected) return undefined;
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
    console.log("[voice-tools] could not check: " + e.message);
    return undefined;
  }
  if (!report) return undefined;
  const speak = check(candidates, report.speak, "speak");
  const hear = check(candidates, report.hear, "hear");
  return speak || hear ? { speak, hear } : null;
}

module.exports = { findVoiceTools, check, MAYBE_VOICE };
