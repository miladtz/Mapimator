/**
 * App-level reusable vehicle image catalog.
 *
 * Tauri's WebView localStorage is stored in the application's user-data
 * profile, outside projects and the repository. Applying an entry always
 * ingests a content-addressed copy into the current Project asset store, so
 * portable projects never depend on this catalog.
 */
export interface VehicleStyleEntry {
  id: string;
  name: string;
  imageDataUrl: string;
  filename: string;
  createdAt: number;
}

const STORAGE_KEY = 'mapmotion-vehicle-style-library';
const SUPPORTED_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/;

const readLibrary = (): VehicleStyleEntry[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is VehicleStyleEntry =>
        typeof entry?.id === 'string' &&
        typeof entry?.name === 'string' &&
        typeof entry?.filename === 'string' &&
        typeof entry?.imageDataUrl === 'string' &&
        SUPPORTED_DATA_URL.test(entry.imageDataUrl) &&
        Number.isFinite(entry?.createdAt),
    );
  } catch {
    return [];
  }
};

const writeLibrary = (entries: VehicleStyleEntry[]) =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));

export const getVehicleStyles = () => readLibrary();

export const saveVehicleStyle = (name: string, imageDataUrl: string, filename: string): VehicleStyleEntry => {
  if (!SUPPORTED_DATA_URL.test(imageDataUrl)) throw new Error('Vehicle image must be PNG, JPEG, or WebP.');
  const entry = {
    id: `vehicle-style-${crypto.randomUUID()}`,
    name: name.trim() || 'My Vehicle',
    imageDataUrl,
    filename,
    createdAt: Date.now(),
  };
  writeLibrary([...readLibrary(), entry]);
  return entry;
};

export const renameVehicleStyle = (id: string, name: string) =>
  writeLibrary(
    readLibrary().map((entry) => (entry.id === id ? { ...entry, name: name.trim() || entry.name } : entry)),
  );

export const deleteVehicleStyle = (id: string) =>
  writeLibrary(readLibrary().filter((entry) => entry.id !== id));
