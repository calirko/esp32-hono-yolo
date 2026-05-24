import json
import sys
from pathlib import Path

from ultralytics import YOLO


def main():
    trained = Path(__file__).parent / "best.pt"
    model = YOLO(str(trained) if trained.exists() else "yolo26l.pt")

    # Signal to Bun that the model is loaded and we're ready
    print("ready", flush=True)

    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
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
            print(json.dumps(output), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
