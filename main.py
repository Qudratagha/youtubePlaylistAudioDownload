"""Command-line version, for when you don't want the web app (python app.py).

    python main.py                                  # uses the defaults below
    python main.py "<playlist url>" --out "My folder" --format m4a
"""
import argparse
import sys
from pathlib import Path

import downloader

# ================================
# DEFAULTS
# ================================
PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL01-dgFbwDbFGPApXg2kWXGR7p_BYSae5"
DOWNLOAD_DIR = "quran recitation surah vice"


# ================================
# MAIN PROGRAM
# ================================
def main():
    parser = argparse.ArgumentParser(description="Download a YouTube playlist as audio or video files.")
    parser.add_argument("url", nargs="?", default=PLAYLIST_URL, help="playlist or video link")
    parser.add_argument("--out", default=DOWNLOAD_DIR, help="folder to save into")
    parser.add_argument("--format", choices=sorted(downloader.FORMATS), default="mp3",
                        help="mp3 or m4a for audio, mp4 for video")
    parser.add_argument("--quality", type=int,
                        help="kbps for audio (128/192/320, default 192); max height for mp4 (360/480/720/1080, default 720)")
    parser.add_argument("--cookies-from-browser", choices=downloader.BROWSERS, metavar="BROWSER",
                        help="use this browser's YouTube login if YouTube asks to confirm you're not a bot")
    parser.add_argument("--cookies", metavar="FILE", help="cookies.txt file to use instead")
    args = parser.parse_args()
    downloader.configure(args.cookies_from_browser, args.cookies)
    quality = args.quality or downloader.DEFAULT_QUALITY[args.format]
    if quality not in downloader.QUALITIES[args.format]:
        parser.error(f"--quality for {args.format} must be one of {downloader.QUALITIES[args.format]}")

    print("Fetching playlist...\n")

    # ---- Load playlist safely ----
    try:
        info = downloader.inspect(args.url)
    except Exception as e:
        print(f"❌ Failed to load playlist: {downloader.error_message(e)}")
        sys.exit(1)

    entries = info["entries"]
    total = max(e["index"] for e in entries)
    pad = downloader.pad_width(total) if info["kind"] == "playlist" else 0  # no number for one video
    folder = Path(args.out)
    print(f"Found {len(entries)} videos in playlist.\n")

    # ---- Download each video safely ----
    failed = []
    for entry in entries:
        basename = downloader.track_basename(entry["index"], entry["title"], pad)
        print(f"[{entry['index']}/{total}] {basename}")

        if not entry["available"]:
            print("   ⏭  Skipped: video is private or deleted")
            failed.append((basename, "Video is private or deleted"))
            continue
        if (folder / f"{basename}.{args.format}").exists():
            print("   ✓ Already downloaded")
            continue

        try:
            downloader.download_track(
                entry["url"], folder, basename, args.format, quality,
                tags={"album": info["title"], "track_number": entry["index"]},
            )
        except Exception as e:
            reason = downloader.error_message(e)
            print(f"   ❌ Skipped: {reason}")
            failed.append((basename, reason))

    downloader.tidy(folder)

    if failed:
        print(f"\nFinished with {len(failed)} of {len(entries)} skipped:")
        for name, reason in failed:
            print(f"   • {name}: {reason}")
    else:
        print(f"\n🎉 All {len(entries)} files downloaded to {folder.resolve()}")


if __name__ == "__main__":
    main()
