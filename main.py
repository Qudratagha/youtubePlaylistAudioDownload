import yt_dlp
import re
from urllib.parse import unquote
import os
import sys

# ================================
# CONFIGURATION
# ================================
PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLhuK8aGRXLf23e3uvwXB1lidk3okpdylO"
DOWNLOAD_DIR = "downloaded_mp3"

os.makedirs(DOWNLOAD_DIR, exist_ok=True)


# ================================
# CLEAN SAFE FILENAME
# ================================
def clean_filename(title: str) -> str:
    title = unquote(title or "video")
    title = title.strip()
    title = title.replace(" ", "_")
    title = re.sub(r"[^\w\-_.]", "_", title)
    return title[:200]  # avoid super-long filenames


# ================================
# FETCH PLAYLIST VIDEO LIST
# ================================
def fetch_video_list(playlist_url: str):
    ydl_opts = {
        "quiet": True,
        "extract_flat": True,  # Only get metadata, faster for playlists
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)

    if not info:
        raise RuntimeError("Could not fetch playlist info (empty response).")

    entries = info.get("entries") or []
    if not entries:
        raise RuntimeError("No videos found in playlist.")

    videos = []
    for entry in entries:
        video_id = entry.get("id")
        if not video_id:
            continue  # skip invalid entries

        video_url = f"https://www.youtube.com/watch?v={video_id}"
        title = clean_filename(entry.get("title", "video"))
        videos.append((video_url, title))

    return videos


# ================================
# DOWNLOAD AS MP3
# ================================
def download_mp3(url: str, filename: str):
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(DOWNLOAD_DIR, f"{filename}.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        # If ffmpeg path needed:
        # "ffmpeg_location": r"C:\path\to\ffmpeg\bin",
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


# ================================
# MAIN PROGRAM
# ================================
if __name__ == "__main__":
    print("Fetching playlist...\n")

    # ---- Load playlist safely ----
    try:
        videos = fetch_video_list(PLAYLIST_URL)
    except Exception as e:
        print(f"❌ Failed to load playlist: {e}")
        sys.exit(1)

    print(f"Found {len(videos)} videos in playlist.\n")

    # ---- Download each video safely ----
    for idx, (url, title) in enumerate(videos, start=1):
        filename = f"{idx:02d}_{title}"
        print(f"[{idx}/{len(videos)}] Downloading MP3 → {filename}")

        try:
            download_mp3(url, filename)
        except Exception as e:
            print(f"❌ Skipped video: {url}")
            print(f"   Reason: {e}")
            continue

    print("\n🎉 All possible MP3 files downloaded (skipped broken/copyright videos).")
