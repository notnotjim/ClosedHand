// Vendored for the separate bot and webapp. Only explicit opt-in uses TypeSafe.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
function publicStatus(settings = {}) {
  return { enabled: settings.typesafe_enabled === true && typeof settings.typesafe_api_key === "string" && !!settings.typesafe_api_key.trim() };
}
function apiKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /\s/.test(value.trim())) throw new Error("Paste your TypeSafe API key.");
  return value.trim();
}
function failure(status) {
  const message = status === 401 || status === 403 ? "TypeSafe rejected this key. Check it and try again."
    : status === 402 ? "Your TypeSafe account needs credit. Add credit, then try connecting Jev again."
    : status === 429 ? "TypeSafe is busy or your account has reached its limit. Try again later."
    : "Jev could not complete the check. Your support model is still available. Try again later.";
  return Object.assign(new Error(message), { status });
}
async function choices(key, state, questions, options = {}) {
  key = apiKey(key);
  const ids = Object.keys(questions);
  if (!ids.length || ids.length > 50 || Buffer.byteLength(JSON.stringify(state)) > 16000) throw new Error("Decision input is too large.");
  for (const q of Object.values(questions)) {
    if (q.type !== "choice" || typeof q.instructions !== "string" || !q.instructions ||
      !q.criteria || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255) throw new Error("Invalid decision question.");
  }
  const body = JSON.stringify({ model: MODEL, state, questions });
  if (Buffer.byteLength(body) > 60000) throw new Error("Decision input is too large.");
  let data;
  try {
    const response = await (options.fetch || fetch)(ENDPOINT, { method: "POST", redirect: "error",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(options.timeoutMs || 5000) });
    // Provider bodies and network errors can contain echoed keys or private inputs.
    if (!response.ok) throw failure(response.status);
    const text = await response.text();
    if (text.length > 100000) throw failure();
    data = JSON.parse(text);
  } catch (error) {
    throw failure(Number.isInteger(error.status) ? error.status : undefined);
  }
  if (data?.model !== MODEL || !data.answers || Array.isArray(data.answers) ||
      Object.keys(data.answers).length !== ids.length) throw failure();
  for (const id of ids) {
    const answer = data.answers[id], names = Object.keys(questions[id].criteria);
    const unit = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    if (answer?.type !== "choice" || !names.includes(answer.choice) || !unit(answer.confidence) ||
        !answer.probabilities || Object.keys(answer.probabilities).length !== names.length ||
        !names.every(name => unit(answer.probabilities[name])) ||
        Math.abs(names.reduce((sum, name) => sum + answer.probabilities[name], 0) - 1) > 0.02 ||
        names.some(name => answer.probabilities[name] > answer.probabilities[answer.choice])) throw failure();
  }
  return data.answers;
}
async function validate(key, options) {
  const answers = await choices(key, { message: "The connection is ready." }, {
    connection: { type: "choice", instructions: "Does the message say the connection is ready?",
      criteria: { ready: "The message explicitly says the connection is ready.", other: "It does not." } }
  }, { ...options, timeoutMs: 15000 });
  if (answers.connection.choice !== "ready") throw failure();
}
module.exports = { MODEL, ENDPOINT, publicStatus, apiKey, choices, validate };
