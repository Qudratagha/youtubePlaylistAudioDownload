"""Web app: paste a YouTube playlist or video link, get numbered and tagged audio files.

Run:   python app.py        (opens http://127.0.0.1:8000)
"""
import asyncio
import hashlib
import io
import json
import mimetypes
import os
import subprocess
import sys
import threading
import webbrowser
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

import downloader
from jobs import JobManager, NotFound

# ================================
# CONFIGURATION (override with environment variables)
# ================================
BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR") or BASE_DIR / "downloads").resolve()
DATA_DIR = Path(os.environ.get("DATA_DIR") or BASE_DIR / "data").resolve()  # history & settings
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
WORKERS = int(os.environ.get("WORKERS", "3"))  # tracks downloaded at the same time

MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4"}
# Some Windows registries map .js to text/plain, which browsers refuse to run as a module.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

SETTINGS_FILE = DATA_DIR / "settings.json"
COOKIES_FILE = DATA_DIR / "cookies.txt"  # uploaded from Settings; gives access to that YouTube account
COOKIE_SOURCES = ("off", "file", *downloader.BROWSERS)

manager = JobManager(DOWNLOAD_DIR, DATA_DIR / "jobs.json", workers=WORKERS)


def _code_fingerprint() -> str:
    """Hash of the server code, to notice when it was updated but not restarted."""
    digest = hashlib.sha1()
    for name in ("app.py", "jobs.py", "downloader.py"):
        digest.update((BASE_DIR / name).read_bytes())
    return digest.hexdigest()


STARTUP_CODE = _code_fingerprint()


def _load_settings() -> dict:
    try:
        settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    if "cookies" not in settings:  # older format: {"cookies_browser": ..., "cookies_file": ...}
        settings = {"cookies": settings.get("cookies_browser") or "off"}
    return settings


def _apply_settings(settings: dict) -> None:
    source = settings.get("cookies", "off")
    downloader.configure(
        cookies_browser=source if source in downloader.BROWSERS else None,
        cookies_file=str(COOKIES_FILE) if source == "file" and COOKIES_FILE.is_file() else None,
    )


def _cookies_file_info() -> dict | None:
    """What the uploaded cookies.txt contains, without exposing any values."""
    try:
        rows = _cookie_rows(COOKIES_FILE.read_text(encoding="utf-8"))
    except OSError:
        return None
    youtube = [r for r in rows if r[0].endswith("youtube.com")]
    return {
        "youtube_cookies": len(youtube),
        "signed_in": any(r[5] in downloader.LOGIN_COOKIES for r in youtube),
        "uploaded": COOKIES_FILE.stat().st_mtime,
    }


def _cookie_rows(text: str) -> list[list[str]]:
    """Parse Netscape cookies.txt lines (`#HttpOnly_` lines are cookies, other `#` lines are comments)."""
    rows = []
    for line in text.splitlines():
        if not line.strip() or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        rows.append(line.removeprefix("#HttpOnly_").split("\t"))
    return rows


_apply_settings(_load_settings())


@asynccontextmanager
async def lifespan(_app):
    yield
    manager.shutdown()


app = FastAPI(title="Playlist Saver", lifespan=lifespan)


@app.exception_handler(NotFound)
async def not_found(_request, _exc):
    return JSONResponse({"detail": "Not found"}, status_code=404)


# ================================
# REQUEST BODIES
# ================================
class InspectIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


class TrackIn(BaseModel):
    id: str
    index: int = Field(ge=1)
    title: str
    url: str = Field(pattern=r"^https?://")
    duration: float | None = None
    thumbnail: str | None = None


class SettingsIn(BaseModel):
    cookies: Literal[COOKIE_SOURCES] = "off"


class CookiesFileIn(BaseModel):
    content: str = Field(min_length=1, max_length=2_000_000)


class JobIn(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    source: str
    format: Literal["mp3", "m4a", "mp4"] = "mp3"
    quality: int = 192  # kbps for audio, maximum height for video
    embed_meta: bool = True
    total: int = Field(ge=1)  # playlist length; decides how many digits file numbers get
    numbered: bool = True  # False for single videos: no "01 - " in the file name
    tracks: list[TrackIn] = Field(min_length=1, max_length=5000)

    @model_validator(mode="after")
    def _quality_fits_format(self):
        allowed = downloader.QUALITIES[self.format]
        if self.quality not in allowed:
            raise ValueError(f"quality for {self.format} must be one of {allowed}")
        return self


# ================================
# API
# ================================
@app.get("/api/status")
def status(request: Request):
    return {
        # Browser on this computer: files are already here, so offer "show in folder", not "save".
        "local": request.client is not None and request.client.host in ("127.0.0.1", "::1"),
        "ffmpeg": downloader.ffmpeg_available(),
        "download_dir": str(DOWNLOAD_DIR),
        "yt_dlp": yt_dlp.version.__version__,
        "workers": WORKERS,
        "restart_needed": _code_fingerprint() != STARTUP_CODE,
    }


@app.get("/api/settings")
def get_settings():
    return {**_load_settings(), "browsers": downloader.BROWSERS, "cookies_file": _cookies_file_info()}


@app.put("/api/settings")
def save_settings(body: SettingsIn):
    if body.cookies == "file" and not COOKIES_FILE.is_file():
        raise HTTPException(400, "Upload a cookies.txt file first.")
    settings = body.model_dump()
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings), encoding="utf-8")
    _apply_settings(settings)
    return get_settings()


@app.put("/api/settings/cookies-file")
def upload_cookies_file(body: CookiesFileIn):
    text = body.content.lstrip("﻿").replace("\r\n", "\n")
    rows = _cookie_rows(text)
    if not rows or any(len(r) < 7 for r in rows):
        raise HTTPException(400, "That isn't a cookies.txt file. Export one with the “Get cookies.txt LOCALLY” "
                                 "extension (Netscape format, not JSON).")
    if not any(r[0].endswith("youtube.com") for r in rows):
        raise HTTPException(400, "That file has no YouTube cookies. Export it while you're on youtube.com.")
    if not text.startswith(("# Netscape HTTP Cookie File", "# HTTP Cookie File")):
        text = "# Netscape HTTP Cookie File\n" + text  # yt-dlp insists on the header
    COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    COOKIES_FILE.write_text(text, encoding="utf-8")
    _apply_settings(_load_settings())
    return _cookies_file_info()


@app.delete("/api/settings/cookies-file", status_code=204)
def delete_cookies_file():
    COOKIES_FILE.unlink(missing_ok=True)
    settings = _load_settings()
    if settings.get("cookies") == "file":
        settings["cookies"] = "off"
        SETTINGS_FILE.write_text(json.dumps(settings), encoding="utf-8")
    _apply_settings(settings)


@app.post("/api/settings/test")
def test_settings():
    try:
        title = downloader.check_youtube()
    except Exception as exc:
        return {"ok": False, "error": downloader.error_message(exc)}
    return {"ok": True, "title": title}


@app.post("/api/inspect")
def inspect(body: InspectIn):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Paste a full link that starts with https://")
    try:
        return downloader.inspect(url)
    except Exception as exc:
        raise HTTPException(422, downloader.error_message(exc)) from None


@app.get("/api/jobs")
def list_jobs():
    return manager.snapshots()


@app.post("/api/jobs", status_code=201)
def create_job(body: JobIn):
    if not downloader.ffmpeg_available():
        raise HTTPException(409, "ffmpeg isn't installed, so audio can't be converted.")
    job_id = manager.create(
        title=body.title, source=body.source, fmt=body.format, quality=body.quality,
        embed_meta=body.embed_meta, total=body.total, numbered=body.numbered,
        tracks=[t.model_dump() for t in body.tracks],
    )
    return manager.snapshot(job_id)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    manager.cancel(job_id)
    return manager.snapshot(job_id)


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    manager.retry(job_id)
    return manager.snapshot(job_id)


@app.post("/api/jobs/{job_id}/tracks/{n}/retry")
def retry_track(job_id: str, n: int):
    manager.retry(job_id, n)
    return manager.snapshot(job_id)


@app.delete("/api/jobs/{job_id}", status_code=204)
def remove_job(job_id: str, delete_files: bool = False):
    manager.remove(job_id, delete_files)


@app.post("/api/jobs/{job_id}/open", status_code=204)
def open_folder(job_id: str):
    folder = manager.folder(job_id)
    if not folder.is_dir():
        raise HTTPException(404, "The folder doesn't exist yet. It's created when the first track finishes.")
    _show_in_file_manager(folder)


@app.post("/api/jobs/{job_id}/tracks/{n}/reveal", status_code=204)
def reveal_track(job_id: str, n: int):
    _show_in_file_manager(manager.track_file(job_id, n), select=True)


def _show_in_file_manager(path: Path, select: bool = False) -> None:
    """Open the folder (or the file's folder with the file selected) on this computer."""
    if sys.platform == "win32":
        if select:  # explorer wants /select,"path" exactly; file names never contain quotes
            subprocess.Popen(f'explorer /select,"{path}"')
        else:
            os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path] if select else ["open", path])
    else:
        subprocess.Popen(["xdg-open", path.parent if select else path])


@app.get("/api/jobs/{job_id}/tracks/{n}/file")
def track_file(job_id: str, n: int, download: bool = False):
    path = manager.track_file(job_id, n)
    return FileResponse(
        path,
        media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        filename=path.name,
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/api/jobs/{job_id}/zip")
def job_zip(job_id: str):
    folder, files = manager.finished_files(job_id)
    if not files:
        raise HTTPException(404, "No finished files to zip yet.")
    return StreamingResponse(
        _zip_stream(folder.name, files),
        media_type="application/zip",
        headers={"Content-Disposition": _attachment(f"{folder.name}.zip")},
    )


@app.get("/api/events")
async def events(request: Request):
    """Server-sent events: a full `sync` on connect, then each job whenever it changes."""

    async def stream():
        seen = manager.versions()
        yield _sse({"type": "sync", "jobs": manager.snapshots()})
        quiet_ticks = 0
        while not await request.is_disconnected():
            await asyncio.sleep(0.25)
            current = manager.versions()
            for job_id, version in current.items():
                if seen.get(job_id) != version:
                    try:
                        yield _sse({"type": "job", "job": manager.snapshot(job_id)})
                    except NotFound:
                        pass
            for job_id in seen.keys() - current.keys():
                yield _sse({"type": "removed", "id": job_id})
            quiet_ticks = quiet_ticks + 1 if current == seen else 0
            if quiet_ticks >= 60:  # keep idle connections alive
                quiet_ticks = 0
                yield ": ping\n\n"
            seen = current

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ================================
# HELPERS
# ================================
def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _attachment(filename: str) -> str:
    stem, ext = os.path.splitext(filename)
    fallback = stem.encode("ascii", "ignore").decode().replace('"', "").strip(" ._-") or "playlist"
    return f"attachment; filename=\"{fallback}{ext}\"; filename*=UTF-8''{quote(filename)}"


class _ZipSink(io.RawIOBase):
    """Write-only buffer that lets zipfile stream straight into the response."""

    def __init__(self):
        self._data = bytearray()

    def writable(self):
        return True

    def write(self, b):
        self._data += b
        return len(b)

    def take(self) -> bytes:
        data = bytes(self._data)
        self._data.clear()
        return data


def _zip_stream(folder_name: str, files: list[Path]):
    sink = _ZipSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
        for path in files:
            with path.open("rb") as src, zf.open(f"{folder_name}/{path.name}", "w") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
                    if data := sink.take():
                        yield data
    yield sink.take()


class _AppFiles(StaticFiles):
    """Serve the front end without letting the browser cache an old version."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", _AppFiles(directory=BASE_DIR / "static", html=True), name="static")


# ================================
# MAIN PROGRAM
# ================================
if __name__ == "__main__":
    import uvicorn

    local_host = "127.0.0.1" if HOST in ("0.0.0.0", "::") else HOST
    url = f"http://{local_host}:{PORT}"
    print(f"Playlist Saver is running at {url}  (Ctrl+C to stop)")
    print(f"Files are saved to {DOWNLOAD_DIR}")
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, webbrowser.open, [url]).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", timeout_graceful_shutdown=1)
