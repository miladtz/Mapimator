export type AppLanguage = 'en' | 'fa';
export type MapStyleId = 'documentary-dark' | 'documentary-light';
export type LayerType = 'region' | 'pin' | 'text' | 'shape' | 'arrow' | 'image' | 'route';
export type TextLanguage = 'auto' | 'persian' | 'english';
export type TextDirection = 'auto' | 'rtl' | 'ltr';
export type NumberStyle = 'persian' | 'english';

export interface MapStylePreset { id: MapStyleId; name: string; landColor: string; waterColor: string; countryBorderColor: string; countryBorderWidth: number; countryLabelColor: string; backgroundColor: string; }
export interface Layer {
  id: string; type: LayerType; name: string; visible: boolean; locked: boolean; opacity: number; color: string;
  x: number; y: number; x2?: number; y2?: number; text?: string; countryId?: string; width?: number; height?: number;
  textLanguage?: TextLanguage; textDirection?: TextDirection; numberStyle?: NumberStyle; fontSize?: number;
}
export interface CameraState { x: number; y: number; zoom: number; }
export interface View { id: string; name: string; holdDuration: number; transitionDuration: number; transitionPreset: 'smooth' | 'cinematic' | 'linear'; camera: CameraState; layers: Layer[]; thumbnailColor: string; }
export interface Project {
  version: 1; metadata: { name: string; createdAt: string; updatedAt: string };
  canvas: { width: number; height: number; fps: 24 | 25 | 30 | 50 | 60 };
  mapSettings: { styleId: MapStyleId; labelLanguage: 'en' | 'fa' | 'both' | 'none' };
  layers: Layer[]; views: View[]; assets: unknown[]; animation: Record<string, never>; exportSettings: Record<string, never>;
}

export const MAP_STYLES: MapStylePreset[] = [
  { id: 'documentary-dark', name: 'Documentary Dark', landColor: '#27364b', waterColor: '#0b1322', countryBorderColor: '#87a4c3', countryBorderWidth: 1.2, countryLabelColor: '#e7eff9', backgroundColor: '#101a2a' },
  { id: 'documentary-light', name: 'Documentary Light', landColor: '#dfe8ec', waterColor: '#b7d6df', countryBorderColor: '#537282', countryBorderWidth: 1.1, countryLabelColor: '#183246', backgroundColor: '#edf3f5' }
];
export const layerLabel: Record<LayerType, string> = { region: 'Region', pin: 'Pin', text: 'Text', shape: 'Shape', arrow: 'Arrow', image: 'Image', route: 'Route' };
export const createLayer = (type: LayerType, offset = 0): Layer => {
  const id = `${type}-${crypto.randomUUID()}`; const x = 540 + offset * 18; const y = 260 + offset * 15;
  const defaults: Record<LayerType, Partial<Layer>> = {
    region: { name: 'Iran highlight', color: '#e8533e', countryId: 'iran', x: 650, y: 292 }, pin: { name: 'Capital pin', color: '#f3b43f', text: 'Tehran' },
    text: { name: 'Map headline', color: '#ffffff', text: 'A NEW CHAPTER', x: 500, y: 110, textLanguage: 'auto', textDirection: 'auto', numberStyle: 'english', fontSize: 19 }, shape: { name: 'Callout shape', color: '#61c4e8', width: 100, height: 55 },
    arrow: { name: 'Advance arrow', color: '#ef694f', x: 560, y: 300, x2: 700, y2: 270 }, image: { name: 'Image placeholder', color: '#7d9bbb', width: 118, height: 72 },
    route: { name: 'Route', color: '#64d5ba', x: 485, y: 275, x2: 675, y2: 325 }
  };
  return { id, type, visible: true, locked: false, opacity: 1, color: '#ffffff', x, y, ...defaults[type] } as Layer;
};
export const createProject = (name = 'Untitled map'): Project => { const now = new Date().toISOString(); return { version: 1, metadata: { name, createdAt: now, updatedAt: now }, canvas: { width: 1920, height: 1080, fps: 30 }, mapSettings: { styleId: 'documentary-dark', labelLanguage: 'en' }, layers: [], views: [], assets: [], animation: {}, exportSettings: {} }; };
export const createView = (name: string, layers: Layer[], camera: CameraState): View => ({ id: `view-${crypto.randomUUID()}`, name, holdDuration: 3, transitionDuration: 2.5, transitionPreset: 'smooth', camera: { ...camera }, layers: structuredClone(layers), thumbnailColor: '#28415a' });
