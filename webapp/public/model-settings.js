/* Shared model setup for onboarding and Settings. No key leaves the chosen host. */
(function () {
  var providers = {
    anthropic: "Anthropic", deepinfra: "DeepInfra", deepseek: "DeepSeek", gemini: "Google Gemini",
    groq: "Groq", moonshot: "Moonshot", openai: "OpenAI", openrouter: "OpenRouter", xai: "xAI",
    ollama: "Ollama on your computer", custom: "Another provider"
  };
  function mount(root, onSaved) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = "true";
    var options = '<option value="">Choose a provider</option>' + Object.keys(providers).map(function (key) { return '<option value="' + key + '">' + providers[key] + '</option>'; }).join('');
    root.innerHTML = '<div class="model-current" data-region="current" hidden></div><details class="model-editor" data-region="editor" open><summary>Change models</summary><div class="model-fields">' +
      '<label>Provider<select data-field="provider">' + options + '</select></label>' +
      '<label data-region="address" hidden>Base URL<input data-field="baseUrl" type="url" placeholder="https://provider.example/v1" spellcheck="false"></label>' +
      '<label>API key<input data-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key"></label>' +
      '<p class="model-hint">Your key is sent only to the provider you choose. The models it offers appear below. Nothing changes until you save.</p>' +
      '<button type="button" data-action="load" hidden>Try loading the models again</button>' +
      '<label>Chat model<select data-picker="model"></select></label><label data-manual="model" hidden>Chat model ID<input data-field="model" spellcheck="false" placeholder="Enter the provider\'s exact model ID"></label>' +
      '<p class="model-hint" data-region="capabilities"></p>' +
      '<details data-region="extras"><summary>Models for summaries and images</summary><div class="model-fields">' +
      '<label>Summaries model<select data-picker="backgroundModel"></select></label><label data-manual="backgroundModel" hidden>Summaries model ID<input data-field="backgroundModel" spellcheck="false"></label>' +
      '<p class="model-hint">You can use a smaller model from the same provider for routine work. Leave this blank to use your chat model. ClosedHand adjusts the chat model\'s thinking effort separately, when its provider supports it.</p>' +
      '<label>Images<select data-field="visionMode"><option value="same">Use the chat model</option><option value="separate">Choose another image model</option><option value="off">Continue without image understanding</option></select></label>' +
      '<div data-region="vision" class="model-fields" hidden><label>Image provider<select data-field="visionProvider"><option value="">Use the same provider</option>' + options.replace('<option value="">Choose a provider</option>', '') + '</select></label>' +
      '<div data-region="vision-connection" class="model-fields" hidden><label data-region="vision-address" hidden>Base URL<input type="url" data-field="visionBaseUrl" spellcheck="false"></label>' +
      '<label>Image provider API key<input data-field="visionKey" type="password" autocomplete="off" spellcheck="false"></label></div>' +
      '<button type="button" data-action="load-vision" hidden>Try loading the image models again</button>' +
      '<label>Image model<select data-picker="visionModel"></select></label><label data-manual="visionModel" hidden>Image model ID<input data-field="visionModel" spellcheck="false"></label></div>' +
      '</div></details><p class="model-hint">Checking sends a few short test requests to the selected models. Your provider may charge for them.</p>' +
      '<button type="button" data-action="check">Check models</button>' +
      '<div class="model-result" role="status" aria-live="polite" tabindex="-1"></div>' +
      '<section class="model-preview" hidden tabindex="-1" aria-label="Review model changes"><h3>Review your models</h3><div data-region="review"></div><p data-region="memory"></p>' +
      '<button type="button" data-action="save">Use these models</button></section>' +
      '<details data-region="default" hidden><summary>Return to the hosted models</summary><div class="model-fields">' +
      '<p>This removes your own model connections from ClosedHand. Conversations, summaries and images will use the hosted service\'s models. Context Brain and File Search keep their existing recall provider.</p>' +
      '<button type="button" data-action="default">Use the hosted models</button></div></details></div></details>';
    var saved = null, ticket = null, models = [], imageModels = [], busy = false, allowDefault = false;
    var loads = { primary: 0, vision: 0 }, loadTimers = {};
    var field = function (key) { return root.querySelector('[data-field="' + key + '"]'); };
    var region = function (key) { return root.querySelector('[data-region="' + key + '"]'); };
    var result = root.querySelector(".model-result"), preview = root.querySelector(".model-preview");
    function renderCurrent(data) {
      var current = region("current");
      current.replaceChildren();
      var rows = data.activeModels || [];
      current.hidden = !rows.length;
      if (!rows.length) return;
      var list = document.createElement("dl"); list.className = "model-role-list";
      rows.forEach(function (row) {
        var term = document.createElement("dt"); term.textContent = row.label;
        var definition = document.createElement("dd");
        var name = document.createElement("span"); name.textContent = row.model.replace(/^local:/, "");
        definition.append(name);
        if (row.provider) { var provider = document.createElement("small"); provider.textContent = row.provider; definition.append(provider); }
        list.append(term, definition);
      });
      current.append(list);
      var note = document.createElement("p"); note.className = "model-hint";
      note.textContent = "Recall helps find relevant information. Search ranking puts the closest matches first. These models stay the same when you change your chat model.";
      current.append(note);
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
    function invalidate() { ticket = null; preview.hidden = true; }
    function visibility() {
      region("address").hidden = !["custom", "ollama"].includes(value("provider"));
      region("vision").hidden = value("visionMode") !== "separate";
      region("vision-connection").hidden = !value("visionProvider");
      region("vision-address").hidden = !["custom", "ollama"].includes(value("visionProvider"));
    }
    function input() {
      return { primary: { provider: value("provider"), baseUrl: value("baseUrl"), apiKey: value("apiKey"),
        useSavedKey: !value("apiKey") && !!saved?.connections?.primary?.hasKey },
        model: value("model"), backgroundModel: value("backgroundModel"), visionMode: value("visionMode"),
        vision: { provider: value("visionProvider"), baseUrl: value("visionBaseUrl"), apiKey: value("visionKey"),
          useSavedKey: !value("visionKey") && !!saved?.connections?.vision?.hasKey },
        visionModel: value("visionModel") };
    }
    async function call(path, body) {
      var response = await fetch("/api/model-config" + path, { method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      var data = await response.json();
      if (!response.ok) { var error = new Error(data.error || "Could not update the models."); error.visionNeeded = data.visionNeeded; throw error; }
      return data;
    }
    async function perform(fn) {
      if (busy) return;
      var focusImages = false;
      busy = true;
      root.setAttribute("aria-busy", "true");
      root.querySelectorAll("button,input,select").forEach(function (el) { el.disabled = true; });
      try { await fn(); } catch (e) {
        show(e.message || "Could not reach ClosedHand. Try again.", true);
        if (e.visionNeeded) { region("editor").open = true; region("extras").open = true; focusImages = true; }
      } finally {
        busy = false; root.removeAttribute("aria-busy");
        root.querySelectorAll("button,input,select").forEach(function (el) { el.disabled = false; });
        if (focusImages) field("visionMode").focus();
      }
    }
    function ready(kind) {
      var vision = kind === "vision";
      var provider = vision ? value("visionProvider") : value("provider");
      var key = vision ? value("visionKey") : value("apiKey");
      var base = vision ? value("visionBaseUrl") : value("baseUrl");
      var prior = saved?.connections?.[kind];
      if (!provider) return false;
      if (["ollama", "custom"].includes(provider)) return !!base;
      return !!key || !!(prior?.hasKey && prior.provider === provider && (prior.baseUrl || "") === base);
    }
    async function loadModels(kind, quiet) {
      var token = ++loads[kind], vision = kind === "vision";
      var retry = root.querySelector('[data-action="' + (vision ? "load-vision" : "load") + '"]');
      retry.hidden = true;
      if (!ready(kind)) return;
      if (!quiet) show(vision ? "Loading image models..." : "Loading available models...");
      try {
        var body = input(); body.connection = kind;
        var data = await call("/models", body);
        if (token !== loads[kind]) return;
        if (vision) imageModels = data.models.filter(function (model) { return model.capabilities.vision !== false; });
        else models = data.models;
        refreshPickers();
        if (!vision) region("capabilities").textContent = describeCaps(models.find(function (m) { return m.id === value("model"); })?.capabilities);
        if (!quiet) show(vision ? "Choose an image model from the list. Its image support will be checked before saving." : models.length + " models found. Choose one in the Chat model field.");
      } catch (e) {
        if (token !== loads[kind]) return;
        show(e.message || "Could not reach ClosedHand. Try again.", true);
        retry.hidden = false;
      }
    }
    function scheduleLoad(kind) {
      clearTimeout(loadTimers[kind]);
      loadTimers[kind] = setTimeout(function () { loadModels(kind); }, 500);
    }
    function describeCaps(cap) {
      if (!cap) return "Capabilities will be checked before saving.";
      return (cap.vision === true ? "Accepts images. " : cap.vision === false ? "Text only. " : "Images need checking. ") +
        (cap.reasoning ? "ClosedHand can adjust thinking effort. " : "Thinking uses the provider default. ") +
        (cap.contextWindow ? "Context limit: " + cap.contextWindow.toLocaleString() + " tokens." : "The provider has not published a context limit here.");
    }
    root.addEventListener("input", function (ev) {
      invalidate();
      if (ev.target === field("apiKey") || ev.target === field("baseUrl")) scheduleLoad("primary");
      if (ev.target === field("visionKey") || ev.target === field("visionBaseUrl")) scheduleLoad("vision");
    });
    root.addEventListener("change", function (ev) {
      if (ev.target.dataset.picker) {
        var key = ev.target.dataset.picker, manual = ev.target.value === "__manual__";
        root.querySelector('[data-manual="' + key + '"]').hidden = !manual;
        if (manual) field(key).focus();
        else field(key).value = ev.target.value;
        var hint = root.querySelector('[data-model-id="' + key + '"]');
        hint.textContent = value(key) ? "Model ID: " + value(key) : "";
        hint.hidden = manual || !value(key);
      }
      invalidate(); visibility();
      if (ev.target === field("provider")) {
        models = []; field("apiKey").value = ""; field("model").value = ""; field("backgroundModel").value = "";
        field("baseUrl").value = value("provider") === "ollama" ? "http://host.docker.internal:11434/v1" : "";
        imageModels = []; field("visionModel").value = ""; refreshPickers();
        show("Paste your key and the available models will appear.");
        loadModels("primary");
      }
      if (ev.target === field("visionProvider")) {
        field("visionKey").value = ""; field("visionModel").value = "";
        field("visionBaseUrl").value = value("visionProvider") === "ollama" ? "http://host.docker.internal:11434/v1" : "";
        imageModels = []; refreshPickers();
        loadModels("vision");
      }
      region("capabilities").textContent = describeCaps(models.find(function (m) { return m.id === value("model"); })?.capabilities);
    });
    root.querySelector('[data-action="load"]').onclick = function () { loadModels("primary"); };
    root.querySelector('[data-action="load-vision"]').onclick = function () { loadModels("vision"); };
    root.querySelector('[data-action="check"]').onclick = function () { perform(async function () {
      invalidate();
      if (!value("provider") || !value("model")) throw new Error("Choose a provider and chat model first.");
      show("Checking tool calls, summaries and image support...");
      var data = await call("/check", input()); ticket = data.ticket;
      var list = document.createElement("dl"); list.className = "model-role-list";
      [["chat", "Conversations"], ["background", "Titles and summaries"], ["vision", "Images"]].forEach(function (pair) {
        var role = data.config.roles[pair[0]], term = document.createElement("dt"), detail = document.createElement("dd");
        term.textContent = pair[1]; detail.textContent = role ? role.model + " via " + (providers[data.config.connections[role.connection].provider] || new URL(data.config.connections[role.connection].baseUrl).hostname) : "Image understanding is off.";
        list.append(term, detail);
      });
      region("review").replaceChildren(list);
      var capabilities = document.createElement("p"); capabilities.textContent = describeCaps(data.config.roles.chat.capabilities);
      region("review").append(capabilities);
      region("memory").textContent = data.memory;
      preview.hidden = false; show("Checks passed. Review the choices below before applying them."); preview.focus();
    }); };
    root.querySelector('[data-action="save"]').onclick = function () { perform(async function () {
      show("Saving models..."); await call("/save", { ticket: ticket });
      field("apiKey").value = ""; field("visionKey").value = ""; invalidate();
      var updated = await call(""); saved = updated.config; renderCurrent(updated);
      region("default").hidden = !allowDefault;
      show("Models updated. New requests use these choices."); result.focus();
      if (onSaved) onSaved();
    }); };
    root.querySelector('[data-action="default"]').onclick = function () { perform(async function () {
      await call("/default", {}); saved = null; invalidate(); renderCurrent(await call(""));
      root.querySelectorAll("input").forEach(function (el) { el.value = ""; });
      field("provider").value = ""; field("visionMode").value = "same"; models = []; imageModels = []; refreshPickers(); visibility();
      region("default").hidden = true;
      show("ClosedHand's hosted models are active."); result.focus();
      if (onSaved) onSaved();
    }); };
    perform(async function () {
      var data = await call(""); saved = data.config; renderCurrent(data);
      region("editor").open = !saved && !data.allowDefault;
      allowDefault = !!data.allowDefault;
      region("default").hidden = !allowDefault || !saved;
      if (!saved) { refreshPickers(); visibility(); if (data.allowDefault) show("ClosedHand's hosted models are active. You can connect your own models here."); return; }
      var primary = saved.connections.primary;
      field("provider").value = primary.provider; field("baseUrl").value = primary.baseUrl;
      field("apiKey").placeholder = primary.hasKey ? "Saved key, leave blank to keep it" : "Paste your key";
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
      refreshPickers(); visibility(); region("capabilities").textContent = describeCaps(saved.roles.chat.capabilities);
      if (data.legacy) show("The models shown above are active. Check and review your choices here before applying a change.");
      loadModels("primary", true);
      if (vision && vision.connection === "vision") loadModels("vision", true);
    });
  }
  window.ClosedHandModels = { mount: mount };
}());
