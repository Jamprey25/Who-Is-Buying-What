import fs from "node:fs";
import path from "node:path";

const STATE_FILE_PATH = path.resolve(process.cwd(), "data", "state.json");

interface FilingState {
  lastSeenId: string | null;
}

export interface Filing {
  accessionNumber: string;
}

function readState(): FilingState {
  try {
    const raw = fs.readFileSync(STATE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FilingState>;
    if (typeof parsed.lastSeenId === "string" || parsed.lastSeenId === null) {
      return { lastSeenId: parsed.lastSeenId };
    }

    console.warn(
      `[${new Date().toISOString()}] Invalid state format in ${STATE_FILE_PATH}; defaulting to empty state.`
    );
    return { lastSeenId: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastSeenId: null };
    }

    if (error instanceof SyntaxError) {
      console.warn(
        `[${new Date().toISOString()}] Corrupt JSON in ${STATE_FILE_PATH}; defaulting to empty state.`
      );
      return { lastSeenId: null };
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[${new Date().toISOString()}] Failed to read state file (${message}); defaulting to empty state.`
    );
    return { lastSeenId: null };
  }
}

export function getLastSeenId(): string | null {
  return readState().lastSeenId;
}

export function setLastSeenId(id: string): void {
  if (!id.trim()) {
    throw new Error("setLastSeenId requires a non-empty accession number.");
  }

  const state: FilingState = { lastSeenId: id };

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

export function filterNewFilings(filings: Filing[]): Filing[] {
  const lastSeenId = getLastSeenId();
  if (!lastSeenId) {
    return filings;
  }

  const lastSeenIndex = filings.findIndex(
    (filing) => filing.accessionNumber === lastSeenId
  );

  if (lastSeenIndex === -1) {
    return filings;
  }

  return filings.slice(0, lastSeenIndex);
}
