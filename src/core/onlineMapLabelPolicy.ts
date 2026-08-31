import type { MapLabelLanguageMode } from './project';

export type MapLibreTextField = string | unknown[];

export type OnlineMapLabelLayerClass =
  'textLabel' | 'placeMarker' | 'routeShield' | 'labelCompanionIcon' | 'nonLabelCartography';

export type OnlineMapStyleLayer = {
  id: string;
  type: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
  filter?: unknown;
  metadata?: unknown;
};

export const ONLINE_ENGLISH_NAME_PROPERTIES = ['name:en', 'name:latin'] as const;

/**
 * `name_en` is intentionally excluded. OpenFreeMap 3.16 derives it with the
 * local name when a translation is missing (confirmed in the Qeshm z14
 * tiles), so it is not a trustworthy English property.
 */
export const buildEnglishTextExpression = (): unknown[] => [
  'coalesce',
  ...ONLINE_ENGLISH_NAME_PROPERTIES.map((property) => ['get', property]),
  '',
];

export const ONLINE_ENGLISH_NAME_EXPRESSION: unknown[] = buildEnglishTextExpression();

export const ONLINE_PERSIAN_NAME_EXPRESSION: unknown[] = [
  'coalesce',
  ['get', 'name:fa'],
  ['get', 'name'],
  ['get', 'name:nonlatin'],
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name:latin'],
  '',
];

export const ONLINE_BILINGUAL_NAME_EXPRESSION: unknown[] = [
  'let',
  'fa',
  ONLINE_PERSIAN_NAME_EXPRESSION,
  'en',
  ONLINE_ENGLISH_NAME_EXPRESSION,
  [
    'case',
    ['all', ['!=', ['var', 'fa'], ''], ['!=', ['var', 'en'], ''], ['!=', ['var', 'fa'], ['var', 'en']]],
    ['concat', ['var', 'fa'], '\n', ['var', 'en']],
    ['!=', ['var', 'fa'], ''],
    ['var', 'fa'],
    ['var', 'en'],
  ],
];

export const referencesOnlineNameProperty = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  if ((value[0] === 'get' || value[0] === 'has') && typeof value[1] === 'string')
    return value[1] === 'name' || value[1] === 'name_en' || value[1].startsWith('name:');
  return value.some(referencesOnlineNameProperty);
};

export const isBlockedEnglishNameProperty = (property: string): boolean =>
  property === 'name' ||
  property === 'name_en' ||
  (property.startsWith('name:') &&
    !ONLINE_ENGLISH_NAME_PROPERTIES.includes(property as (typeof ONLINE_ENGLISH_NAME_PROPERTIES)[number]));

export const blockedEnglishNameProperties = (value: unknown): string[] => {
  const blocked = new Set<string>();
  const visit = (candidate: unknown) => {
    if (!Array.isArray(candidate)) return;
    if (
      (candidate[0] === 'get' || candidate[0] === 'has') &&
      typeof candidate[1] === 'string' &&
      isBlockedEnglishNameProperty(candidate[1])
    )
      blocked.add(candidate[1]);
    candidate.forEach(visit);
  };
  visit(value);
  return [...blocked].sort();
};

const searchableLayerDescription = (layer: OnlineMapStyleLayer): string =>
  [layer.id, layer['source-layer'], JSON.stringify(layer.filter), JSON.stringify(layer.metadata)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

/**
 * Classifies OpenFreeMap annotation presentation independently from any one
 * style's layer IDs. Explicit ID terms complement source/layout semantics for
 * Liberty, Bright, Dark, and future compatible style revisions.
 */
export const classifyOnlineMapLabelLayer = (layer: OnlineMapStyleLayer): OnlineMapLabelLayerClass => {
  const layout = layer.layout ?? {};
  const textField = layout['text-field'];
  const iconImage = layout['icon-image'];
  const iconTextFit = layout['icon-text-fit'];
  const description = searchableLayerDescription(layer);
  const isRouteShield =
    layer.type === 'symbol' &&
    (iconTextFit !== undefined ||
      (/\b(shield|route[-_ ]?ref|road[-_ ]?ref)\b/.test(description) && iconImage !== undefined) ||
      (layer['source-layer'] === 'transportation_name' &&
        iconImage !== undefined &&
        JSON.stringify(textField).includes('ref')));
  if (isRouteShield) return 'routeShield';

  const isPlaceMarker =
    (layer.type === 'circle' &&
      (layer['source-layer'] === 'place' ||
        /\b(place|city|town|village|capital|settlement)\b/.test(description))) ||
    (layer.type === 'symbol' &&
      layer['source-layer'] === 'place' &&
      iconImage !== undefined &&
      textField !== undefined);
  if (isPlaceMarker) return 'placeMarker';

  if (
    layer.type === 'symbol' &&
    iconImage !== undefined &&
    textField === undefined &&
    /\b(label|marker|shield|route[-_ ]?ref)\b/.test(description)
  )
    return 'labelCompanionIcon';
  if (layer.type === 'symbol' && textField !== undefined) return 'textLabel';
  return 'nonLabelCartography';
};

export const shouldHideOnlineMapLayer = (layer: OnlineMapStyleLayer, mode: MapLabelLanguageMode): boolean => {
  if (mode !== 'none') return false;
  const classification = classifyOnlineMapLabelLayer(layer);
  return (
    classification === 'placeMarker' ||
    classification === 'routeShield' ||
    classification === 'labelCompanionIcon'
  );
};

export const mapLabelTextField = (
  original: MapLibreTextField,
  mode: MapLabelLanguageMode,
): MapLibreTextField => {
  if (mode === 'none') return '';
  // Route refs, house numbers, and other non-name text retain the style's
  // original expression in language modes, including any icon/shield pairing.
  if (!referencesOnlineNameProperty(original)) return original;
  if (mode === 'fa') return ONLINE_PERSIAN_NAME_EXPRESSION;
  if (mode === 'both') return ONLINE_BILINGUAL_NAME_EXPRESSION;
  return buildEnglishTextExpression();
};
