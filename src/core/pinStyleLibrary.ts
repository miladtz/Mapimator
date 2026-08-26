/**
 * App-level reusable Pin Style Library.
 *
 * Stored in localStorage (persists across app restarts and project switches).
 * Images are stored as data URLs for simplicity. When a style is applied to
 * a Pin inside a project, the image is ingested into the project's asset
 * storage via the existing Tauri command, ensuring project portability.
 */

export interface PinStyleEntry {
  id: string;
  name: string;
  /** Data URL of the custom icon image. */
  imageDataUrl: string;
  /** Default anchor when this style is applied. */
  anchor: 'bottom-center' | 'center';
  /** Default pin size when this style is applied. */
  defaultSize: number;
  /** Original filename for reference. */
  filename: string;
  /** Timestamp for ordering. */
  createdAt: number;
}

const STORAGE_KEY = 'mapmotion-pin-style-library';

function readLibrary(): PinStyleEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLibrary(styles: PinStyleEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
}

/** Get all saved pin styles. */
export function getPinStyles(): PinStyleEntry[] {
  return readLibrary();
}

/** Save a new pin style. Returns the created entry. */
export function savePinStyle(
  name: string,
  imageDataUrl: string,
  filename: string,
  anchor: 'bottom-center' | 'center' = 'bottom-center',
  defaultSize: number = 15,
): PinStyleEntry {
  const entry: PinStyleEntry = {
    id: `style-${crypto.randomUUID()}`,
    name,
    imageDataUrl,
    anchor,
    defaultSize,
    filename,
    createdAt: Date.now(),
  };
  const styles = readLibrary();
  styles.push(entry);
  writeLibrary(styles);
  return entry;
}

/** Rename a pin style. */
export function renamePinStyle(id: string, newName: string): void {
  const styles = readLibrary();
  const style = styles.find((s) => s.id === id);
  if (style) {
    style.name = newName;
    writeLibrary(styles);
  }
}

/** Delete a pin style. */
export function deletePinStyle(id: string): void {
  const styles = readLibrary().filter((s) => s.id !== id);
  writeLibrary(styles);
}

/** Get a pin style by ID. */
export function getPinStyleById(id: string): PinStyleEntry | undefined {
  return readLibrary().find((s) => s.id === id);
}
