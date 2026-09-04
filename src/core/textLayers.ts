import { formatNumbers, resolveTextDirection, resolveTextLanguage } from './text';
import type {
  Layer,
  SegmentLayerAnimation,
  TextAlignment,
  TextDirection,
  TextFontFamily,
  TextFontStyle,
  TextFontWeight,
} from './project';

export const TEXT_MAP_ZOOM_MIN_SCALE = 0.5;
export const TEXT_MAP_ZOOM_MAX_SCALE = 3;

export const textMapZoomScale = (
  animation: SegmentLayerAnimation | undefined,
  cameraZoom: number,
): number => {
  if (!animation?.textScaleWithMapZoom) return 1;
  const referenceZoom = Math.max(0.000001, animation.textReferenceZoom ?? cameraZoom);
  const ratio = Math.max(0.000001, cameraZoom) / referenceZoom;
  return Math.max(TEXT_MAP_ZOOM_MIN_SCALE, Math.min(TEXT_MAP_ZOOM_MAX_SCALE, Math.sqrt(ratio)));
};

export const TEXT_FONT_FAMILIES: ReadonlyArray<{ id: TextFontFamily; label: string }> = [
  { id: 'inter', label: 'Inter' },
  { id: 'vazirmatn', label: 'Vazirmatn' },
];

export interface ResolvedTextStyle {
  content: string;
  lines: string[];
  direction: Exclude<TextDirection, 'auto'>;
  alignment: TextAlignment;
  fontFamily: TextFontFamily;
  cssFontFamily: string;
  fontSize: number;
  fontWeight: TextFontWeight;
  fontStyle: TextFontStyle;
  lineHeight: number;
  color: string;
}

export const resolveTextLayerStyle = (layer: Layer): ResolvedTextStyle => {
  const content = formatNumbers(layer.text ?? '', layer.numberStyle);
  const language = resolveTextLanguage(content, layer.textLanguage);
  const fontFamily = layer.fontFamily ?? (language === 'persian' ? 'vazirmatn' : 'inter');
  const direction = resolveTextDirection(content, layer.textDirection);
  return {
    content,
    lines: content.replace(/\r\n?/g, '\n').split('\n'),
    direction,
    alignment: layer.textAlign ?? 'center',
    fontFamily,
    cssFontFamily:
      fontFamily === 'vazirmatn'
        ? '"Vazirmatn Variable", "Inter Variable", sans-serif'
        : '"Inter Variable", "Vazirmatn Variable", sans-serif',
    fontSize: Math.max(6, Math.min(240, layer.fontSize ?? 32)),
    fontWeight: layer.fontWeight ?? 500,
    fontStyle: layer.fontStyle ?? 'normal',
    lineHeight: Math.max(0.8, Math.min(3, layer.lineHeight ?? 1.2)),
    color: layer.color,
  };
};

export const textLayerImageId = (layer: Layer) => {
  const style = resolveTextLayerStyle(layer);
  const signature = JSON.stringify([
    layer.id,
    style.content,
    style.direction,
    style.alignment,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStyle,
    style.lineHeight,
    style.color,
  ]);
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `mapmotion-text-${layer.id}-${(hash >>> 0).toString(16)}`;
};

export const waitForTextLayerFonts = async () => {
  if (!('fonts' in document)) return;
  await Promise.all([
    document.fonts.load('400 32px "Inter Variable"'),
    document.fonts.load('700 32px "Inter Variable"'),
    document.fonts.load('italic 400 32px "Inter Variable"'),
    document.fonts.load('400 32px "Vazirmatn Variable"'),
    document.fonts.load('700 32px "Vazirmatn Variable"'),
  ]);
};

export const rasterizeTextLayer = (layer: Layer, pixelRatio = 2) => {
  const style = resolveTextLayerStyle(layer);
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  if (!measure) throw new Error('Unable to measure Text layer.');
  measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.cssFontFamily}`;
  const widest = Math.max(
    style.fontSize,
    ...style.lines.map((line) => measure.measureText(line || ' ').width),
  );
  const logicalLineHeight = style.fontSize * style.lineHeight;
  const padding = Math.max(4, Math.ceil(style.fontSize * 0.18));
  const width = Math.max(1, Math.ceil((widest + padding * 2) * pixelRatio));
  const height = Math.max(1, Math.ceil((logicalLineHeight * style.lines.length + padding * 2) * pixelRatio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to render Text layer.');
  context.scale(pixelRatio, pixelRatio);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.cssFontFamily}`;
  context.fillStyle = style.color;
  context.textBaseline = 'middle';
  context.textAlign = style.alignment;
  context.direction = style.direction;
  const x =
    style.alignment === 'left'
      ? padding
      : style.alignment === 'right'
        ? width / pixelRatio - padding
        : width / pixelRatio / 2;
  style.lines.forEach((line, index) => {
    const y = padding + logicalLineHeight * (index + 0.5);
    context.fillText(line || ' ', x, y);
  });
  return context.getImageData(0, 0, width, height);
};
