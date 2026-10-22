"""yt-dlp helpers shared by the web app (app.py) and the command line (main.py)."""
import glob
import os
import re
import shutil
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yt_dlp
from yt_dlp.cookies import load_cookies
from yt_dlp.postprocessor import PostProcessor
from yt_dlp.utils import DownloadCancelled  # noqa: F401  (re-exported for callers)

# Prefer an m4a source for M4A so ffmpeg only has to copy the audio, not re-encode it.
FORMATS = {
    "mp3": "bestaudio/best",
    "m4a": "bestaudio[ext=m4a]/bestaudio/best",
    "mp4": None,  # video: built per resolution by _video_format()
}
QUALITIES = {  # kbps for audio, maximum height (p) for video
    "mp3": (128, 192, 320),
    "m4a": (128, 192, 320),
    "mp4": (360, 480, 720, 1080),
}
DEFAULT_QUALITY = {"mp3": 192, "m4a": 192, "mp4": 720}
INCOMPLETE_DIR = ".incomplete"

BROWSERS = ("firefox", "chrome", "edge", "brave", "opera", "vivaldi", "chromium", "safari")
TEST_VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"  # 19 s, YouTube's first video

FFMPEG_LOCATION = os.environ.get("FFMPEG_LOCATION")  # only needed if ffmpeg isn't on PATH
LOGIN_COOKIES = {"SAPISID", "__Secure-3PAPISID", "LOGIN_INFO"}  # present only when signed in
_auth = {"cookies_browser": None, "cookies_file": None}
_cookie_cache: dict = {}
_cookie_lock = threading.Lock()
_UNAVAILABLE_TITLES = {"[Private video]", "[Deleted video]", "[Unavailable video]"}
_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.IGNORECASE)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_TRANSIENT = ("timed out", "timeout", "connection reset", "connection aborted", "remote end closed",
              "incompleteread", "temporarily unavailable", "http error 5", "getaddrinfo",
              "eof occurred", "connection refused", "network is unreachable")
_FRIENDLY_ERRORS = (  # (words that must all appear, message to show instead)
    (("not a bot",), "YouTube wants to confirm you're not a bot. Set up YouTube sign-in in Settings, then retry."),
    (("could not copy", "cookie"), "The browser locks its cookies while it's open. Close it completely (check the system tray), or use a cookies.txt file."),
    (("dpapi",), "This browser encrypts its cookies in a way yt-dlp can't read. Use a cookies.txt file instead."),
    (("could not find", "cookies database"), "Couldn't find that browser's cookies. Is it installed, and have you opened YouTube in it?"),
)


# ================================
# SETTINGS & COOKIES
# ================================
def configure(cookies_browser: str | None = None, cookies_file: str | None = None) -> None:
    """Use a browser's (or a cookies.txt file's) YouTube login, which gets past the bot check."""
    _auth.update(cookies_browser=cookies_browser or None, cookies_file=cookies_file or None)
    forget_cookies()


def forget_cookies() -> None:
    """Read cookies again on next use, e.g. after signing in to YouTube in the browser."""
    with _cookie_lock:
        _cookie_cache.clear()


def _cookie_jar():
    """Load the configured cookies once and share them with every download.

    Passing `cookiefile` to each YoutubeDL instead would make every parallel download
    write the file back when it finishes, which can corrupt it.
    """
    browser, file = _auth["cookies_browser"], _auth["cookies_file"]
    if not (browser or file):
        return None
    key = (browser, file)
    with _cookie_lock:
        if key not in _cookie_cache:
            spec = None if file else (browser, None, None, None)
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                jar = load_cookies(file, spec, ydl)
            _cookie_cache.clear()
            _cookie_cache[key] = jar
        return _cookie_cache[key]


def has_youtube_login(jar) -> bool:
    return any(c.domain.endswith("youtube.com") and c.name in LOGIN_COOKIES for c in jar)


def _base_opts() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 30,  # slow connections time out at the default 20 s
        # YouTube needs a JavaScript runtime to unlock its formats; Node works if Deno isn't installed.
        "js_runtimes": {"deno": {"path": None}, "node": {"path": None}},
    }
    if FFMPEG_LOCATION:
        opts["ffmpeg_location"] = FFMPEG_LOCATION
    return opts


def _youtube_dl(opts: dict) -> yt_dlp.YoutubeDL:
    jar = _cookie_jar()
    ydl = yt_dlp.YoutubeDL(opts)
    if jar is not None:
        for cookie in jar:
            ydl.cookiejar.set_cookie(cookie)
    return ydl


# ================================
# NAMES
# ================================
def safe_name(text: str, fallback: str = "untitled") -> str:
    """Make text safe as a file/folder name on any OS, keeping Arabic, Urdu, etc."""
    text = _FORBIDDEN.sub(" ", text or "")
    text = re.sub(r"\s+", " ", text).strip(" .")[:150].strip(" .")
    if not text:
        return fallback
    return f"_{text}" if _RESERVED.match(text) else text


def pad_width(total: int) -> int:
    """Digits needed so files sort correctly everywhere: 114 tracks -> 001..114."""
    return max(2, len(str(total)))


def track_basename(index: int, title: str, pad: int) -> str:
    """`001 - Title` for playlist tracks; just `Title` when pad is 0 (single videos)."""
    return f"{index:0{pad}d} - {safe_name(title)}" if pad else safe_name(title)


def error_message(exc: BaseException) -> str:
    """Turn a yt-dlp error into one readable line."""
    # yt-dlp replaces cookie errors with a generic "failed to load cookies"; use the real cause.
    while "failed to load cookies" in str(exc) and (exc.__cause__ or exc.__context__):
        exc = exc.__cause__ or exc.__context__
    msg = _ANSI.sub("", str(exc)).strip()
    msg = re.sub(r"^ERROR:\s*", "", msg)
    msg = re.sub(r"^\[[\w:]+\]\s*[\w-]+:\s*", "", msg)  # drop "[youtube] abc123: "
    for words, friendly in _FRIENDLY_ERRORS:
        if all(w in msg.lower() for w in words):
            return friendly
    return msg.splitlines()[0][:300] if msg else exc.__class__.__name__


def is_transient(exc: BaseException) -> bool:
    """Network hiccups worth retrying (unlike e.g. a private video or the bot check)."""
    msg = str(exc).lower()
    return any(word in msg for word in _TRANSIENT)


def ffmpeg_available() -> bool:
    if FFMPEG_LOCATION:
        return Path(FFMPEG_LOCATION).exists()
    return shutil.which("ffmpeg") is not None


# ================================
# FETCH PLAYLIST / VIDEO INFO
# ================================
def _thumbnail(info: dict) -> str | None:
    """Pick a ~320px wide thumbnail: big enough to look sharp, small enough to load fast."""
    thumbs = [t for t in info.get("thumbnails") or [] if t.get("url")]
    sized = sorted((t for t in thumbs if t.get("width")), key=lambda t: t["width"])
    for t in sized:
        if t["width"] >= 320:
            return t["url"]
    if sized:
        return sized[-1]["url"]
    return info.get("thumbnail") or (thumbs[-1]["url"] if thumbs else None)


def _playlist_link(url: str) -> str | None:
    """For a video opened from a playlist (watch?v=…&list=…), the playlist's own link.

    YouTube's auto-generated mixes (list=RD…) are endless, so they don't count.
    """
    query = parse_qs(urlparse(url).query)
    playlist = (query.get("list") or [""])[0]
    if query.get("v") and playlist and not playlist.startswith("RD"):
        return f"https://www.youtube.com/playlist?list={playlist}"
    return None


def inspect(url: str) -> dict:
    """List the videos behind a playlist or single-video link without downloading.

    A video opened from a playlist gives just that video, plus `playlist_url` so the
    page can offer the whole playlist instead.
    """
    playlist_url = _playlist_link(url)
    opts = {**_base_opts(), "extract_flat": "in_playlist", "skip_download": True,
            "noplaylist": bool(playlist_url)}
    with _youtube_dl(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("Nothing found at that link.")

    is_playlist = info.get("_type") == "playlist"
    raw = list(info.get("entries") or []) if is_playlist else [info]

    entries = []
    for position, entry in enumerate(raw, start=1):
        if not entry or not entry.get("id"):
            continue  # keep `position` so numbering still matches the playlist
        title = entry.get("title") or entry["id"]
        entries.append({
            "id": entry["id"],
            "index": position,
            "title": title,
            "url": entry.get("webpage_url") or entry.get("url"),
            "duration": entry.get("duration"),
            "thumbnail": _thumbnail(entry),
            "available": title not in _UNAVAILABLE_TITLES,
        })
    if not entries:
        raise ValueError("No videos found at that link.")

    return {
        "kind": "playlist" if is_playlist else "video",
        "title": info.get("title") or "Untitled",
        "uploader": info.get("uploader") or info.get("channel"),
        "url": info.get("webpage_url") or url,
        "thumbnail": _thumbnail(info) or entries[0]["thumbnail"],
        "entries": entries,
        "playlist_url": None if is_playlist else playlist_url,
    }


def check_youtube() -> str:
    """Fully resolve one short video (no download) to see if YouTube lets us in."""
    forget_cookies()
    jar = _cookie_jar()
    if jar is not None and not has_youtube_login(jar):
        if _auth["cookies_file"]:
            raise ValueError("That cookies.txt has no YouTube login in it. "
                             "Export it again while signed in on youtube.com.")
        raise ValueError(f"Read {_auth['cookies_browser'].title()}'s cookies, but it isn't signed in to YouTube. "
                         "Sign in on youtube.com in that browser, then test again.")
    with _youtube_dl({**_base_opts(), "skip_download": True}) as ydl:
        info = ydl.extract_info(TEST_VIDEO, download=False)
    return info.get("title") or "OK"


# ================================
# DOWNLOAD ONE TRACK
# ================================
class _Tags(PostProcessor):
    """Adds album / track number to the video info so FFmpegMetadata writes them."""

    def __init__(self, tags: dict):
        super().__init__()
        self._tags = tags

    def run(self, info):
        info.update(self._tags)
        return [], info


class _RecordParts(PostProcessor):
    """Runs once formats are chosen: notes the size of each part (video + audio) for progress."""

    def __init__(self, parts: dict):
        super().__init__()
        self._parts = parts

    def run(self, info):
        formats = info.get("requested_formats") or [info]
        self._parts["sizes"] = [f.get("filesize") or f.get("filesize_approx") or 0 for f in formats]
        return [], info


def _video_format(height: int) -> str:
    """H.264 + AAC first (plays on every phone, TV and PC without re-encoding), then anything."""
    h = f"[height<={height}]"
    return f"bestvideo{h}[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo{h}+bestaudio/best{h}/best"


def download_track(url, folder, basename, fmt="mp3", quality=192, tags=None,
                   embed_meta=True, on_progress=None) -> Path:
    """Download one video as audio (mp3/m4a) or video (mp4) and return the finished file.

    Work happens in `folder/.incomplete`, so a file only shows up in `folder` once it is
    fully converted and tagged; an interrupted download resumes from there next time.
    `on_progress` gets dicts like {"status": "downloading", "progress": 0.4, ...} and may
    raise DownloadCancelled to stop.
    """
    folder = Path(folder)
    work = folder / INCOMPLETE_DIR
    # outtmpl is a template, so a literal "%" in a title has to be escaped.
    template = str(work / basename).replace("%", "%%") + ".%(ext)s"

    # Video arrives as two downloads (picture, then sound); progress covers both.
    parts = {"sizes": [0], "done": 0, "bytes_done": 0}  # sizes are filled in by _RecordParts
    downloaded = False

    def report(**update):
        if on_progress:
            on_progress(update)

    def progress_hook(d):
        nonlocal downloaded
        sizes = parts["sizes"]
        current = min(parts["done"], len(sizes) - 1)
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            fraction = min((d.get("downloaded_bytes") or 0) / total, 1.0) if total else 0.0
            if len(sizes) > 1 and all(sizes):
                progress = (parts["bytes_done"] + fraction * sizes[current]) / sum(sizes)
            else:
                progress = (parts["done"] + fraction) / len(sizes)
            report(status="downloading", progress=min(progress, 0.99), speed=d.get("speed"), eta=d.get("eta"))
        elif d["status"] == "finished":
            parts["bytes_done"] += sizes[current]
            parts["done"] += 1
            if parts["done"] >= len(sizes):
                downloaded = True
                report(status="processing", progress=1.0, speed=None, eta=None)

    def postprocessor_hook(d):
        # The tagging step runs *before* the download too; only report work done after it.
        if d["status"] == "started" and downloaded:
            report(status="processing", progress=1.0, speed=None, eta=None)

    opts = {
        **_base_opts(),
        "outtmpl": template,
        "noplaylist": True,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
    }
    if fmt == "mp4":
        opts["format"] = _video_format(quality)
        opts["merge_output_format"] = "mp4"
        opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]  # sic
    else:
        opts["format"] = FORMATS[fmt]
        opts["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": str(quality)},
        ]
    if embed_meta:
        opts["writethumbnail"] = True
        opts["postprocessors"] += [
            {"key": "FFmpegMetadata", "add_metadata": True},
            {"key": "EmbedThumbnail"},
        ]

    with _youtube_dl(opts) as ydl:
        if tags:
            ydl.add_post_processor(_Tags(tags), when="pre_process")
        ydl.add_post_processor(_RecordParts(parts), when="before_dl")
        ydl.download([url])

    produced = work / f"{basename}.{fmt}"
    if not produced.exists():
        raise RuntimeError(f"Conversion failed: no {fmt.upper()} file was produced. Is ffmpeg installed?")
    target = folder / produced.name
    produced.replace(target)
    return target


# ================================
# CLEAN-UP
# ================================
def delete_track_files(folder, basename: str) -> None:
    """Delete a track's finished file and any half-finished leftovers."""
    folder = Path(folder)
    pattern = glob.escape(basename) + ".*"
    for path in [*folder.glob(pattern), *(folder / INCOMPLETE_DIR).glob(pattern)]:
        try:
            path.unlink()
        except OSError:
            pass


def tidy(folder, remove_if_empty: bool = False) -> None:
    """Remove the empty `.incomplete` work folder (and the album folder if asked)."""
    folder = Path(folder)
    for path in (folder / INCOMPLETE_DIR, folder) if remove_if_empty else (folder / INCOMPLETE_DIR,):
        try:
            path.rmdir()  # only succeeds when empty
        except OSError:
            pass
