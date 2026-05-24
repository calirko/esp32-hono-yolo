import json
import sys
import tkinter as tk
from tkinter import filedialog

from pathlib import Path

from ultralytics import YOLO


def pick_image() -> str:
    root = tk.Tk()
    root.withdraw()
    path = filedialog.askopenfilename(
        title="Select image",
        filetypes=[
            ("Image files", "*.jpg *.jpeg *.png *.bmp *.webp"),
            ("All files", "*.*"),
        ],
    )
    root.destroy()
    return path


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else pick_image()
    if not path:
        print("No image selected.", file=sys.stderr)
        sys.exit(1)

    trained = Path(__file__).parent / "best.pt"
    model = YOLO(str(trained) if trained.exists() else "yolo26x.pt")
    results = model(path, verbose=False)

    output = []
    for r in results:
        for box in r.boxes:
            output.append(
                {
                    "label": model.names[int(box.cls)],
                    "confidence": round(float(box.conf), 4),
                    "bbox": {
                        "x1": round(float(box.xyxy[0][0]), 1),
                        "y1": round(float(box.xyxy[0][1]), 1),
                        "x2": round(float(box.xyxy[0][2]), 1),
                        "y2": round(float(box.xyxy[0][3]), 1),
                    },
                }
            )

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
