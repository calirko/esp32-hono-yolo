import shutil
import sys
import tempfile
from pathlib import Path

import yaml
from ultralytics import YOLO

DATASET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "dataset"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "yolo26l.pt"
EPOCHS = int(sys.argv[3]) if len(sys.argv) > 3 else 50
OUTPUT = Path(__file__).parent / "runs"


def build_yaml(dataset: Path) -> Path:
    src = yaml.safe_load((dataset / "data.yaml").read_text())

    train_images = dataset / "train" / "images"
    val_images = (
        dataset / "valid" / "images" if (dataset / "valid").exists() else train_images
    )

    data = {
        "train": str(train_images),
        "val": str(val_images),
        "nc": src["nc"],
        "names": src["names"],
    }

    tmp = tempfile.NamedTemporaryFile(suffix=".yaml", delete=False, mode="w")
    yaml.dump(data, tmp)
    tmp.close()
    return Path(tmp.name)


def main():
    print(f"Dataset   : {DATASET}")
    print(f"Base model: {MODEL}")
    print(f"Epochs    : {EPOCHS}")

    data_yaml = build_yaml(DATASET)
    model = YOLO(MODEL)

    model.train(
        data=str(data_yaml),
        epochs=EPOCHS,
        imgsz=640,
        project=str(OUTPUT),
        name="nightcat",
        exist_ok=True,
    )

    best = OUTPUT / "nightcat" / "weights" / "best.pt"
    dest = Path(__file__).parent / "best.pt"
    shutil.copy(best, dest)
    print(f"\nTraining complete. Best weights saved to: {dest}")


if __name__ == "__main__":
    main()
