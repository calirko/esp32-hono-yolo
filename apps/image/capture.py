import os
import sys
from datetime import datetime
from pathlib import Path

import requests

ESP32_URL = os.getenv("ESP32_URL", "http://192.168.1.50")
API_KEY = os.getenv("ESP32_API_KEY", "0MYIWaLu8xM4KlL8RE7lgWvA17yMUN3M")
OUT_DIR = Path(__file__).parent / "captures"
OUT_DIR.mkdir(exist_ok=True)


def capture() -> Path:
    r = requests.get(f"{ESP32_URL}/capture", headers={"X-API-Key": API_KEY}, timeout=15)
    r.raise_for_status()
    filename = OUT_DIR / f"{datetime.now().isoformat()}.jpg"
    filename.write_bytes(r.content)
    return filename


print(f"Saving to {OUT_DIR}")
print("Press Enter to capture, q+Enter to quit.\n")

count = 0
while True:
    try:
        key = input(f"[{count} saved] capture > ").strip().lower()
    except (KeyboardInterrupt, EOFError):
        break
    if key == "q":
        break
    try:
        path = capture()
        count += 1
        print(f"  saved: {path.name}")
        # os.system(f"kitten icat --scale-up --align left '{path}'")
    except Exception as e:
        print(f"  error: {e}")

print(f"\nDone. {count} images saved to {OUT_DIR}")
