import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

const app = new Hono();

const ESP32_URL = process.env.ESP32_URL;
const PYTHON = process.env.PYTHON_BIN ?? "../image/.venv/bin/python";
const DETECT_SCRIPT = process.env.DETECT_SCRIPT ?? "../image/detect.py";
const ESP32_API_KEY = process.env.ESP32_API_KEY;

const esp32Headers = { "X-API-Key": ESP32_API_KEY ?? "" };

const checkEsp32: MiddlewareHandler = async (c, next) => {
  try {
    const res = await fetch(`${ESP32_URL}/health`, {
      headers: esp32Headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error();
  } catch {
    return c.json({ error: "ESP32 unreachable" }, 503);
  }
  await next();
};

app.get("/capture", checkEsp32, async (c) => {
  try {
    const res = await fetch(`${ESP32_URL}/capture`, {
      headers: esp32Headers,
      signal: AbortSignal.timeout(15000),
    });
    return new Response(res.body, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline; filename=capture.jpg",
      },
    });
  } catch {
    return c.json({ error: "Capture timed out" }, 504);
  }
});

app.get("/check", checkEsp32, async (c) => {
  // 1. Capture frame from ESP32
  let imageBuffer: Buffer;
  try {
    const res = await fetch(`${ESP32_URL}/capture`, {
      headers: esp32Headers,
      signal: AbortSignal.timeout(15000),
    });
    imageBuffer = Buffer.from(await res.arrayBuffer());
  } catch {
    return c.json({ error: "Capture timed out" }, 504);
  }

  // 2. Write frame to a temp file for Python
  const tmpPath = join(tmpdir(), `esp32-${randomUUID()}.jpg`);
  await Bun.write(tmpPath, imageBuffer);

  // 3. Run YOLO detection
  const proc = spawnSync(PYTHON, [DETECT_SCRIPT, tmpPath], {
    encoding: "utf8",
    timeout: 60000,
    cwd: join(import.meta.dir, "../../image"),
  });

  await Bun.file(tmpPath).exists().then(() => Bun.write(tmpPath, "")).catch(() => {});

  if (proc.status !== 0) {
    return c.json({ error: "Detection failed", detail: proc.stderr }, 500);
  }

  type Detection = {
    label: string;
    confidence: number;
    bbox: { x1: number; y1: number; x2: number; y2: number };
  };
  const detections: Detection[] = JSON.parse(proc.stdout);

  // 4. Draw boxes onto the image with sharp + SVG overlay
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width ?? 640;
  const h = meta.height ?? 480;

  const COLORS: Record<string, string> = {};
  const palette = ["#FF3B30", "#FF9500", "#34C759", "#007AFF", "#AF52DE", "#FF2D55", "#5AC8FA"];
  const colorFor = (label: string) => {
    if (!COLORS[label]) COLORS[label] = palette[Object.keys(COLORS).length % palette.length];
    return COLORS[label];
  };

  const svgBoxes = detections
    .map(({ label, confidence, bbox: { x1, y1, x2, y2 } }) => {
      const color = colorFor(label);
      const bw = x2 - x1;
      const bh = y2 - y1;
      const text = `${label} ${(confidence * 100).toFixed(0)}%`;
      const textY = y1 > 30 ? y1 - 8 : y2 + 24;
      return `
        <rect x="${x1}" y="${y1}" width="${bw}" height="${bh}"
              fill="none" stroke="${color}" stroke-width="3"/>
        <rect x="${x1}" y="${textY - 20}" width="${text.length * 12}" height="26"
              fill="${color}" opacity="0.85"/>
        <text x="${x1 + 4}" y="${textY}" font-family="monospace" font-size="20"
              font-weight="bold" fill="white">${text}</text>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svgBoxes}</svg>`;

  const annotated = await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return new Response(annotated, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": "inline; filename=check.jpg",
      "X-Detections": JSON.stringify(detections.map((d) => d.label)),
    },
  });
});

export default app;
