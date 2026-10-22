// The Computers tab on a phone: one computer at a time, files that open on a
// tap, no terminal, and the sandbox computer's browser full screen with a
// keyboard that types into it. Checked in a phone-sized browser while built;
// these hold the pieces in place.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const page = read("webapp/views/index.html");
const phone = page.slice(page.indexOf("  /* === PHONES === */"), page.indexOf("  @media (max-width:768px) and (orientation:portrait)"));

test("a phone shows one computer at a time, picked with a switch", () => {
  assert.ok(page.indexOf('id="monSwitch"') < page.indexOf('id="monArea"'), "the switch sits above the computers");
  assert.match(page, /onclick="monShow\('cloud'\)">Sandbox computer<\/button>/);
  assert.match(page, /onclick="monShow\('local'\)">Local computer<\/button>/);
  assert.match(phone, /#monArea:not\(\[data-show="local"\]\) #monLocalWrap, #monArea\[data-show="local"\] #monCloudWrap \{ display:none; \}/);
  assert.match(phone, /\.mon-divider \{ display:none !important; \}/, "no drag handle between them");
  assert.match(page, /\.mon-switch, \.mon-storage-phone, \.mon-info-phone, \.mon-open-full, \.mon-full-bar \{ display:none; \}/, "computers keep their side-by-side layout");
  assert.doesNotMatch(page, /monExpand|mon-ghost|Mobile divider drag/, "the old phone code that never dropped anything is gone");
});

test("the terminal stays off a phone, and its storage line moves beside the status", () => {
  assert.match(phone, /\.mon-term-bar, \.mon-term, #monSyncTip \{ display:none !important; \}/);
  assert.match(page, /storage\.textContent = online === null \? '' : ' \\u00b7 ' \+ \(data\.storage \|\| '0'\) \+ ' of '/);
});

test("on a phone a tap opens a folder, or a file's actions as a sheet", () => {
  assert.match(page, /if \(item\.ondblclick\) item\.ondblclick\(e\);\n\s*else if \(item\.oncontextmenu\) item\.oncontextmenu\(e\);/);
  assert.match(phone, /\.mon-context-menu \{ left:8px !important; right:8px; top:auto !important; bottom:calc\(8px \+ env\(safe-area-inset-bottom\)\);/);
  for (const draw of ["_monCloudView==='grid'&&!monPhone()", "_monLocalView==='grid'&&!monPhone()", "view === 'grid' && !monPhone()"]) assert.ok(page.includes(draw), draw);
});

test("the browser opens full screen without the Fullscreen API, with Keyboard and Close", () => {
  assert.match(page, /<button type="button" class="mon-open-full" id="monOpenFull" onclick="monFullOpen\(\)">Tap to open full screen<\/button>/);
  assert.match(page, /id="monKeysBtn" aria-pressed="false" aria-label="Keyboard" onclick="monKeyboard\(\)"/);
  assert.match(page, /onclick="monFullClose\(\)">[\s\S]{0,300}Close<\/button>/);
  assert.match(page, /body\.mon-full \.mon \{ container-type:normal; overflow:visible; \}/, "the pane no longer holds the fixed view");
  assert.match(page, /body\.mon-full \.mon-area \{ animation:none; opacity:1; transform:none; z-index:auto; \}/, "nothing on the page sits above it");
  assert.doesNotMatch(page, /body\.mon-full \{ overflow:hidden; \}/, "a body scroll lock made iPhone Safari clip it to the page's height");
  assert.match(page, /if \(!desktop\.requestFullscreen\) \{ monFullOpen\(\); return; \}/, "a computer without the API gets the same view");
  assert.match(page, /if \(r\.ok && monPhone\(\)\) monFullOpen\(\);/, "a sign-in shortcut opens it to sign in");
  for (const name of ["monShow", "monFullOpen", "monFullClose", "monKeyboard"]) assert.match(page, new RegExp(`window\\.${name} = ${name};`), name);
});

test("what is typed reaches the remote browser, from this page only", () => {
  assert.match(page, /frame\.contentWindow\.postMessage\(Object\.assign\(\{ type: 'closedhand-keys' \}, msg\), location\.origin\)/);
  const vnc = read("webapp/public/novnc/vnc_lite.html");
  assert.match(vnc, /if \(e\.origin !== window\.location\.origin \|\| !e\.data \|\| e\.data\.type !== 'closedhand-keys' \|\| !rfb\) return;/);
  assert.match(vnc, /rfb\.sendKey\(keysyms\.lookup\(ch\.codePointAt\(0\)\), null\)/);
  assert.match(vnc, /Backspace: \[KeyTable\.XK_BackSpace, 'Backspace'\], Enter: \[KeyTable\.XK_Return, 'Enter'\]/);
});

test("an ⓘ opens on a tap, and the sign-in marks are drawn into the page, not fetched", () => {
  assert.match(page, /var info = e\.target\.closest\('\.mon-info'\);\n\s*if \(info && info !== tapped\) \{ tapped = info; showTip\(info\); return; \}/);
  const marks = page.slice(page.indexOf("var MON_SIGNIN_LOGOS = {"), page.indexOf("};", page.indexOf("var MON_SIGNIN_LOGOS = {")));
  for (const site of ["google", "instagram", "tiktok", "x", "facebook"]) assert.match(marks, new RegExp(`\\n    ${site}: '<svg aria-hidden="true"`), site);
  assert.doesNotMatch(page, /'\/logos\/' \+ site\.id/, "a content blocker stopped the Facebook file on an iPhone");
});

test("full screen on a phone, the sandbox computer's screen takes the phone's shape, and the laptop shape after", () => {
  const entry = read("sandbox-image/entrypoint.sh");
  assert.match(entry, /Xvfb :99 -screen 0 1280x1280x24/, "room below the laptop-shaped part for a tall phone shape");
  assert.match(entry, /x11vnc -display :99 [^\n]* -clip 1280x800\+0\+0/, "only the part shown is sent");
  assert.match(entry, /rm -f \/home\/sandbox\/\.config\/openbox\/rc\.xml\nopenbox_supervisor\(\)/, "a restart starts in the laptop shape");
  assert.match(read("sandbox-image/openbox-config/rc.xml"), /<margins><top>0<\/top><bottom>480<\/bottom><left>0<\/left><right>0<\/right><\/margins>/, "windows stay in the part shown");
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /const SCREEN = \{ width: 1280, height: 1280 \}, LAPTOP = \{ width: 1280, height: 800 \}, NARROWEST = 508;/);
  assert.match(agent, /app\.post\("\/desktop\/shape", auth,/);
  assert.match(agent, /if \(phone && botBrowsing\(\)\) return res\.json\(\{ \.\.\.\(await queueShape\(LAPTOP\)\), busy: true \}\);/, "never reshaped under Closedhand's own browsing");
  assert.match(agent, /function botBrowsing\(\) \{\n\s*return browseBusy > 0 \|\| Date\.now\(\) - lastBrowseAt < 20000;/, "Closedhand is browsing while a step runs and just after, not whenever its lasting helper exists");
  assert.match(agent, /shapeTimer = setTimeout\(\(\) => queueShape\(LAPTOP\)/, "back to laptop by itself when the phone stops asking");
  assert.match(agent, /const run = shaping\.then\(\(\) => setShape\(next\)\);/, "one change of shape at a time");
  assert.match(agent, /"-remote", `clip:\$\{width\}x\$\{height\}\+\$\{left\}\+\$\{top\}`/, "the page only: below Chrome's bars, inside its frame");
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/sandbox\/screen",[\s\S]{0,600}sandboxFetch\(info, "POST", "\/desktop\/shape", phone \? \{ width, height \} : \{\}, 15000\)/);
  assert.match(page, /function monFullOpen\(\) \{[\s\S]{0,200}monPhoneShape\(\);/);
  assert.match(page, /function monFullClose\(\) \{[\s\S]{0,300}monLaptopShape\(\);/);
  assert.match(page, /monShapeTimer = setTimeout\(monPhoneShape, 30000\);/);
  assert.match(page, /window\.addEventListener\('pagehide', function \(\) \{ monLaptopShape\(true\); \}\);/);
});

test("in the phone shape Chrome says it is a phone, so sites pick their phone versions", () => {
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /await phoneMode\(!laptop\)/, "on with the phone shape, off with the laptop shape");
  assert.match(agent, /Target\.setAutoAttach", \{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true \}/, "new pages wait for the phone settings");
  for (const call of ["Emulation.setUserAgentOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setEmitTouchEventsForMouse"]) assert.ok(agent.includes(`send("${call}"`), call);
  assert.doesNotMatch(agent, /setDeviceMetricsOverride/, "pages keep the window's width: a phone's 980-wide layout shrank pages to unreadable");
  assert.match(agent, /Mobile Safari\/537\.36/);
  assert.match(agent, /if \(targetInfo\.type === "page" && \/\^https\?:\/\.test\(targetInfo\.url\)\) send\("Page\.reload", \{\}, sessionId\);/, "a page already loading loads again as its phone version");
});

test("the sandbox browser starts on Google, which a person can still change", () => {
  const policy = JSON.parse(read("sandbox-image/chrome-policies.json"));
  assert.equal(policy.DefaultSearchProviderName, "Google");
  assert.equal(policy.DefaultSearchProviderSearchURL, "https://www.google.com/search?q={searchTerms}");
  const docker = read("sandbox-image/Dockerfile");
  assert.match(docker, /COPY chrome-policies\.json \/etc\/opt\/chrome\/policies\/recommended\/closedhand\.json/, "Google Chrome, on amd64");
  assert.match(docker, /COPY chrome-policies\.json \/etc\/chromium\/policies\/recommended\/closedhand\.json/, "Debian's Chromium, on arm64, which starts on DuckDuckGo");
  assert.doesNotMatch(docker, /policies\/managed/, "recommended, never enforced");
  assert.match(page, /var MON_SIGNIN_INTRO = 'Watch Closedhand work or sign in to any website you want it to have persistent access to\.';/);
});

test("full screen on a phone has a phone browser's bar at the bottom, standing in for Chrome's", () => {
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /app\.post\("\/desktop\/phone-browser", auth,/);
  assert.match(agent, /"\[document\.visibilityState, outerHeight - innerHeight, outerWidth - innerWidth\]\.join\(' '\)"/, "Chrome's bars and frame, asked of the page");
  const goAddress = new Function(agent.slice(agent.indexOf("function goAddress"), agent.indexOf("async function browserState")) + "return goAddress;")();
  assert.equal(goAddress("kestrel.example"), "https://kestrel.example");
  assert.equal(goAddress("harbour ferry times"), "https://www.google.com/search?q=harbour%20ferry%20times");
  assert.equal(goAddress("javascript:alert(1)"), "https://www.google.com/search?q=javascript%3Aalert(1)", "only web addresses open");
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/sandbox\/phone-browser",[\s\S]{0,700}"\/desktop\/phone-browser"/);
  assert.equal((server.match(/app\.post\("\/api\/sandbox\/browser"/g) || []).length, 1, "the route that opens the browser keeps its own name");
  assert.match(page, /fetch\('\/api\/sandbox\/phone-browser'/);
  assert.match(page, /body\.mon-full \.mon-full-bar \{ display:flex; order:2;/, "at the bottom, as on a phone");
  assert.match(page, /<input type="text" id="monAddress" placeholder="Search or type an address"/);
  for (const action of ["back", "forward", "reload"]) assert.match(page, new RegExp(`onclick="monBrowser\\('${action}'\\)"`), action);
  assert.match(page, /id="monTabsBtn" aria-label="Tabs"/);
  assert.match(page, /document\.getElementById\('monFullBar'\)\.classList\.add\('mon-own-bar'\);\n\s*var frame = document\.getElementById\('monVncFrame'\);/, "the bar's full height is known before the size is sent");
});
