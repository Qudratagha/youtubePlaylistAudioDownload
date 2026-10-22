# Playlist Saver

Download a YouTube playlist (or a single video) as numbered, tagged audio or video files. It runs as a small web app on your own computer.

## Run it

You need Python 3.10+ and [ffmpeg](https://ffmpeg.org/) (on Windows: `winget install Gyan.FFmpeg`).

```bash
pip install -r requirements.txt
python app.py
```

Your browser opens at http://127.0.0.1:8000. Paste a link, pick the tracks you want, and press **Download**.

## What you get

- Files named `001 - Title.mp3`, `002 - Title.mp3`, … The numbers follow the playlist order and are padded so they sort correctly on phones and car stereos, even past track 99.
- Single videos work too, and are saved as just `Title.mp3` or `Title.mp4` in a **Singles** folder. A link to a video opened from a playlist (`watch?v=…&list=…`) gets just that video, with a button to fetch the whole playlist instead.
- Title, album, track number and cover art written into each file (you can turn this off).
- **Audio:** MP3 at 128, 192 or 320 kbps, or M4A, which keeps YouTube's original audio without re-encoding.
- **Video:** MP4 at up to 360p, 480p, 720p or 1080p. It uses H.264 with AAC sound when YouTube has it, which plays on any phone, TV or PC.
- Live progress for each track, a Stop button, and Retry for anything that failed.
- Tracks you already have are skipped. If a download is interrupted, it picks up where it left off next time.
- A built-in player, plus a save button for each track and a ZIP of the whole playlist.
- Download history that survives restarts.

Files go into `downloads/<album name>/`.

## Settings

Set these as environment variables before `python app.py`:

| Variable | Default | What it does |
| --- | --- | --- |
| `DOWNLOAD_DIR` | `./downloads` | Where albums are saved |
| `WORKERS` | `3` | How many tracks download at the same time |
| `PORT` | `8000` | Port to listen on |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to open it from your phone on the same Wi-Fi. Anyone on that network can then use it. |
| `FFMPEG_LOCATION` | — | Path to ffmpeg, if it isn't on your PATH |
| `NO_BROWSER` | — | Set to anything to stop the browser opening automatically |

## Command line

The original script still works without the web app:

```bash
python main.py "https://www.youtube.com/playlist?list=..." --out "My folder" --format mp3 --quality 192
python main.py "https://www.youtube.com/playlist?list=..." --out "My videos" --format mp4 --quality 720
```

## Files

| File | Purpose |
| --- | --- |
| `app.py` | Web server (FastAPI): API, live progress, serving files |
| `jobs.py` | Download queue, progress tracking, history (`data/jobs.json`) |
| `downloader.py` | yt-dlp code shared by the web app and the CLI |
| `main.py` | Command-line version |
| `static/` | Front end (plain HTML/CSS/JS, no build step) |

## Troubleshooting

- **"Confirm you're not a bot"**: YouTube has flagged your connection, usually after a lot of downloading, and wants a signed-in account. Open **Settings** (the sliders icon, top right) and pick how to sign in:
  - **cookies.txt file**: the reliable option if you use Chrome. Install the [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) extension, open youtube.com while signed in, export, and upload the file in Settings.
  - **Firefox**: works while Firefox is open, but you must be signed in to YouTube in Firefox.
  - **Chrome / Edge**: on Windows they lock their cookies while open, and Chrome also encrypts them, so this usually fails.

  Press **Test YouTube access** to check, then **Retry** on the failed download. A spare Google account is safest, because YouTube can flag accounts that download heavily. The uploaded file is stored in `data/cookies.txt`. Anyone who has it can use that YouTube login, so don't share it.
- **Downloads suddenly fail for every video**: YouTube changes often. `pip install -U "yt-dlp[default]"` fixes this almost every time.
- **Warnings about a "JavaScript runtime"**: yt-dlp needs [Node.js](https://nodejs.org/) or [Deno](https://deno.com/) to read YouTube's player. Install either one.

For the command line, add `--cookies-from-browser firefox` (or `--cookies cookies.txt`).
