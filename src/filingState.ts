import fs from "node:fs";
import path from "node:path";

const STATE_FILE_PATH = path.resolve(process.cwd(), "data", "state.json");

interface FilingState {
  lastSeenId: string | null;
  lastSeenAt: string | null; // ISO timestamp
}

export interface Filing {
  accessionNumber: string;
}

function readState(): FilingState {
  try {
    const raw = fs.readFileSync(STATE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FilingState>;
    if (typeof parsed.lastSeenId === "string" || parsed.lastSeenId === null) {
      const lastSeenAt =
        typeof parsed.lastSeenAt === "string" ? parsed.lastSeenAt : null;
      return { lastSeenId: parsed.lastSeenId, lastSeenAt };
    }

    console.warn(
      `[${new Date().toISOString()}] Invalid state format in ${STATE_FILE_PATH}; defaulting to empty state.`
    );
    return { lastSeenId: null, lastSeenAt: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastSeenId: null, lastSeenAt: null };
    }

    if (error instanceof SyntaxError) {
      console.warn(
        `[${new Date().toISOString()}] Corrupt JSON in ${STATE_FILE_PATH}; defaulting to empty state.`
      );
      return { lastSeenId: null, lastSeenAt: null };
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[${new Date().toISOString()}] Failed to read state file (${message}); defaulting to empty state.`
    );
    return { lastSeenId: null, lastSeenAt: null };
  }
}

export function getLastSeenId(): string | null {
  return readState().lastSeenId;
}

export function setLastSeenId(id: string): void {
  if (!id.trim()) {
    throw new Error("setLastSeenId requires a non-empty accession number.");
  }

  const state: FilingState = { lastSeenId: id, lastSeenAt: new Date().toISOString() };

  const dir = path.dirname(STATE_FILE_PATH);
  const tmp = STATE_FILE_PATH + ".tmp";

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to persist SEC filing state: ${message}`);
  }
}

export function filterNewFilings<T extends Filing>(filings: T[]): T[] {
  const { lastSeenId, lastSeenAt } = readState();
  if (!lastSeenId) {
    return filings;
  }

  const lastSeenIndex = filings.findIndex(
    (filing) => filing.accessionNumber === lastSeenId
  );

  if (lastSeenIndex === -1) {
    const ageMs = lastSeenAt
      ? Date.now() - new Date(lastSeenAt).getTime()
      : Infinity;
    if (ageMs < 60_000) {
      console.error(
        `[${new Date().toISOString()}] Cursor ${lastSeenId} not found in feed but state is recent (${Math.round(ageMs / 1000)}s old) — skipping to avoid reprocessing.`
      );
      return [];
    }
    return filings; // genuine expiry — cursor has aged out of the feed window
  }

  return filings.slice(0, lastSeenIndex);
}
