---
name: Instagram (cloud browser)
description: Read and comment on Instagram posts through the cloud computer's logged-in browser
triggers: [instagram, insta, my posts, my photos, my last post, my latest post, comment on my, caption my, ig post, ig profile]
---

Instagram is NOT reachable through the Meta connection. That token holds
ads_management, ads_read and business_management only, so `/me` has no
`instagram_accounts` field and `instagram_business_account` needs page
permissions it was never granted. Do not spend calls proving this again.
Everything below happens on the cloud computer's browser with `sandbox_browse`,
using the session the user is already signed into.

## The mistake to avoid

Do not navigate around the site looking for things. Instagram's interface is
built for a person with a mouse, and clicking from home to profile to a grid
thumbnail burns the whole step budget before anything is posted. Every post has
a direct permalink, and the page will hand you all of them at once. Read the
data, then go straight to each post.

## 1. Who is signed in

```
action: eval_js
script: (() => {
  const m = document.cookie.match(/ds_user_id=(\d+)/);
  const link = document.querySelector('a[href^="/"][role="link"] img[alt*="profile picture" i]');
  const href = link && link.closest('a') ? link.closest('a').getAttribute('href') : null;
  const fromNav = href ? href.replace(/\//g, '') : null;
  return { username: fromNav, user_id: m ? m[1] : null, url: location.href };
})()
```
Run it with `url: "https://www.instagram.com/"`. If `username` is null, screenshot
the page: the user may be signed out, in which case say so and stop rather than
guessing a username. Never assume which account: this user has more than one, so
confirm the username you found before acting on it.

## 2. Get the post permalinks in one call

Navigate to `https://www.instagram.com/<username>/` then:

```
action: eval_js
script: (() => Array.from(document.querySelectorAll('a[href*="/p/"]'))
  .map(a => a.getAttribute('href'))
  .filter((h, i, arr) => h && arr.indexOf(h) === i)
  .slice(0, 12))()
```

That returns the newest posts first, as `/p/<shortcode>/` paths. "Last 3 photos"
means the first 3 of that list. If it comes back empty the grid has not rendered:
`wait_for` selector `a[href*="/p/"]`, then run it again.

## 3. Each post is one batch

```
action: batch
steps: [
  {"action":"goto","url":"https://www.instagram.com/p/<shortcode>/"},
  {"action":"scrape_text"},
  {"action":"fill","selector":"textarea[aria-label*=\"comment\" i]","text":"<your comment>","submit":true,"dismiss_popup":true},
  {"action":"screenshot"}
]
```

Read the post before writing about it: a caption written blind is worse than no
caption. If the fill step fails, the comment box label varies by build, so use
the `candidates` it returns, or `div[contenteditable="true"]`. Retry that one
post, not the whole task.

Some builds need the Post control rather than Enter. If `submit` does not post
it, screenshot and click the visible Post control.

Instagram specifics worth knowing: `@` opens the tagging panel, so leave it out
unless the user asked for a tag; commenting twice on one photo is public and
cannot be undone quietly; and "last 3 photos" means the first 3 shortcodes from
step 2, each commented once.

## Cookie and consent banners

If a consent dialog blocks the page, it is a real element with a real label:
`screenshot` or use the `candidates` from a failed click, then click the actual
button. Do not guess `button:has-text("Allow all cookies")`.

## What to tell the user

Say which account you posted from, which posts you commented on, and quote the
comments. If any of the three failed, say which and why. Never report three
posted when you confirmed fewer.
