"""Download jobs: the state the browser sees, a worker pool, and a JSON history file."""
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import downloader
from downloader import DownloadCancelled

ACTIVE = ("queued", "downloading", "processing")
AUTO_RETRIES = 2  # extra tries after a network hiccup before a track counts as failed


class NotFound(LookupError):
    pass


@dataclass
class Track:
    id: str
    index: int  # position in the original playlist; used for the file number
    title: str
    url: str
    duration: float | None = None
    thumbnail: str | None = None
    status: str = "queued"  # queued | downloading | processing | done | error | cancelled
    progress: float = 0.0
    speed: float | None = None
    eta: int | None = None
    error: str | None = None
    note: str | None = None
    file: str | None = None  # finished file name inside the job folder
    size: int | None = None


@dataclass
class Job:
    id: str
    title: str  # album name, also used for the folder name
    folder: str
    source: str
    format: str
    quality: int
    embed_meta: bool
    pad: int
    created: float
    tracks: list[Track] = field(default_factory=list)
    cancelled: bool = False
    version: int = 0

    def summary(self) -> dict:
        counts = dict.fromkeys(("queued", "downloading", "processing", "done", "error", "cancelled"), 0)
        for track in self.tracks:
            counts[track.status] += 1

        if any(counts[s] for s in ACTIVE):
            status = "cancelling" if self.cancelled else "running"
        elif counts["done"] == len(self.tracks):
            status = "done"
        elif counts["done"]:
            status = "partial"
        elif counts["error"]:
            status = "failed"
        else:
            status = "cancelled"

        finished = counts["done"] + sum(t.progress for t in self.tracks if t.status in ACTIVE)
        speed = sum(t.speed or 0 for t in self.tracks if t.status == "downloading")
        return {
            "status": status,
            "counts": counts,
            "progress": finished / len(self.tracks) if self.tracks else 0,
            "speed": speed or None,
        }

    def to_dict(self) -> dict:
        return {**asdict(self), **self.summary()}


def _from_dict(cls, data: dict):
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in names})


class JobManager:
    def __init__(self, root: Path, state_file: Path, workers: int = 3):
        self.root = root
        self._state_file = state_file
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="download")
        self._stopping = False
        self.root.mkdir(parents=True, exist_ok=True)
        self._load()

    # ---------- queries ----------
    def versions(self) -> dict[str, int]:
        with self._lock:
            return {job.id: job.version for job in self._jobs.values()}

    def snapshot(self, job_id: str) -> dict:
        with self._lock:
            return self._get(job_id).to_dict()

    def snapshots(self) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created, reverse=True)
            return [job.to_dict() for job in jobs]

    def folder(self, job_id: str) -> Path:
        with self._lock:
            return Path(self._get(job_id).folder)

    def track_file(self, job_id: str, n: int) -> Path:
        with self._lock:
            job = self._get(job_id)
            if not 0 <= n < len(job.tracks) or not job.tracks[n].file:
                raise NotFound(n)
            path = Path(job.folder) / job.tracks[n].file
        if not path.is_file():
            raise NotFound(n)
        return path

    def finished_files(self, job_id: str) -> tuple[Path, list[Path]]:
        with self._lock:
            job = self._get(job_id)
            folder = Path(job.folder)
            names = [t.file for t in job.tracks if t.status == "done" and t.file]
        return folder, [folder / name for name in names if (folder / name).is_file()]

    # ---------- commands ----------
    def create(self, *, title: str, source: str, fmt: str, quality: int, embed_meta: bool,
               total: int, tracks: list[dict], numbered: bool = True) -> str:
        title = title.strip()
        job = Job(
            id=uuid.uuid4().hex[:12],
            title=title,
            folder=str(self.root / downloader.safe_name(title, "Downloads")),
            source=source,
            format=fmt,
            quality=quality,
            embed_meta=embed_meta,
            pad=downloader.pad_width(total) if numbered else 0,  # 0 = no number in file names
            created=time.time(),
            tracks=[Track(**t) for t in tracks],
        )
        with self._lock:
            self._jobs[job.id] = job
            self._changed(job, save=True)
        downloader.forget_cookies()  # pick up a fresh YouTube login if the user just signed in
        for track in job.tracks:
            self._pool.submit(self._run, job, track)
        return job.id

    def cancel(self, job_id: str) -> None:
        with self._lock:
            job = self._get(job_id)
            job.cancelled = True
            for track in job.tracks:
                if track.status == "queued":
                    track.status = "cancelled"
            self._changed(job, save=True)

    def retry(self, job_id: str, n: int | None = None) -> None:
        """Queue failed or stopped tracks again: all of them, or just track `n`.

        Works while the rest of the job is still downloading.
        """
        with self._lock:
            job = self._get(job_id)
            if n is not None and not 0 <= n < len(job.tracks):
                raise NotFound(n)
            job.cancelled = False
            candidates = job.tracks if n is None else [job.tracks[n]]
            again = [t for t in candidates if t.status in ("error", "cancelled")]
            for track in again:
                track.status, track.progress = "queued", 0.0
                track.error = track.note = track.speed = track.eta = None
            self._changed(job, save=True)
        downloader.forget_cookies()
        for track in again:
            self._pool.submit(self._run, job, track)

    def remove(self, job_id: str, delete_files: bool = False) -> None:
        with self._lock:
            job = self._get(job_id)
            del self._jobs[job_id]
            job.cancelled = True  # running tracks stop at their next progress update
            self._save()
        if delete_files:
            folder = Path(job.folder)
            for track in job.tracks:
                downloader.delete_track_files(folder, downloader.track_basename(track.index, track.title, job.pad))
            downloader.tidy(folder, remove_if_empty=True)

    def shutdown(self) -> None:
        """Stop quickly: queued tracks are dropped and running ones abort; Retry resumes them."""
        self._stopping = True
        self._pool.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            self._save()

    # ---------- worker ----------
    def _run(self, job: Job, track: Track) -> None:
        with self._lock:
            if self._stopping or job.cancelled or track.status != "queued":
                return
            track.status = "downloading"
            self._changed(job, save=True)

        folder = Path(job.folder)
        basename = downloader.track_basename(track.index, track.title, job.pad)
        existing = folder / f"{basename}.{job.format}"
        if existing.is_file():
            self._finish(job, track, existing, note="Already downloaded")
            return

        def on_progress(update: dict) -> None:
            if self._stopping or job.cancelled:
                raise DownloadCancelled("Cancelled")
            with self._lock:
                for key, value in update.items():
                    setattr(track, key, value)
                self._changed(job)

        try:
            for attempt in range(AUTO_RETRIES + 1):
                try:
                    path = downloader.download_track(
                        track.url, folder, basename, job.format, job.quality,
                        tags={"album": job.title, **({"track_number": track.index} if job.pad else {})},
                        embed_meta=job.embed_meta, on_progress=on_progress,
                    )
                except Exception as exc:
                    stopped = self._stopping or job.cancelled or isinstance(exc, DownloadCancelled)
                    if not stopped and attempt < AUTO_RETRIES and downloader.is_transient(exc):
                        # Network hiccup: wait a little and resume from the partial file.
                        with self._lock:
                            track.speed = track.eta = None
                            track.note = f"Connection problem. Trying again ({attempt + 1} of {AUTO_RETRIES})…"
                            self._changed(job)
                        if self._wait(job, 5 * (attempt + 1)):
                            with self._lock:
                                track.note = None
                                self._changed(job)
                            continue
                        stopped = True
                    with self._lock:
                        track.status = "cancelled" if stopped else "error"
                        track.error = None if stopped else downloader.error_message(exc)
                        track.note = track.speed = track.eta = None
                        self._changed(job, save=True)
                else:
                    self._finish(job, track, path)
                break
        finally:
            with self._lock:
                idle = not any(t.status in ACTIVE for t in job.tracks)
            if idle:
                downloader.tidy(folder)

    def _wait(self, job: Job, seconds: float) -> bool:
        """Sleep, but give up early (returning False) if the job is stopped."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self._stopping or job.cancelled:
                return False
            time.sleep(0.25)
        return not (self._stopping or job.cancelled)

    def _finish(self, job: Job, track: Track, path: Path, note: str | None = None) -> None:
        with self._lock:
            track.status, track.progress, track.note = "done", 1.0, note
            track.error = track.speed = track.eta = None
            track.file, track.size = path.name, path.stat().st_size
            self._changed(job, save=True)

    # ---------- state ----------
    def _get(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError:
            raise NotFound(job_id) from None

    def _changed(self, job: Job, save: bool = False) -> None:
        job.version += 1
        if save:
            self._save()

    def _save(self) -> None:
        data = [job.to_dict() for job in self._jobs.values()]
        self._state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._state_file.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._state_file)
        except OSError as exc:  # e.g. file briefly locked by antivirus; next save catches up
            print(f"Could not save job history: {exc}")

    def _load(self) -> None:
        try:
            data = json.loads(self._state_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            print(f"Ignoring unreadable job history ({exc})")
            return
        for item in data:
            job = _from_dict(Job, {**item, "tracks": [_from_dict(Track, t) for t in item.get("tracks", [])]})
            for track in job.tracks:
                if track.status in ACTIVE:  # the app was closed mid-download
                    track.status, track.note = "cancelled", "Stopped when the app closed"
                    track.progress, track.speed, track.eta = 0.0, None, None
            self._jobs[job.id] = job
