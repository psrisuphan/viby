// Copyright (c) 2026 Bukutsu
// SPDX-License-Identifier: GPL-3.0-only

const DB_NAME = "glacier-eq-online";
const DB_VERSION = 1;
const STORE_NAME = "curves";
const MAX_DATABASE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface OnlineDevice {
  id: string;
  brand: string;
  name: string;
  price: number | null;
  source: string;
}

interface CurveDatabase {
  meta: { frequencies: number[] };
  curves: Record<string, { d: number[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export function parseCurveDatabase(value: unknown): CurveDatabase {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.curves)) {
    throw new Error("Invalid database format: missing meta or curves");
  }

  if (!isFiniteNumberArray(value.meta.frequencies)) {
    throw new Error("Invalid database format: frequencies are missing or invalid");
  }

  const curves: Record<string, { d: number[] }> = {};
  for (const [key, curve] of Object.entries(value.curves)) {
    if (!isRecord(curve) || !isFiniteNumberArray(curve.d)) continue;
    curves[key] = { d: curve.d };
  }
  if (Object.keys(curves).length === 0) {
    throw new Error("Invalid database format: no valid curves found");
  }

  return { meta: { frequencies: value.meta.frequencies }, curves };
}

export function parseManifestData(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.iems)) {
    throw new Error("Invalid database manifest: missing measurements");
  }
  return value;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function isDatabaseDownloaded(): Promise<boolean> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    return (await idbRequest(store.count())) > 10;
  } catch {
    return false;
  }
}

export async function clearCachedDatabase(): Promise<void> {
  const db = await openDb();
  const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  await idbRequest(store.clear());
}

export async function downloadDatabase(
  onProgress: (percent: number) => void,
): Promise<number> {
  const [rawData, rawManifest] = await Promise.all([
    fetchJson("https://raw.githubusercontent.com/PEQHUB/Squig-Rank/main/public/data/curves.json", onProgress),
    fetchJson("https://raw.githubusercontent.com/PEQHUB/Squig-Rank/main/public/data/manifest.json"),
  ]);
  const data = parseCurveDatabase(rawData);
  const manifest = parseManifestData(rawManifest);

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    // Save frequencies
    store.put(data.meta.frequencies, "meta:frequencies");
    store.put(manifest, "meta:manifest");

    // Save each curve
    let count = 0;
    for (const [key, curve] of Object.entries(data.curves)) {
      store.put(curve.d, key);
      count++;
    }

    transaction.oncomplete = () => {
      onProgress(1.0);
      resolve(count);
    };
    transaction.onerror = () => {
      reject(transaction.error);
    };
  });
}

async function fetchJson(url: string, onProgress?: (percent: number) => void): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch database: ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    if (totalBytes > MAX_DATABASE_BYTES) {
      throw new Error("Database download exceeds the 50 MB limit");
    }
    const text = await readBoundedResponse(response, MAX_DATABASE_BYTES, (loadedBytes) => {
      if (onProgress && totalBytes > 0) {
        onProgress(Math.min(0.99, loadedBytes / totalBytes));
      }
    });

    onProgress?.(0.99); // Parsing JSON next
    return JSON.parse(text);
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  onChunk?: (loadedBytes: number) => void,
): Promise<string> {
  let loadedBytes = 0;
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        loadedBytes += value.length;
        if (loadedBytes > maxBytes) {
          await reader.cancel();
          throw new Error("Database download exceeds the 50 MB limit");
        }
        chunks.push(value);
        onChunk?.(loadedBytes);
      }
    }

    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error("Database download exceeds the 50 MB limit");
  }
  return text;
}

export async function fetchManifest(): Promise<OnlineDevice[]> {
  const db = await openDb();
  const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
  const data = await idbRequest<unknown>(store.get("meta:manifest"));

  if (!isRecord(data) || !isRecord(data.iems)) {
    throw new Error("Search manifest not cached. Please download the database.");
  }

  const devices: OnlineDevice[] = [];
  for (const [key, details] of Object.entries(data.iems)) {
    const parts = key.split("::");
    if (parts.length < 2) continue;
    const source = parts[0];
    const fullName = parts[1];

    let brand = source;
    let name = fullName;
    const firstSpace = fullName.indexOf(" ");
    if (firstSpace > 0) {
      brand = fullName.substring(0, firstSpace);
      name = fullName.substring(firstSpace + 1);
    }

    const price =
      isRecord(details) &&
      typeof details.price === "number" &&
      Number.isFinite(details.price)
        ? details.price
        : null;

    devices.push({
      id: key,
      brand,
      name,
      price,
      source,
    });
  }

  return devices.sort((a, b) =>
    `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`),
  );
}

export async function loadDeviceCurvePoints(
  deviceId: string,
): Promise<[number, number][]> {
  const db = await openDb();

  const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
  const [rawFrequencies, rawDbValues] = await Promise.all([
    idbRequest<unknown>(store.get("meta:frequencies")),
    idbRequest<unknown>(store.get(deviceId)),
  ]);
  const frequencies = isFiniteNumberArray(rawFrequencies) ? rawFrequencies : [];
  const dbValues = isFiniteNumberArray(rawDbValues) ? rawDbValues : [];

  if (frequencies.length === 0 || dbValues.length === 0) {
    throw new Error(
      "Curve not found in local cache. Please download the database.",
    );
  }

  const points: [number, number][] = [];
  for (let i = 0; i < Math.min(frequencies.length, dbValues.length); i++) {
    points.push([frequencies[i], dbValues[i]]);
  }

  return points;
}
