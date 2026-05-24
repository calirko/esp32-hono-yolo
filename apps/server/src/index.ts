import { Hono } from "hono";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import sharp from "sharp";

const CAPTURES_DIR = join(import.meta.dir, "../captures");
mkdirSync(CAPTURES_DIR, { recursive: true });

function saveCapture(id: number, buf: Buffer): void {
  const filename = `${Date.now()}-cam${id}.jpg`;
  Bun.write(join(CAPTURES_DIR, filename), buf).catch((e) =>
    console.error("[capture] save failed:", e)
  );
}

const app = new Hono();

const PYTHON = process.env.PYTHON_BIN ?? "../image/.venv/bin/python";
const WORKER_SCRIPT = join(import.meta.dir, "../../image/worker.py");
const WORKER_CWD = join(import.meta.dir, "../../image");

// --- Python worker (persistent, model loaded once) ---

type Detection = {
  label: string;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number };
};

type QueueEntry = {
  resolve: (detections: Detection[]) => void;
  reject: (e: Error) => void;
};

class YoloWorker {
  private proc: ReturnType<typeof Bun.spawn>;
  private queue: QueueEntry[] = [];
  private buffer = "";
  private encoder = new TextEncoder();
  ready: Promise<void>;

  constructor() {
    this.proc = Bun.spawn([PYTHON, WORKER_SCRIPT], {
      cwd: WORKER_CWD,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    this.ready = new Promise((resolve) => {
      this.readLoop(resolve);
    });
  }

  private async readLoop(onReady: () => void) {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let ready = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      this.buffer += decoder.decode(value, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (!ready && trimmed === "ready") {
          ready = true;
          onReady();
          continue;
        }

        const entry = this.queue.shift();
        if (!entry) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.error) entry.reject(new Error(parsed.error));
          else entry.resolve(parsed);
        } catch (e) {
          entry.reject(new Error(`Bad response: ${trimmed}`));
        }
      }
    }
  }

  async detect(imagePath: string): Promise<Detection[]> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(this.encoder.encode(imagePath + "\n"));
    });
  }
}

const yolo = new YoloWorker();
yolo.ready.then(() => console.log("[yolo] worker ready"));

// --- Devices ---

const devices = (() => {
  const list = [];
  for (let i = 0; ; i++) {
    const url = process.env[`ESP32_URL_${i}`];
    if (!url) break;
    list.push({ id: i, url, key: process.env[`ESP32_API_KEY_${i}`] ?? "" });
  }
  return list;
})();

if (devices.length === 0) {
  console.warn("No devices configured. Set ESP32_URL_0, ESP32_API_KEY_0, ...");
}

type Device = (typeof devices)[0];

async function pingDevice(d: Device): Promise<boolean> {
  try {
    const res = await fetch(`${d.url}/health`, {
      headers: { "X-API-Key": d.key },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function captureDevice(d: Device): Promise<Buffer | null> {
  try {
    const res = await fetch(`${d.url}/capture`, {
      headers: { "X-API-Key": d.key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// --- Image helpers ---

async function stitchSideBySide(images: Buffer[]): Promise<Buffer> {
  // Convert to PNG first — compositing JPEG-over-JPEG is unreliable in sharp
  const pngs = await Promise.all(images.map((buf) => sharp(buf).png().toBuffer()));
  const metas = await Promise.all(pngs.map((buf) => sharp(buf).metadata()));
  const totalWidth = metas.reduce((sum, m) => sum + (m.width ?? 0), 0);
  const maxHeight = Math.max(...metas.map((m) => m.height ?? 0));

  let xOffset = 0;
  const composites = pngs.map((buf, i) => {
    const comp = { input: buf, left: xOffset, top: 0 };
    xOffset += metas[i].width ?? 0;
    return comp;
  });

  return sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function annotate(buffer: Buffer, deviceId: number, detections: Detection[]): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
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
      const text = `${label} ${(confidence * 100).toFixed(0)}%`;
      const textY = y1 > 30 ? y1 - 8 : y2 + 24;
      return `
        <rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"
              fill="none" stroke="${color}" stroke-width="3"/>
        <rect x="${x1}" y="${textY - 20}" width="${text.length * 12}" height="26"
              fill="${color}" opacity="0.85"/>
        <text x="${x1 + 4}" y="${textY}" font-family="monospace" font-size="20"
              font-weight="bold" fill="white">${text}</text>`;
    })
    .join("");

  const camLabel = `CAM ${deviceId}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${svgBoxes}
    <rect x="0" y="0" width="${camLabel.length * 11 + 8}" height="26" fill="#000" opacity="0.65"/>
    <text x="4" y="19" font-family="monospace" font-size="16" font-weight="bold" fill="white">${camLabel}</text>
  </svg>`;

  return sharp(buffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// --- Routes ---

app.get("/health", async (c) => {
  const results = await Promise.all(
    devices.map(async (d) => ({ id: d.id, url: d.url, ok: await pingDevice(d) }))
  );
  const allOk = results.every((r) => r.ok);
  return c.json({ devices: results }, allOk ? 200 : 207);
});

app.get("/capture", async (c) => {
  const results = await Promise.all(
    devices.map(async (d) => ({ id: d.id, buf: await captureDevice(d) }))
  );
  const valid = results.filter((r): r is { id: number; buf: Buffer } => r.buf !== null);

  if (valid.length === 0) return c.json({ error: "All devices failed" }, 503);

  valid.forEach(({ id, buf }) => saveCapture(id, buf));
  const images = valid.map((r) => r.buf);

  const output = images.length === 1 ? images[0] : await stitchSideBySide(images);

  return new Response(output, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": "inline; filename=capture.jpg",
      "X-Device-Count": String(images.length),
    },
  });
});

app.get("/check", async (c) => {
  const captures = await Promise.all(
    devices.map(async (d) => {
      const buf = await captureDevice(d);
      return buf ? { id: d.id, buffer: buf } : null;
    })
  );

  const valid = captures.filter((v): v is { id: number; buffer: Buffer } => v !== null);
  if (valid.length === 0) return c.json({ error: "All devices failed" }, 503);

  valid.forEach(({ id, buffer }) => saveCapture(id, buffer));

  // Pre-resize to 640px wide before YOLO — model resizes internally anyway,
  // this cuts preprocessing time and makes annotation faster too
  const withPaths = await Promise.all(
    valid.map(async ({ id, buffer }) => {
      const small = await sharp(buffer).resize(640).jpeg({ quality: 85 }).toBuffer();
      const tmpPath = join(tmpdir(), `esp32-${id}-${randomUUID()}.jpg`);
      await Bun.write(tmpPath, small);
      return { id, small, tmpPath };
    })
  );

  // Detections are sequential through the worker (one GPU, one model)
  const detections = await Promise.all(
    withPaths.map(async ({ id, tmpPath }) => {
      let result: Detection[] = [];
      try {
        result = await yolo.detect(tmpPath);
      } catch (e) {
        console.error(`[check] CAM ${id} detection failed:`, e);
      }
      await Bun.write(tmpPath, "").catch(() => {});
      return { id, result };
    })
  );

  // Annotate all in parallel — independent of each other
  const results = await Promise.all(
    withPaths.map(async ({ id, small }, i) => {
      const image = await annotate(small, id, detections[i].result);
      return { id, image, detections: detections[i].result };
    })
  );

  const output =
    results.length === 1
      ? results[0].image
      : await stitchSideBySide(results.map((r) => r.image));

  const allDetections = Object.fromEntries(results.map(({ id, detections }) => [id, detections]));

  return new Response(output, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": "inline; filename=check.jpg",
      "X-Detections": JSON.stringify(allDetections),
    },
  });
});

export default {
  fetch: app.fetch,
  idleTimeout: 120,
};
