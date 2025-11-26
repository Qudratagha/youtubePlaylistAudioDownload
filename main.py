import yt_dlp
import re
from urllib.parse import unquote
import os

# ================================
# CONFIGURATION
# ================================
PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLhuK8aGRXLf23e3uvwXB1lidk3okpdylO"
DOWNLOAD_DIR = "downloaded_mp3"

os.makedirs(DOWNLOAD_DIR, exist_ok=True)


# ================================
# CLEAN SAFE FILENAME
# ================================
def clean_filename(title):
    title = unquote(title)
    title = title.replace(" ", "_")
    title = re.sub(r"[^\w\-_.]", "_", title)
    return title


# ================================
# FETCH PLAYLIST VIDEO LIST
# ================================
def fetch_video_list(playlist_url):
    ydl_opts = {"quiet": True, "extract_flat": True}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)

    videos = []
    for entry in info.get("entries", []):
        video_url = f"https://www.youtube.com/watch?v={entry['id']}"
        title = clean_filename(entry.get("title", "video"))
        videos.append((video_url, title))

    return videos


# ================================
# DOWNLOAD AS MP3
# ================================
def download_mp3(url, filename):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': f'{DOWNLOAD_DIR}/{filename}.%(ext)s',
        'postprocessors': [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',   # good quality MP3
            }
        ]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


# ================================
# MAIN PROGRAM
# ================================
if __name__ == "__main__":
    print("Fetching playlist...\n")

    videos = fetch_video_list(PLAYLIST_URL)
    print(f"Found {len(videos)} videos in playlist.\n")

    for idx, (url, title) in enumerate(videos, start=1):
        filename = f"{idx:02d}_{title}"
        print(f"Downloading MP3 → {filename}")
        download_mp3(url, filename)

    print("\n🎉 All MP3 files downloaded successfully!")
