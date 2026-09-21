/* Shared model setup for onboarding and Settings. No key leaves the chosen host. */
(function () {
  var providers = {
    anthropic: "Anthropic", deepinfra: "DeepInfra", deepseek: "DeepSeek", gemini: "Google Gemini",
    groq: "Groq", moonshot: "Moonshot", openai: "OpenAI", openrouter: "OpenRouter", xai: "xAI",
    ollama: "Ollama (local models)", custom: "Other compatible service"
  };
  function mount(root, onSaved) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = "true";
    var options = '<option value="">Choose a provider</option>' + Object.keys(providers).map(function (key) { return '<option value="' + key + '">' + providers[key] + '</option>'; }).join('');
    root.innerHTML = '<div class="model-current" data-region="current" hidden></div><details class="model-editor" data-region="editor" open><summary hidden>Change models</summary><div class="model-fields">' +
      '<label>Model provider<select data-field="provider">' + options + '</select></label>' +
      '<p class="model-hint" data-region="provider-help">Choose the service that runs your models. For models on your own hardware, choose Ollama or Other compatible service.</p>' +
      '<div data-region="connection" class="model-fields" hidden>' +
      '<label data-region="address" hidden>Service URL<input data-field="baseUrl" type="url" placeholder="https://provider.example/v1" spellcheck="false"></label>' +
      '<label data-region="key">API key<input data-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the API key from this provider"></label>' +
      '<p class="model-hint" data-region="connection-help"></p>' +
      '<button type="button" data-action="load" hidden>Retry loading models</button>' +
      '</div><div data-region="selection" class="model-fields" hidden>' +
      '<label>Chat model<select data-picker="model"></select></label><label data-manual="model" hidden>Chat model ID<input data-field="model" spellcheck="false" placeholder="Enter the provider\'s exact model ID"></label>' +
      '<details data-region="extras"><summary>Support and image models</summary><div class="model-fields">' +
      '<label>Support model<select data-picker="backgroundModel"></select></label><label data-manual="backgroundModel" hidden>Support model ID<input data-field="backgroundModel" spellcheck="false"></label>' +
      '<p class="model-hint">The support model does routine work, like naming conversations and writing summaries, so it can be a smaller model from the same provider.</p>' +
      '<label>Images<select data-field="visionMode"><option value="same">Use the chat model</option><option value="separate">Choose another image model</option><option value="off">Continue without image understanding</option></select></label>' +
      '<div data-region="vision" class="model-fields" hidden><label>Image provider<select data-field="visionProvider"><option value="">Use the same provider</option>' + options.replace('<option value="">Choose a provider</option>', '') + '</select></label>' +
      '<div data-region="vision-connection" class="model-fields" hidden><label data-region="vision-address" hidden>Service URL<input type="url" data-field="visionBaseUrl" spellcheck="false"></label>' +
      '<label data-region="vision-key">Image provider API key<input data-field="visionKey" type="password" autocomplete="off" spellcheck="false"></label></div>' +
      '<button type="button" data-action="load-vision" hidden>Retry loading image models</button>' +
      '<label>Image model<select data-picker="visionModel"></select></label><label data-manual="visionModel" hidden>Image model ID<input data-field="visionModel" spellcheck="false"></label></div>' +
      '</div></details>' +
      '</div>' +
      '<section class="model-check" data-region="check" hidden aria-live="polite"><h3 data-region="check-title"></h3><dl class="model-role-list" data-region="check-rows"></dl><p class="model-hint" data-region="memory" hidden></p>' +
      '<button type="button" data-action="recheck" hidden>Check again</button><button type="button" data-action="save" hidden>Use these models</button></section>' +
      '<div class="model-result" role="status" aria-live="polite" tabindex="-1"></div><button type="button" data-action="reload" hidden>Retry loading settings</button>' +
      '<details data-region="default" hidden><summary>Return to the hosted models</summary><div class="model-fields">' +
      '<p>This removes your own model connections from ClosedHand. Conversations, summaries and images will use the hosted service\'s models. Context Brain and File Search keep their existing recall provider.</p>' +
      '<button type="button" data-action="default">Use the hosted models</button></div></details></div></details>';
    var saved = null, ticket = null, models = [], imageModels = [], busy = false, allowDefault = false;
    var loads = { primary: 0, vision: 0 }, runtime = "", initialized = false;
    var check = null, checkTimer = null, checks = 0;
    var loadTimers = { primary: null, vision: null }, connectionValues = { primary: null, vision: null };
    var field = function (key) { return root.querySelector('[data-field="' + key + '"]'); };
    var region = function (key) { return root.querySelector('[data-region="' + key + '"]'); };
    var result = root.querySelector(".model-result");
    function renderCurrent(data) {
      var current = region("current");
      current.replaceChildren();
      var rows = data.config ? (data.activeModels || []) : [];
      current.hidden = !rows.length;
      if (!rows.length) return;
      var list = document.createElement("dl"); list.className = "model-role-list";
      // What each role does, shown on hover over its name.
      var tips = {
        "Chat model": "Talks with you. Every message you send goes through this model.",
        "Support model": "Does routine work like naming conversations and writing summaries.",
        "Images": "Looks at photos and screenshots you send.",
        "Document summaries": "Summarises mail and documents as they are indexed.",
        "Recall": "Finds the memories, mail and files that relate to what you ask. Stays the same when you change your chat model.",
        "Search ranking": "Puts the closest matches first. Stays the same when you change your chat model."
      };
      rows.forEach(function (row) {
        var term = document.createElement("dt"); term.textContent = row.label;
        if (tips[row.label]) {
          term.dataset.tip = tips[row.label]; term.tabIndex = 0;
          var mark = document.createElement("span"); mark.className = "tip-mark"; mark.textContent = "i"; mark.setAttribute("aria-hidden", "true");
          term.append(mark);
        }
        var definition = document.createElement("dd");
        var name = document.createElement("span"); name.textContent = row.model.replace(/^local:/, "");
        definition.append(name);
        if (row.provider) { var provider = document.createElement("small"); provider.textContent = row.provider; definition.append(provider); }
        list.append(term, definition);
      });
      current.append(list);
      var download = data.localModels?.embedder;
      if (download && ["downloading", "error"].includes(download.state)) {
        var status = document.createElement("p"); status.className = "model-hint";
        status.textContent = download.state === "downloading" ? "Downloading the recall model: " + (download.pct || 0) + "%." : "The recall model could not finish downloading. ClosedHand will retry when syncing.";
        current.append(status);
      }
    }
    function value(key) { return field(key).value.trim(); }
    function modelName(model, provider) {
      // Official DeepSeek API aliases, verified 2026-09-15. IDs remain unchanged.
      if (provider === "deepseek") {
        if (model.id === "deepseek-flash") return "DeepSeek V4.1 Flash";
        if (model.id === "deepseek-v4-pro") return "DeepSeek V4 Pro";
      }
      return model.name || model.id;
    }
    function refreshPicker(key, available, provider) {
      var picker = root.querySelector('[data-picker="' + key + '"]');
      var current = value(key);
      picker.replaceChildren();
      function add(id, label) { var option = document.createElement("option"); option.value = id; option.textContent = label; picker.append(option); }
      add("", key === "backgroundModel" ? "Use the chat model" : "Choose a model");
      available.forEach(function (model) {
        var name = modelName(model, provider);
        add(model.id, name);
      });
      if (current && !available.some(function (model) { return model.id === current; })) {
        var name = modelName({ id: current }, provider);
        add(current, name);
      }
      add("__manual__", "Enter a model ID manually");
      picker.value = current;
      root.querySelector('[data-manual="' + key + '"]').hidden = true;
      var hint = root.querySelector('[data-model-id="' + key + '"]');
      if (!hint) {
        hint = document.createElement("p"); hint.className = "model-hint"; hint.dataset.modelId = key;
        picker.parentElement.after(hint);
      }
      hint.textContent = current ? "Model ID: " + current : "";
      hint.hidden = !current;
    }
    function refreshPickers() {
      refreshPicker("model", models, value("provider"));
      refreshPicker("backgroundModel", models, value("provider"));
      var images = value("visionProvider") ? imageModels : models.filter(function (model) { return model.capabilities?.vision !== false; });
      refreshPicker("visionModel", images, value("visionProvider") || value("provider"));
    }
    function show(message, error) { result.textContent = message; result.classList.toggle("is-error", !!error); }
    function invalidate() { ticket = null; }
    function visibility() {
      var provider = value("provider"), local = provider === "ollama", custom = provider === "custom";
      region("connection").hidden = !provider;
      region("key").hidden = local;
      region("provider-help").textContent = !provider
        ? "Choose the service that runs your models. For models on your own hardware, choose Ollama or Other compatible service."
        : local ? "Ollama runs models on your own hardware. It must already be running with a model installed."
        : custom ? "Connect a service that supports the OpenAI-compatible API. Where requests are processed depends on that service."
        : "Your requests are processed by " + providers[provider] + " under its own terms. Its usage charges are separate from ClosedHand.";
      region("connection-help").textContent = local
        ? runtime === "docker" ? "This URL reaches Ollama on the computer running Docker. Ollama must accept connections from Docker. Change it if Ollama runs elsewhere."
          : runtime === "desktop" ? "This URL reaches Ollama on this Mac. Change it if Ollama runs elsewhere."
          : "Enter the URL where this ClosedHand installation can reach Ollama. A hosted installation cannot reach your computer through localhost."
        : custom ? "Enter the service URL and an API key if the service requires one."
        : "Paste an API key from this provider to load its models. ClosedHand sends it only to that provider.";
      region("address").hidden = !["custom", "ollama"].includes(value("provider"));
      region("vision").hidden = value("visionMode") !== "separate";
      region("vision-connection").hidden = !value("visionProvider");
      region("vision-address").hidden = !["custom", "ollama"].includes(value("visionProvider"));
      region("vision-key").hidden = value("visionProvider") === "ollama";
    }
    function savedKey(kind, provider, baseUrl, apiKey) {
      var prior = saved?.connections?.[kind];
      return !apiKey && !!prior?.hasKey && prior.provider === provider && (prior.baseUrl || "") === baseUrl;
    }
    function input() {
      return { primary: { provider: value("provider"), baseUrl: value("baseUrl"), apiKey: value("apiKey"),
        useSavedKey: savedKey("primary", value("provider"), value("baseUrl"), value("apiKey")) },
        model: value("model"), backgroundModel: value("backgroundModel"), visionMode: value("visionMode"),
        vision: { provider: value("visionProvider"), baseUrl: value("visionBaseUrl"), apiKey: value("visionKey"),
          useSavedKey: savedKey("vision", value("visionProvider"), value("visionBaseUrl"), value("visionKey")) },
        visionModel: value("visionModel") };
    }
    async function call(path, body) {
      var response;
      try {
        response = await fetch("/api/model-config" + path, { method: body ? "POST" : "GET",
          headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (_) { throw new Error("Could not reach ClosedHand. Check that it is running, then try again."); }
      var data;
      try { data = await response.json(); } catch (_) { throw new Error("ClosedHand returned an unexpected response. Reload this page and try again."); }
      if (!response.ok) {
        var message = data.error || "Could not update the models. Try again.";
        if (/fetch failed|failed to fetch|networkerror|load failed|timeout|timed out/i.test(message)) {
          message = ["/models", "/check"].includes(path) ? "Could not connect to the selected model service. Check its URL or your internet connection, then try again."
            : "Could not load your model settings. Try loading them again.";
        }
        var error = new Error(message); error.visionNeeded = data.visionNeeded; throw error;
      }
      return data;
    }
    async function perform(fn) {
      if (busy) return;
      busy = true;
      root.setAttribute("aria-busy", "true");
      root.querySelectorAll("button,input,select").forEach(function (el) { el.disabled = true; });
      try { await fn(); } catch (e) {
        show(e.message || "Could not reach ClosedHand. Try again.", true);
      } finally {
        busy = false; root.removeAttribute("aria-busy");
        root.querySelectorAll("button,input,select").forEach(function (el) { el.disabled = false; });
      }
    }
    function ready(kind) {
      var vision = kind === "vision";
      var provider = vision ? value("visionProvider") : value("provider");
      var key = vision ? value("visionKey") : value("apiKey");
      var base = vision ? value("visionBaseUrl") : value("baseUrl");
      var prior = saved?.connections?.[kind];
      if (!provider) return false;
      if (vision && value("visionMode") !== "separate") return false;
      if (["ollama", "custom"].includes(provider)) {
        try { var url = new URL(base); return ["http:", "https:"].includes(url.protocol) && !!url.hostname; }
        catch (_) { return false; }
      }
      return !!key || !!(prior?.hasKey && prior.provider === provider && (prior.baseUrl || "") === base);
    }
    async function loadModels(kind, quiet) {
      clearTimeout(loadTimers[kind]);
      var token = ++loads[kind], vision = kind === "vision";
      var retry = root.querySelector('[data-action="' + (vision ? "load-vision" : "load") + '"]');
      retry.hidden = true;
      if (!ready(kind)) { if (!quiet) show("Choose a provider and complete its connection details first.", true); return; }
      if (!quiet) show(vision ? "Loading image models..." : "Loading available models...");
      try {
        var body = input(); body.connection = kind;
        var data = await call("/models", body);
        if (token !== loads[kind]) return;
        if (vision) imageModels = data.models.filter(function (model) { return model.capabilities.vision !== false; });
        else models = data.models;
        retry.hidden = !!(vision ? imageModels : models).length;
        refreshPickers();
        region("selection").hidden = false;
        if (!vision) renderCheck();
        if (!quiet) {
          show((vision ? imageModels : models).length ? (vision ? "Choose an image model from the list." : "Choose a chat model from the list. ClosedHand checks that it can carry out tasks and read images before saving.")
            : "The service returned no models. Check that a model is available, or enter its model ID below.");
          scheduleCheck();
        }
      } catch (e) {
        if (token !== loads[kind]) return;
        show(e.message || "Could not reach ClosedHand. Try again.", true);
        retry.hidden = false; region("selection").hidden = false;
      }
    }
    function chosen(key) { var v = value(key); return v && v !== "__manual__" ? v : ""; }
    function complete() {
      if (!value("provider") || !ready("primary") || !chosen("model")) return false;
      if (value("visionMode") === "separate") {
        if (!chosen("visionModel")) return false;
        if (value("visionProvider") && !ready("vision")) return false;
      }
      return true;
    }
    // The check runs by itself once the selection is complete, and again after
    // every change. Passing it is what allows the save.
    function scheduleCheck() {
      clearTimeout(checkTimer); checks++; ticket = null;
      check = chosen("model") ? { kind: "idle" } : null; renderCheck();
      checkTimer = setTimeout(runCheck, 800);
    }
    async function runCheck() {
      clearTimeout(checkTimer);
      var token = ++checks;
      ticket = null;
      if (!complete()) { check = chosen("model") ? { kind: "idle" } : null; renderCheck(); return; }
      show(""); check = { kind: "checking" }; renderCheck();
      try {
        var data = await call("/check", input());
        if (token !== checks) return;
        ticket = data.ticket; check = { kind: "passed", config: data.config, memory: data.memory };
      } catch (e) {
        if (token !== checks) return;
        check = { kind: "failed", error: e.message || "Could not reach ClosedHand. Try again.", visionNeeded: !!e.visionNeeded };
        if (e.visionNeeded) region("extras").open = true;
      }
      renderCheck();
    }
    function providerLabel(conn) {
      if (providers[conn.provider]) return providers[conn.provider];
      try { return new URL(conn.baseUrl).hostname; } catch (e) { return ""; }
    }
    function catalogCaps(key) {
      var id = chosen(key), m = models.find(function (x) { return x.id === id; });
      return m ? m.capabilities : null;
    }
    function renderCheck() {
      var panel = region("check"), rows = region("check-rows"), title = region("check-title"), memory = region("memory");
      var save = root.querySelector('[data-action="save"]'), again = root.querySelector('[data-action="recheck"]');
      rows.replaceChildren(); save.hidden = true; again.hidden = true; memory.hidden = true;
      if (!check) { panel.hidden = true; return; }
      panel.hidden = false;
      var kind = check.kind, cfg = check.config || null;
      var chat = cfg ? cfg.roles.chat : null, support = cfg ? cfg.roles.background : null, vision = cfg ? cfg.roles.vision : null;
      var cap = chat ? chat.capabilities || {} : catalogCaps("model") || {};
      var chatProvider = cfg ? cfg.connections[chat.connection].provider : value("provider");
      var chatName = modelName({ id: chat ? chat.model : chosen("model") }, chatProvider);
      var provName = cfg ? providerLabel(cfg.connections.primary) : providers[value("provider")] || "";
      function row(label, text, state) {
        var dt = document.createElement("dt"); dt.textContent = label;
        var dd = document.createElement("dd"); dd.textContent = text; if (state) dd.className = "is-" + state;
        rows.append(dt, dd);
      }
      title.textContent = kind === "checking" ? "Checking " + chatName + "..." : kind === "passed" ? "Checked and working"
        : kind === "failed" ? "The check did not pass" : kind === "saved" ? "These models are in use" : complete() ? "Preparing model check..." : "Complete the connection details to check these models";
      row("Chat model", chatName + (provName ? " via " + provName : ""));
      var settled = kind === "passed" || kind === "saved" || (kind === "failed" && check.visionNeeded);
      if (kind === "failed" && !check.visionNeeded) row("Problem", check.error, "fail");
      row("Tool calls", settled ? "Works" : kind === "checking" ? "Checking" : cap.tools === false ? "Not offered by this model" : "Not checked yet",
        settled ? "ok" : kind === "checking" ? "wait" : cap.tools === false ? "fail" : "wait");
      var mode = value("visionMode");
      if (kind === "failed" && check.visionNeeded) row("Images", check.error, "fail");
      else if (mode === "off" || ((kind === "passed" || kind === "saved") && !vision)) row("Images", "Off");
      else if (kind === "passed" || kind === "saved") {
        var same = vision.connection === "primary" && vision.model === chat.model;
        row("Images", same ? "Accepts images" : "Read by " + modelName({ id: vision.model }, cfg.connections[vision.connection].provider) + " via " + providerLabel(cfg.connections[vision.connection]), "ok");
      } else if (kind === "checking") row("Images", "Checking", "wait");
      else row("Images", cap.vision === true ? "Accepts images" : cap.vision === false ? "Text only, choose an image model below or turn images off" : "Not checked yet", cap.vision === true ? "ok" : cap.vision === false ? "fail" : "wait");
      row("Thinking effort", cap.reasoning ? "ClosedHand sets it per task" : "Fixed by the model", cap.reasoning ? "ok" : "");
      row("Context limit", cap.contextWindow ? cap.contextWindow.toLocaleString() + " tokens" : "Not published by the provider");
      var supportId = support ? support.model : chosen("backgroundModel");
      var sameSupport = !supportId || supportId === (chat ? chat.model : chosen("model"));
      row("Support model", sameSupport ? "Same as the chat model" : modelName({ id: supportId }, chatProvider),
        sameSupport ? "" : settled ? "ok" : kind === "checking" ? "wait" : "");
      if (kind === "passed" && check.memory) { memory.textContent = check.memory; memory.hidden = false; }
      save.hidden = kind !== "passed";
      again.hidden = kind !== "failed";
    }
    function scheduleLoad(kind) {
      clearTimeout(loadTimers[kind]);
      if (!ready(kind)) return;
      loadTimers[kind] = setTimeout(function () { loadModels(kind); }, 700);
    }
    function connectionInput(kind) {
      var current = JSON.stringify(input()[kind]);
      // A paste fires input, then change on blur. Do not erase or reload the
      // same connection twice, including while its first request is pending.
      if (connectionValues[kind] === current) return;
      connectionEdited(kind);
      connectionValues[kind] = current;
      scheduleLoad(kind);
    }
    function connectionEdited(kind) {
      clearTimeout(loadTimers[kind]); connectionValues[kind] = null;
      root.querySelector('[data-action="' + (kind === "vision" ? "load-vision" : "load") + '"]').hidden = true;
      loads[kind]++; checks++; clearTimeout(checkTimer);
      ticket = null; check = null; renderCheck(); show("");
      if (kind === "primary") {
        models = []; field("model").value = ""; field("backgroundModel").value = "";
        if (!value("visionProvider")) field("visionModel").value = "";
        region("selection").hidden = true;
      } else { imageModels = []; field("visionModel").value = ""; }

      refreshPickers();
    }
    function connectionField(target) {
      if ([field("apiKey"), field("baseUrl")].includes(target)) return "primary";
      if ([field("visionKey"), field("visionBaseUrl")].includes(target)) return "vision";
      return null;
    }
    root.addEventListener("input", function (ev) {
      var kind = connectionField(ev.target);
      if (kind) { connectionInput(kind); return; }
      invalidate(); scheduleCheck();
    });
    root.addEventListener("change", function (ev) {
      var kind = connectionField(ev.target);
      if (kind) { connectionInput(kind); return; }
      if (ev.target.dataset.picker) {
        var key = ev.target.dataset.picker, manual = ev.target.value === "__manual__";
        root.querySelector('[data-manual="' + key + '"]').hidden = !manual;
        if (manual) { field(key).value = ""; field(key).focus(); }
        else field(key).value = ev.target.value;
        var hint = root.querySelector('[data-model-id="' + key + '"]');
        hint.textContent = value(key) ? "Model ID: " + value(key) : "";
        hint.hidden = manual || !value(key);
      }
      invalidate(); visibility(); scheduleCheck();
      if (ev.target === field("provider")) {
        connectionEdited("primary"); connectionEdited("vision"); region("selection").hidden = true;
        models = []; field("apiKey").value = ""; field("apiKey").placeholder = "Paste the API key from this provider"; field("model").value = ""; field("backgroundModel").value = "";
        field("baseUrl").value = value("provider") === "ollama" ? (runtime === "desktop" ? "http://localhost:11434/v1" : runtime === "docker" ? "http://host.docker.internal:11434/v1" : "") : "";
        imageModels = []; field("visionModel").value = ""; field("visionProvider").value = ""; field("visionKey").value = ""; field("visionBaseUrl").value = ""; field("visionMode").value = "same"; refreshPickers();
        visibility(); show("");
        connectionValues.primary = JSON.stringify(input().primary); scheduleLoad("primary");
      }
      if (ev.target === field("visionProvider")) {
        field("visionKey").value = ""; field("visionModel").value = "";
        field("visionBaseUrl").value = value("visionProvider") === "ollama" ? (runtime === "desktop" ? "http://localhost:11434/v1" : runtime === "docker" ? "http://host.docker.internal:11434/v1" : "") : "";
        imageModels = []; refreshPickers();
        connectionEdited("vision"); visibility();
        if (!value("visionProvider")) scheduleCheck();
        connectionValues.vision = JSON.stringify(input().vision); scheduleLoad("vision");
      }
      if (ev.target === field("visionMode")) {
        clearTimeout(loadTimers.vision); loads.vision++;
        root.querySelector('[data-action="load-vision"]').hidden = true;
        if (value("visionMode") === "separate") scheduleLoad("vision");
      }
    });
    root.querySelector('[data-action="load"]').onclick = function () { loadModels("primary"); };
    root.querySelector('[data-action="load-vision"]').onclick = function () { loadModels("vision"); };
    root.querySelector('[data-action="recheck"]').onclick = function () { runCheck(); };
    root.querySelector('[data-action="save"]').onclick = function () { if (!ticket) return; perform(async function () {
      show("Saving models..."); await call("/save", { ticket: ticket });
      field("apiKey").value = ""; field("visionKey").value = "";
      field("visionKey").placeholder = "Saved key, leave blank to keep it"; invalidate(); clearTimeout(checkTimer); checks++;
      var updated = await call(""); saved = updated.config; renderCurrent(updated);
      field("baseUrl").value = saved.connections.primary.baseUrl || "";
      field("visionBaseUrl").value = saved.connections.vision?.baseUrl || "";
      field("apiKey").placeholder = saved.connections.primary.hasKey ? "Saved key, leave blank to keep it" : "Paste the API key from this provider";
      region("editor").querySelector("summary").hidden = false;
      check = { kind: "saved", config: saved }; renderCheck();
      region("default").hidden = !allowDefault;
      show("Models updated. New requests use these choices."); result.focus();
      if (onSaved) onSaved();
    }); };
    root.querySelector('[data-action="default"]').onclick = function () { perform(async function () {
      clearTimeout(loadTimers.primary); clearTimeout(loadTimers.vision);
      await call("/default", {}); saved = null; invalidate(); renderCurrent(await call(""));
      root.querySelectorAll("input").forEach(function (el) { el.value = ""; });
      field("provider").value = ""; field("visionProvider").value = ""; field("visionMode").value = "same";
      region("selection").hidden = true; loads.primary++; loads.vision++; models = []; imageModels = []; refreshPickers(); visibility();
      clearTimeout(checkTimer); checks++; check = null; renderCheck();
      region("default").hidden = true;
      show("ClosedHand's hosted models are active."); result.focus();
      if (onSaved) onSaved();
    }); };
    async function initialize() {
      region("connection").hidden = true;
      root.querySelector('[data-action="reload"]').hidden = true;
      try { await perform(async function () {
      var data = await call(""); show(""); initialized = true; runtime = data.runtime || ""; saved = data.config; renderCurrent(data);
      region("editor").open = !saved && !data.allowDefault;
      // "Change models" only makes sense once there are models to change.
      region("editor").querySelector("summary").hidden = !saved && !data.allowDefault;
      allowDefault = !!data.allowDefault;
      region("default").hidden = !allowDefault || !saved;
      if (!saved) { refreshPickers(); visibility(); if (data.allowDefault) show("ClosedHand's hosted models are active. You can connect your own models here."); return; }
      var primary = saved.connections.primary;
      field("provider").value = primary.provider; field("baseUrl").value = primary.baseUrl;
      field("apiKey").placeholder = primary.hasKey ? "Saved key, leave blank to keep it" : "Paste your key";
      region("selection").hidden = false;
      field("model").value = saved.roles.chat.model;
      field("backgroundModel").value = saved.roles.background?.model || "";
      var vision = saved.roles.vision;
      field("visionMode").value = !vision ? (data.legacy ? "same" : "off") : vision.connection === "primary" && vision.model === saved.roles.chat.model ? "same" : "separate";
      if (vision) {
        field("visionModel").value = vision.model;
        if (vision.connection === "vision") {
          field("visionProvider").value = saved.connections.vision.provider;
          field("visionBaseUrl").value = saved.connections.vision.baseUrl;
          field("visionKey").placeholder = "Saved key, leave blank to keep it";
        }
      }
      refreshPickers(); visibility(); check = { kind: "saved", config: saved }; renderCheck();
      if (data.legacy) show("The models shown above are active. Check and review your choices here before applying a change.");
      loadModels("primary", true);
      if (vision && vision.connection === "vision") loadModels("vision", true);
      }); } finally {
        root.querySelector('[data-action="reload"]').hidden = initialized;
        field("provider").disabled = !initialized;
      }
    }
    root.querySelector('[data-action="reload"]').onclick = initialize;
    initialize();
  }
  window.ClosedHandModels = { mount: mount };
}());
