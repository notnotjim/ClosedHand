# Runs on ClosedHand's sandbox computer, sent by lib/maps-lists.js with ARGS
# set above it. Saves places to one of the person's Google Maps lists, in the
# sandbox browser where they signed in to Google themselves. Google offers no
# other way to write to saved lists, so this does what the person would do on
# maps.google.com: open the place, Save, then tick the list or make it.
import difflib, json, os, re, time, unicodedata, urllib.parse

ARGS = globals().get("ARGS") or {"list": "", "places": []}  # set by lib/maps-lists.js
# A run stops starting places after this long and hands the rest back. A
# place takes 15 to 50 seconds depending on how busy the computer is, so the
# last one still ends inside the sandbox's two-minute limit on one run.
BUDGET = float(ARGS.get("budget", 60))
SAVE = 'button[data-value="Save"], button[aria-label="Save"], button[aria-label^="Saved"]'
GOOGLE_SESSION = {"SID", "__Secure-1PSID", "SSID"}


def out(result):
    print("CLOSEDHAND_MAPS " + json.dumps(result))


def list_title(text):
    # Each entry reads: an icon (a private-use character on its own line), the
    # list's name, then "Private · 3 places".
    lines = [l.strip() for l in text.split("\n")]
    return next((l for l in lines if l and not all("\ue000" <= ch <= "\uf8ff" for ch in l)), "")


def plain(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def same_place(asked, found):
    """Whether Google's place is the one asked for, by name: every word of
    one name in the other, or the names nearly identical (Ginjinha and
    Ginginha). The area after the first comma is not part of the name."""
    a, f = plain(asked.split(",")[0]), plain(found)
    if not a or not f:
        return False
    words = lambda s: {w for w in s.split() if len(w) > 2}
    if words(a) and (words(a) <= words(f) or words(f) <= words(a)):
        return True
    return difflib.SequenceMatcher(None, a, f).ratio() >= 0.8


# Whether the list exists already: made in an earlier run, or in this one. A
# list Google has only just made takes a few seconds to show in the Save menu,
# so once it exists the menu is looked at again rather than a second list
# with the same name being made.
CREATED = bool(ARGS.get("created"))


def open_lists(page):
    page.locator(SAVE).first.click()
    page.get_by_role("menuitemradio").first.wait_for(timeout=10000)
    return page.get_by_role("menuitemradio")


def find_list(page, list_name):
    for attempt in range(6 if CREATED else 1):
        if attempt:
            page.keyboard.press("Escape")
            time.sleep(3)
        items = open_lists(page)
        for i in range(items.count()):
            if list_title(items.nth(i).inner_text()) == list_name:
                return items.nth(i)
    return None


def save_one(page, query, list_name):
    global CREATED
    # English, so the steps below read the same buttons whatever the browser's language.
    page.goto("https://www.google.com/maps/search/?api=1&hl=en&query=" + urllib.parse.quote(query),
              wait_until="domcontentloaded", timeout=45000)
    # Either a page of results or a single place. A page of results first
    # shows its "Results" heading and fills in its list a moment later, so
    # nothing is read until the page is clearly one or the other.
    kind = None
    for _ in range(40):
        if page.locator('div[role="feed"] a[href*="/maps/place/"]').count():
            kind = "results"; break
        heading = page.locator('div[role="main"] h1')
        if heading.count() and heading.first.inner_text().strip() not in ("", "Results") and page.locator(SAVE).count():
            kind = "place"; break
        time.sleep(0.5)
    if kind is None:
        return {"query": query, "status": "not_found"}
    if kind == "results":
        # The result whose name is the one asked for. When none is, or more
        # than one is (two branches with one name), nothing is saved and the
        # names go back to ask about.
        results = page.locator('div[role="feed"] a[href*="/maps/place/"]')
        names = [results.nth(i).get_attribute("aria-label") or "" for i in range(min(results.count(), 8))]
        matches = [i for i, n in enumerate(names) if same_place(query, n)]
        if len(matches) != 1:
            return {"query": query, "status": "unsure", "google_has": [names[i] for i in matches][:4] or [n for n in names if n][:3],
                    "why": "several places have this name" if matches else "no place has this name"}
        results.nth(matches[0]).click()
        page.wait_for_selector('div[role="main"] h1', timeout=15000)
    time.sleep(1.5)
    found = page.locator('div[role="main"] h1').first.inner_text().strip() if page.locator('div[role="main"] h1').count() else page.locator("h1").first.inner_text().strip()
    if not same_place(query, found):
        # Google went straight to one place, but under another name: asked
        # about rather than saved.
        return {"query": query, "status": "unsure", "google_has": [found]}
    address = (page.locator('button[data-item-id="address"]').first.get_attribute("aria-label") or "") if page.locator('button[data-item-id="address"]').count() else ""
    target = find_list(page, list_name)
    if target is None and CREATED:
        page.keyboard.press("Escape")
        return {"query": query, "status": "waiting"}
    if target is None:
        page.get_by_role("button", name="New list").click()
        box = page.locator('[role="dialog"] input').first
        box.wait_for(timeout=10000)
        box.fill(list_name)
        page.get_by_role("button", name="Create").click()
        CREATED = True
        status = "saved_new_list"
    elif target.get_attribute("aria-checked") == "true":
        status = "already_saved"
    else:
        target.click()
        status = "saved"
    time.sleep(1.5)
    page.keyboard.press("Escape")
    try:
        label = page.locator(SAVE).first.get_attribute("aria-label", timeout=3000) or ""
    except Exception:
        label = ""
    address = address.replace("Address:", "").strip()
    # A link made from what Google showed, which opens the same place for anyone.
    link = "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(", ".join(x for x in (found, address) if x))
    return {"query": query, "found": found, "address": address, "url": link, "status": status, "button": label}


def attach():
    # Its own attach with a time limit: a tab that crashed (out of memory,
    # say) can make attaching wait for ever, and then nothing else answers.
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    try:
        browser = pw.chromium.connect_over_cdp(os.environ.get("CDP_URL", "http://localhost:9222"), timeout=30000)
        if not browser.contexts:
            raise RuntimeError("no browsing context")
        return pw, browser, max(browser.contexts, key=lambda c: len(c.pages))
    except Exception:
        pw.stop()
        raise


def main():
    try:
        pw, browser, context = attach()
    except Exception:
        out({"ok": False, "kind": "browser"})
        return
    page = None
    try:
        names = {c["name"] for c in context.cookies(["https://www.google.com", "https://accounts.google.com"])}
        if not names & GOOGLE_SESSION:
            out({"ok": False, "kind": "signin"})
            return
        page = context.new_page()
        # Only the place's details and the Save dialog are needed. The map's
        # pictures and tiles are what make Google Maps slow in a browser with
        # no graphics card, so they are never fetched.
        # Blocked by Chrome itself: routing each request through Python made
        # every place take most of a minute.
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.setBlockedURLs", {"urls": ["*/maps/vt*", "*/kh/v=*", "*.png*", "*.jpg*", "*.jpeg*", "*.webp*", "*.gif*", "*.woff*", "*/maps/preview/photo*", "*googleusercontent.com/p/*", "*streetviewpixels*"]})
        started, results, left, waits = time.time(), [], list(ARGS["places"]), {}
        while left and time.time() - started < BUDGET:
            query = left.pop(0)
            try:
                result = save_one(page, query, ARGS["list"])
            except Exception as e:
                result = {"query": query, "status": "failed", "error": str(e).splitlines()[0][:200]}
            # A list Google has only just made can take a minute to show: the
            # place goes to the back of the queue, a few times, before failing.
            if result["status"] == "waiting":
                waits[query] = waits.get(query, 0) + 1
                if waits[query] <= 4:
                    left.append(query)
                    continue
                result = {"query": query, "status": "failed", "error": "the new list hasn't appeared in Google Maps yet"}
            results.append(result)
        out({"ok": True, "results": results, "left": left, "created": CREATED})
    finally:
        if page:
            page.close()
        browser.close()
        pw.stop()


if __name__ == "__main__":
    main()
