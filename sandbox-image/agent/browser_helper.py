"""Browser helper — web automation for sandbox containers.

Attaches to the ALREADY-RUNNING Chrome (the one visible over VNC) via CDP
on localhost:9222. One browser, one profile: the bot shares the user's
logins and the user watches bot actions live on the VNC desktop.

Reading and acting both go through CSS selectors on the live page. There is no
screenshot-and-coordinates control here: screenshots are for the model to SEE
the page, selectors are how it acts on one.

Usage:
    from browser_helper import screenshot, scrape_text, extract_data
    from browser_helper import click, fill, press, eval_js, wait_for

    screenshot("https://example.com")
    click("button.submit")
    fill("textarea[name=comment]", "nice shot", submit=True)
"""

import base64
import json
import time

CDP_URL = "http://localhost:9222"

# Every call from the bot is a separate Python process, so a Playwright page
# object cannot be held between them. Chrome is the thing that persists, so the
# bot's tab is marked in the page itself. window.name survives navigation within
# a tab, which makes it the one piece of state that outlives both the process
# and a page load.
TAB_MARKER = "closedhand-bot"


def _get_browser():
    """Connect to the running Chrome over CDP. Returns (playwright, browser, context).

    Context choice matters: the whole point of attaching over CDP is to inherit
    the user's logged-in session. browser.new_context() would create a fresh,
    cookie-less context, so a page opened in it looks signed out even though
    the visible window is signed in. Prefer the context with the most pages
    (the real window the user is using) and never silently fall back to an
    empty one.
    """
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    last_err = None
    for _ in range(3):
        try:
            browser = pw.chromium.connect_over_cdp(CDP_URL)
            contexts = list(browser.contexts)
            if not contexts:
                raise RuntimeError(
                    "Attached to Chrome but it exposed no browsing context, so there is "
                    "no logged-in session to use. The browser may still be starting."
                )
            context = max(contexts, key=lambda c: len(c.pages))
            return pw, browser, context
        except Exception as e:
            last_err = e
            time.sleep(2)
    pw.stop()
    raise RuntimeError(f"Could not attach to browser at {CDP_URL}: {last_err}")


def _same_page(a, b):
    """Compare URLs ignoring the fragment and a trailing slash."""
    if not a or not b:
        return False
    a = a.split("#")[0].rstrip("/")
    b = b.split("#")[0].rstrip("/")
    return a == b


def _page(context, url=None):
    """Find the bot's tab, or claim one, and put it on `url` if asked.

    Reusing one tab is what makes a multi-step task possible: clicking a comment
    box only means something on the page a previous call left behind. It is also
    what the user sees, one tab being driven rather than tabs appearing and
    vanishing on their screen for every single call.
    """
    mine = None
    for page in context.pages:
        try:
            if page.evaluate("window.name") == TAB_MARKER:
                mine = page
                break
        except Exception:
            continue  # still loading, or a page that refuses evaluation

    if mine is None:
        mine = context.new_page()
        if url is None:
            url = "about:blank"

    if url and not _same_page(mine.url, url):
        _goto(mine, url)

    _mark(mine)

    try:
        mine.bring_to_front()
    except Exception:
        pass
    return mine


def _mark(page):
    """Re-apply the tab marker.

    Chrome clears window.name on a cross-origin navigation, so stamping once
    when the tab is claimed is not enough: the first hop to another site orphans
    the tab, the next call cannot find it, opens a fresh one, and the flow loses
    the page it was working on. Every navigation has to re-stamp.
    """
    try:
        page.evaluate(f"window.name = {json.dumps(TAB_MARKER)}")
    except Exception:
        pass


def _goto(page, url, timeout=30000):
    """Navigate, then wait for quiet only briefly.

    wait_until="networkidle" was the sole wait, but sites that poll
    continuously (Instagram, most SPAs) never reach idle, so every call burned
    the full timeout and the caller gave up before the page was ever used.
    DOM-ready is the real precondition; idle is a nice-to-have with a short cap.
    """
    page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass  # never settles: carry on with what has rendered
    _mark(page)


def _where(page, context=None):
    """Where the tab ended up, so the model can tell whether an action landed.

    tabs is here as a diagnostic: if it climbs call after call, tab reuse has
    stopped working and every call is opening a fresh one.
    """
    try:
        title = page.title()
    except Exception:
        title = ""
    out = {"url": page.url, "title": title}
    if context is not None:
        try:
            out["tabs"] = len(context.pages)
        except Exception:
            pass
    return out


_CANDIDATE_JS = """
() => {
  const out = [];
  const q = 'button, a[href], input, textarea, select, [role=button], [role=link], [contenteditable=true]';
  for (const el of document.querySelectorAll(q)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;              // invisible, not clickable
    const label = (el.innerText || el.getAttribute('aria-label') ||
                   el.getAttribute('placeholder') || el.value || '').trim().slice(0, 70);
    const tag = el.tagName.toLowerCase();
    let sel = tag;
    if (el.id) sel = tag + '#' + CSS.escape(el.id);
    else if (el.getAttribute('aria-label')) sel = tag + '[aria-label=' + JSON.stringify(el.getAttribute('aria-label')) + ']';
    else if (el.getAttribute('name')) sel = tag + '[name=' + JSON.stringify(el.getAttribute('name')) + ']';
    else if (el.getAttribute('placeholder')) sel = tag + '[placeholder=' + JSON.stringify(el.getAttribute('placeholder')) + ']';
    else if (el.getAttribute('href')) sel = tag + '[href=' + JSON.stringify(el.getAttribute('href')) + ']';
    else if (el.getAttribute('role')) sel = '[role=' + JSON.stringify(el.getAttribute('role')) + ']';
    out.push({ selector: sel, text: label });
    if (out.length >= 30) break;
  }
  return out;
}
"""


def _candidates(page):
    """The interactive elements actually on the page, with usable selectors.

    A missed selector used to return nothing but "not found", so the model's only
    move was to guess again, at fifteen seconds a go. Handing back what is really
    there turns the next attempt into a choice rather than another guess.
    """
    try:
        return page.evaluate(_CANDIDATE_JS)
    except Exception:
        return []


def session_report(domain):
    """How many cookies the shared profile holds for a domain.

    Turns "it says I am logged out" into evidence: if this is 0 the profile
    genuinely has no session, if it is non-zero the problem is elsewhere.
    """
    pw, browser, context = _get_browser()
    try:
        cookies = context.cookies()
        matching = [c for c in cookies if domain in (c.get("domain") or "")]
        return {
            "domain": domain,
            "cookies_for_domain": len(matching),
            "cookies_total": len(cookies),
            "contexts": len(browser.contexts),
            "open_pages": len(context.pages),
            "cookie_names": sorted({c.get("name") for c in matching})[:15],
        }
    finally:
        browser.close()
        pw.stop()


def screenshot(url=None, full_page=False):
    """Screenshot the bot's tab, navigating there first if a url is given.

    url is optional: with none, this captures the page as previous calls left
    it, which is how the model checks whether a click did what it expected.

    Returns {"image": <base64 png>, "title": ..., "url": ...}. Callers should
    accept a bare string too: older builds returned just the base64, and the bot
    and this image deploy independently.
    """
    pw, browser, context = _get_browser()
    try:
        page = _page(context, url)
        img_bytes = page.screenshot(full_page=full_page)
        out = {"image": base64.b64encode(img_bytes).decode("utf-8")}
        out.update(_where(page, context))
        return out
    finally:
        browser.close()
        pw.stop()


def scrape_text(url=None, selector=None):
    """Extract text content from the bot's tab."""
    pw, browser, context = _get_browser()
    try:
        page = _page(context, url)
        if selector:
            elements = page.query_selector_all(selector)
            return "\n\n".join(el.inner_text() for el in elements)
        return page.inner_text("body")
    finally:
        browser.close()
        pw.stop()


def extract_data(url=None, selectors=None):
    """Extract structured data from the bot's tab using CSS selectors."""
    pw, browser, context = _get_browser()
    try:
        page = _page(context, url)
        result = {}
        for name, sel in (selectors or {}).items():
            elements = page.query_selector_all(sel)
            texts = [el.inner_text() for el in elements]
            result[name] = texts if len(texts) != 1 else texts[0]
        return result
    finally:
        browser.close()
        pw.stop()


def _do(page, context, step):
    """Run one step on an already-connected page. The single-action helpers and
    batch both go through here, so there is exactly one implementation of what
    "click" means."""
    action = step.get("action")
    selector = step.get("selector")
    timeout = int(step.get("timeout") or 6000)

    if action == "goto":
        _goto(page, step["url"])
        return dict({"went_to": step["url"]}, **_where(page, context))
    if action == "screenshot":
        img = page.screenshot(full_page=bool(step.get("full_page")))
        return dict({"image": base64.b64encode(img).decode("utf-8")}, **_where(page, context))
    if action == "scrape_text":
        if selector:
            text = "\n\n".join(el.inner_text() for el in page.query_selector_all(selector))
        else:
            text = page.inner_text("body")
        return dict({"text": text[:8000]}, **_where(page, context))
    if action == "extract_data":
        out = {}
        for name, sel in (step.get("selectors") or {}).items():
            texts = [el.inner_text() for el in page.query_selector_all(sel)]
            out[name] = texts if len(texts) != 1 else texts[0]
        return dict({"data": out}, **_where(page, context))
    if action == "wait_for":
        try:
            page.wait_for_selector(selector, timeout=int(step.get("timeout") or 15000),
                                   state=step.get("state") or "visible")
            found = True
        except Exception:
            found = False
        return dict({"found": found, "selector": selector}, **_where(page, context))
    if action == "press":
        key = step.get("key")
        if selector:
            page.press(selector, key)
        else:
            page.keyboard.press(key)
        page.wait_for_timeout(600)
        return dict({"pressed": key}, **_where(page, context))
    if action == "eval_js":
        try:
            value = page.evaluate(step.get("script"))
        except Exception as e:
            return dict({"ok": False, "error": str(e)}, **_where(page, context))
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            value = str(value)
        return dict({"ok": True, "result": value}, **_where(page, context))
    if action in ("click", "fill"):
        try:
            page.wait_for_selector(selector, timeout=timeout, state="visible")
        except Exception:
            key = "clicked" if action == "click" else "filled"
            return dict({key: False,
                         "error": f"No visible element matched {selector!r} within {timeout}ms.",
                         "hint": "Do not guess again. Pick one of the selectors in candidates, or screenshot the page.",
                         "candidates": _candidates(page)}, **_where(page, context))

        if action == "click":
            index = int(step.get("index") or 0)
            elements = page.query_selector_all(selector)
            if index >= len(elements):
                return dict({"clicked": False,
                             "error": f"Selector {selector!r} matched {len(elements)} elements, no index {index}.",
                             "candidates": _candidates(page)}, **_where(page, context))
            elements[index].scroll_into_view_if_needed()
            elements[index].click()
            page.wait_for_timeout(600)
            _mark(page)  # the click may have followed a link to another origin
            return dict({"clicked": True, "selector": selector, "index": index,
                         "matches": len(elements)}, **_where(page, context))

        page.click(selector)
        # Character by character: rich editors listen for real key events and
        # ignore a value that simply appears.
        page.type(selector, step.get("text") or "", delay=25)
        if step.get("dismiss_popup"):
            # Autocomplete panels (an @ mention, an emoji picker) swallow Enter to
            # pick a suggestion instead of submitting. Close it first.
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        if step.get("submit"):
            page.keyboard.press("Enter")
            page.wait_for_timeout(1200)
        return dict({"filled": True, "selector": selector,
                     "submitted": bool(step.get("submit"))}, **_where(page, context))

    return {"error": f"Unknown action {action!r}"}


def _one(step):
    """Connect, run a single step, disconnect."""
    pw, browser, context = _get_browser()
    try:
        page = _page(context, step.get("url"))
        return _do(page, context, step)
    finally:
        browser.close()
        pw.stop()


def batch(steps, url=None):
    """Run several steps on ONE connection.

    Connecting Playwright over CDP costs seconds, and every separate call pays it
    again: a comment flow done as five calls spends most of its time connecting
    and tearing down rather than doing anything. Batching a whole flow into one
    call is the difference between a task finishing and a task timing out.

    Stops at the first failed step and returns what happened up to that point, so
    a broken selector does not silently carry on into a wrong page.
    """
    pw, browser, context = _get_browser()
    try:
        page = _page(context, url)
        results = []
        for i, step in enumerate(steps or []):
            if step.get("url") and not _same_page(page.url, step["url"]):
                _goto(page, step["url"])
            try:
                res = _do(page, context, step)
            except Exception as e:
                res = {"error": f"{type(e).__name__}: {e}"}
            res["step"] = i
            res["action"] = step.get("action")
            results.append(res)
            failed = res.get("error") or res.get("clicked") is False or res.get("filled") is False
            if failed:
                return {"completed": i, "of": len(steps), "stopped_early": True, "results": results}
        return {"completed": len(results), "of": len(steps), "stopped_early": False, "results": results}
    finally:
        browser.close()
        pw.stop()


def wait_for(selector, url=None, timeout=15000, state="visible"):
    return _one({"action": "wait_for", "selector": selector, "url": url,
                 "timeout": timeout, "state": state})


def click(selector, url=None, index=0, timeout=6000):
    return _one({"action": "click", "selector": selector, "url": url,
                 "index": index, "timeout": timeout})


def fill(selector, text, url=None, submit=False, timeout=6000, dismiss_popup=False):
    return _one({"action": "fill", "selector": selector, "text": text, "url": url,
                 "submit": submit, "timeout": timeout, "dismiss_popup": dismiss_popup})


def press(key, selector=None, url=None):
    return _one({"action": "press", "key": key, "selector": selector, "url": url})


def eval_js(script, url=None):
    return _one({"action": "eval_js", "script": script, "url": url})
