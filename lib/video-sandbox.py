# Runs on ClosedHand's sandbox computer, sent by lib/video.js with ARGS set
# above it. Gathers what a model needs to understand one video link and
# leaves the parts in a hidden folder of the workspace for the bot to collect
# (the bot deletes that folder straight after).
#
# YouTube is never downloaded: its terms don't allow it. Its captions, its
# details and the preview frames YouTube shows when you scrub the timeline are
# enough to follow it. Anything else is downloaded to a temporary folder,
# frames and speech are taken from it, and the file is deleted before this
# script ends, whatever happens.
import base64, io, json, math, os, re, shutil, subprocess, sys, tempfile

ARGS = globals().get("ARGS") or {"job": "unset", "url": ""}  # set by lib/video.js; tests import without it
OUT = os.path.join(os.getcwd(), ".closedhand-video", ARGS["job"])
MAX_FRAMES = int(ARGS.get("max_frames", 24))
AUDIO_CAP = int(ARGS.get("audio_seconds", 600))
VIDEO_BYTES = int(ARGS.get("video_bytes", 0))
CHUNK_SECONDS = 480  # 16 kHz 16-bit mono: 15 MB, under the sandbox's 20 MB download limit


def need_libraries():
    try:
        import yt_dlp, av  # noqa: F401
        return
    except ImportError:
        pass
    # An older sandbox without them gets them once, outside the workspace.
    lib = os.path.join(tempfile.gettempdir(), "closedhand-pylib")
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", lib, "yt-dlp", "av"],
                   check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.path.insert(0, lib)


def problem(message):
    m = message.lower()
    if "sign in" in m or "login" in m or "log in" in m or "cookies" in m:
        return "login"
    if "blocked" in m or "not available in your country" in m or "geo" in m:
        return "blocked"
    if "private" in m:
        return "private"
    if "unsupported url" in m:
        return "unsupported"
    if "too long" in m:
        return "too_long"
    return "failed"


def write(name, data):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)
    return name


def jpeg(image):
    from PIL import Image  # noqa: F401
    image = image.convert("RGB")
    image.thumbnail((768, 768))
    b = io.BytesIO()
    image.save(b, "JPEG", quality=80)
    return b.getvalue()


def frame_times(duration, count):
    if not duration or duration <= 0:
        return [0.0]
    n = max(1, min(count, int(math.ceil(duration / 2))))
    return [duration * (i + 0.5) / n for i in range(n)]


def details(info):
    chapters = [{"start": c.get("start_time"), "title": c.get("title")} for c in (info.get("chapters") or [])][:40]
    return {"title": info.get("title") or "", "uploader": info.get("uploader") or info.get("channel") or "",
            "date": info.get("upload_date") or "", "duration": info.get("duration"),
            "description": (info.get("description") or "")[:3000], "chapters": chapters,
            "language": info.get("language") or ""}


def clean_caption(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).strip()


def parse_json3(raw):
    lines = []
    for e in json.loads(raw).get("events", []):
        text = clean_caption("".join(s.get("utf8", "") for s in e.get("segs") or []))
        if text:
            lines.append({"start": round(e.get("tStartMs", 0) / 1000, 1), "text": text})
    return lines


def parse_vtt(raw):
    lines, start = [], None
    for line in raw.splitlines():
        m = re.match(r"(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s+-->", line)
        if m:
            h, mi, s, ms = m.groups()
            start = int(h or 0) * 3600 + int(mi) * 60 + int(s) + int(ms) / 1000
            continue
        text = clean_caption(line)
        if start is not None and text and not text.isdigit() and text != "WEBVTT":
            if not lines or lines[-1]["text"] != text:
                lines.append({"start": round(start, 1), "text": text})
    return lines


def captions(y, info):
    """The best caption track: one written by people in the video's own
    language, then any written by people, then YouTube's automatic one."""
    lang = (info.get("language") or "").split("-")[0]
    subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"}
    auto = info.get("automatic_captions") or {}
    order = []
    if lang:
        order += [(subs, k) for k in subs if k.split("-")[0] == lang]
    order += [(subs, k) for k in subs]
    order += [(auto, k) for k in auto if k.endswith("-orig")]
    if lang:
        order += [(auto, k) for k in (lang,) if k in auto]
    order += [(auto, k) for k in ("en",) if k in auto]
    for table, key in order:
        tracks = table.get(key) or []
        for ext, parse in (("json3", parse_json3), ("vtt", parse_vtt)):
            track = next((t for t in tracks if t.get("ext") == ext and t.get("url")), None)
            if not track:
                continue
            try:
                lines = parse(y.urlopen(track["url"]).read().decode("utf-8", "replace"))
            except Exception:
                continue
            if lines:
                return {"source": "written" if table is subs else "automatic", "language": key, "lines": lines}
    return None


def storyboard_frames(y, info, duration):
    boards = sorted([f for f in info.get("formats") or [] if f.get("format_note") == "storyboard" and f.get("fragments")],
                    key=lambda f: -(f.get("width") or 0))
    if not boards:
        return []
    from PIL import Image
    b = boards[0]
    rows, cols, w, h, fps = b.get("rows") or 1, b.get("columns") or 1, b.get("width"), b.get("height"), b.get("fps") or 0
    if not (w and h and fps):
        return []
    per, sheets, frames = rows * cols, {}, []
    for t in frame_times(duration, MAX_FRAMES):
        k = int(t * fps)
        sheet, index = k // per, k % per
        if sheet >= len(b["fragments"]):
            continue
        if sheet not in sheets:
            try:
                sheets[sheet] = Image.open(io.BytesIO(y.urlopen(b["fragments"][sheet]["url"]).read()))
            except Exception:
                sheets[sheet] = None
        image = sheets[sheet]
        x, top = (index % cols) * w, (index // cols) * h
        if image is None or x + w > image.width or top + h > image.height:
            continue
        frames.append((round(k / fps, 1), jpeg(image.crop((x, top, x + w, top + h)))))
    return frames


def youtube(url):
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    if shutil.which("node"):
        opts["js_runtimes"] = {"node": {}}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=False)
        meta = details(info)
        meta["captions"] = captions(y, info)
        frames = storyboard_frames(y, info, info.get("duration") or 0)
        meta["frame_source"] = "preview" if frames else None
    return meta, frames, None


def video_frames(path, duration):
    import av
    frames = []
    with av.open(path) as c:
        if not c.streams.video:
            return frames
        vs = c.streams.video[0]
        for t in frame_times(duration, MAX_FRAMES):
            try:
                c.seek(int(t / vs.time_base), stream=vs, backward=True)
                for frame in c.decode(vs):
                    if frame.time is None or frame.time + 0.001 >= t:
                        frames.append((round(frame.time if frame.time is not None else t, 1), jpeg(frame.to_image())))
                        break
            except Exception:
                continue
    return frames


def speech(path):
    """16 kHz mono 16-bit samples, up to AUDIO_CAP seconds, in parts the
    sandbox can hand over."""
    import av
    parts, pcm, limit = [], bytearray(), AUDIO_CAP * 16000 * 2
    with av.open(path) as c:
        if not c.streams.audio:
            return parts, 0
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in c.decode(c.streams.audio[0]):
            for f in resampler.resample(frame):
                pcm += bytes(f.planes[0])[: f.samples * 2]
            if len(pcm) >= limit:
                break
    pcm = pcm[:limit]
    step = CHUNK_SECONDS * 16000 * 2
    for i in range(0, len(pcm), step):
        parts.append(write("speech-%d.pcm" % (i // step), bytes(pcm[i:i + step])))
    return parts, round(len(pcm) / 32000, 1)


def download(url):
    import yt_dlp
    tmp = tempfile.mkdtemp(prefix="closedhand-video-")
    try:
        opts = {"quiet": True, "noprogress": True, "no_warnings": True, "noplaylist": True, "playlist_items": "1",
                "outtmpl": os.path.join(tmp, "v.%(ext)s"), "format": "b[height<=720][ext=mp4]/b[height<=720]/b",
                "max_filesize": 300 * 1024 * 1024,
                "match_filter": lambda info, incomplete=False: "too long" if (info.get("duration") or 0) > 3 * 3600 else None}
        try:
            info = run_download(yt_dlp, opts, url)
        except Exception as e:
            # Instagram and others may want a sign-in. If the person has signed
            # in on the sandbox computer's browser, that session is used, here
            # on the sandbox, for this one link.
            profile = os.path.join(os.getcwd(), ".chromium-profile")
            if problem(str(e)) != "login" or not os.path.isdir(profile):
                raise
            info = run_download(yt_dlp, dict(opts, cookiesfrombrowser=("chromium", profile)), url)
        files = [f for f in os.listdir(tmp) if not f.endswith(".part")]
        if not files:
            raise RuntimeError("No video in this post")
        path = os.path.join(tmp, files[0])
        meta = details(info)
        meta["captions"] = None
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as y:
            subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"}
            for key, tracks in subs.items():
                track = next((t for t in tracks if t.get("ext") == "vtt" and t.get("url")), None)
                if track:
                    try:
                        lines = parse_vtt(y.urlopen(track["url"]).read().decode("utf-8", "replace"))
                        if lines:
                            meta["captions"] = {"source": "written", "language": key, "lines": lines}
                            break
                    except Exception:
                        pass
        import av
        with av.open(path) as c:
            duration = float(c.duration / av.time_base) if c.duration else float(info.get("duration") or 0)
        meta["duration"] = round(duration, 1)
        video = None
        size = os.path.getsize(path)
        if VIDEO_BYTES and size <= VIDEO_BYTES and path.rsplit(".", 1)[-1].lower() in ("mp4", "webm", "mov"):
            with open(path, "rb") as f:
                video = write("video." + path.rsplit(".", 1)[-1].lower(), f.read())
        frames = video_frames(path, duration)
        meta["frame_source"] = "video" if frames else None
        meta["speech_parts"], meta["speech_seconds"] = speech(path)
        return meta, frames, video
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_download(yt_dlp, opts, url):
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
    if info.get("_type") == "playlist":
        info = next((e for e in info.get("entries") or [] if e), None) or {}
    return info


def sweep():
    # Parts a crashed run left behind are removed by the next one.
    import time
    root = os.path.dirname(OUT)
    for name in os.listdir(root) if os.path.isdir(root) else []:
        full = os.path.join(root, name)
        if os.path.isdir(full) and time.time() - os.path.getmtime(full) > 600:
            shutil.rmtree(full, ignore_errors=True)


def main():
    sweep()
    os.makedirs(OUT, exist_ok=True)
    try:
        need_libraries()
        meta, frames, video = youtube(ARGS["url"]) if ARGS.get("youtube") else download(ARGS["url"])
        blob, index = bytearray(), []
        for t, data in frames:
            index.append({"time": t, "offset": len(blob), "size": len(data)})
            blob += data
        meta["frames"] = index
        parts = {"meta": write("meta.json", json.dumps(meta).encode()), "frames": write("frames.bin", bytes(blob)) if blob else None,
                 "video": video, "speech": meta.get("speech_parts") or []}
        print("CLOSEDHAND_VIDEO " + json.dumps({"ok": True, "dir": os.path.relpath(OUT, os.getcwd()), "parts": parts}))
    except Exception as e:
        shutil.rmtree(OUT, ignore_errors=True)
        message = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")[:400]
        print("CLOSEDHAND_VIDEO " + json.dumps({"ok": False, "kind": problem(message), "error": message}))


if __name__ == "__main__":
    main()
