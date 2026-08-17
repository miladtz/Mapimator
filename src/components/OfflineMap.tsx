import React, { useMemo, useRef, type PointerEvent, type WheelEvent } from 'react';
import type { CameraState, Layer, MapStylePreset, Project } from '../core/project';
import { formatNumbers, resolveTextDirection, resolveTextLanguage } from '../core/text';
import { COUNTRIES, PERSIAN_COUNTRY_NAMES } from '../data/countries';

interface Props {
  style: MapStylePreset;
  layers: Layer[];
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  labelLanguage: Project['mapSettings']['labelLanguage'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveLayer: (id: string, x: number, y: number) => void;
  safeArea: number;
  showSafeArea: boolean;
}
export function OfflineMap({
  style,
  layers,
  camera,
  onCameraChange,
  labelLanguage,
  selectedId,
  onSelect,
  onMoveLayer,
  safeArea,
  showSafeArea,
}: Props) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const moving = useRef<string | null>(null);
  const transform = useMemo(() => `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`, [camera]);
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (moving.current) return;
    drag.current = { x: event.clientX - camera.x, y: event.clientY - camera.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (moving.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      onMoveLayer(
        moving.current,
        ((event.clientX - rect.left) / rect.width) * 1000,
        ((event.clientY - rect.top) / rect.height) * 560,
      );
    } else if (drag.current)
      onCameraChange({ ...camera, x: event.clientX - drag.current.x, y: event.clientY - drag.current.y });
  };
  const end = () => {
    drag.current = null;
    moving.current = null;
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    onCameraChange({
      ...camera,
      zoom: Math.max(0.72, Math.min(3.4, camera.zoom * (event.deltaY > 0 ? 0.89 : 1.12))),
    });
  };
  const beginLayerMove = (event: PointerEvent<SVGGElement>, layer: Layer) => {
    if (layer.locked) return;
    event.stopPropagation();
    moving.current = layer.id;
    onSelect(layer.id);
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  };
  return (
    <svg
      className="offline-map"
      viewBox="0 0 1000 560"
      role="img"
      aria-label="Offline political map"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerLeave={end}
      onWheel={onWheel}
      style={{ background: style.waterColor }}
    >
      <defs>
        <pattern id="grid" width="70" height="70" patternUnits="userSpaceOnUse">
          <path
            d="M 70 0 L 0 0 0 70"
            fill="none"
            stroke={style.countryBorderColor}
            strokeOpacity=".12"
            strokeWidth=".6"
          />
        </pattern>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8Z" fill="context-stroke" />
        </marker>
      </defs>
      <rect width="1000" height="560" fill="url(#grid)" onClick={() => onSelect(null)} />
      {showSafeArea && (
        <rect
          className="safe-area-guide"
          x={safeArea / 2}
          y={safeArea / 2}
          width={1000 - safeArea}
          height={560 - safeArea}
        />
      )}
      <g transform={transform}>
        {COUNTRIES.map((c) => (
          <path
            key={c.id}
            d={c.path}
            fill={style.landColor}
            stroke={style.countryBorderColor}
            strokeWidth={style.countryBorderWidth}
            vectorEffect="non-scaling-stroke"
            className="country"
          />
        ))}
        {labelLanguage !== 'none' &&
          COUNTRIES.map((c) => (
            <CountryLabel
              key={`${c.id}-label`}
              country={c}
              language={labelLanguage}
              color={style.countryLabelColor}
            />
          ))}
        {layers
          .filter((l) => l.visible)
          .map((layer) => (
            <LayerGraphic
              key={layer.id}
              layer={layer}
              selected={layer.id === selectedId}
              onPointerDown={(event) => beginLayerMove(event, layer)}
            />
          ))}
      </g>
      <text x="26" y="526" fill={style.countryLabelColor} opacity=".52" className="map-credit">
        MAPMOTION OFFLINE STARTER DATA · v0.1
      </text>
    </svg>
  );
}
function CountryLabel({
  country,
  language,
  color,
}: {
  country: (typeof COUNTRIES)[number];
  language: Project['mapSettings']['labelLanguage'];
  color: string;
}) {
  const fa = PERSIAN_COUNTRY_NAMES[country.id] ?? country.name;
  return (
    <text
      x={country.label[0]}
      y={country.label[1]}
      fill={color}
      className="country-label"
      textAnchor="middle"
    >
      {language === 'en' && country.name}
      {language === 'fa' && (
        <tspan direction="rtl" unicodeBidi="plaintext">
          {fa}
        </tspan>
      )}
      {language === 'both' && (
        <>
          <tspan x={country.label[0]} dy="-4" direction="rtl" unicodeBidi="plaintext">
            {fa}
          </tspan>
          <tspan x={country.label[0]} dy="9">
            {country.name}
          </tspan>
        </>
      )}
    </text>
  );
}
function LayerGraphic({
  layer,
  selected,
  onPointerDown,
}: {
  layer: Layer;
  selected: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
}) {
  const common = {
    opacity: layer.opacity,
    onPointerDown,
    className: `layer-graphic ${selected ? 'selected-layer' : ''}`,
  };
  if (layer.type === 'region') {
    const country = COUNTRIES.find((c) => c.id === layer.countryId);
    return country ? (
      <g {...common}>
        <path d={country.path} fill={layer.color} fillOpacity=".45" stroke={layer.color} strokeWidth="3" />
        <text x={layer.x} y={layer.y + 28} fill={layer.color} textAnchor="middle" className="layer-caption">
          {layer.name}
        </text>
      </g>
    ) : null;
  }
  if (layer.type === 'pin')
    return (
      <g {...common}>
        <circle cx={layer.x} cy={layer.y} r="13" fill={layer.color} stroke="#fff" strokeWidth="3" />
        <circle cx={layer.x} cy={layer.y} r="4" fill="#17202d" />
        <text
          x={layer.x + 18}
          y={layer.y + 4}
          fill="#fff"
          className="layer-text"
          direction={resolveTextDirection(layer.text ?? '', layer.textDirection)}
          unicodeBidi="plaintext"
        >
          {formatNumbers(layer.text ?? '', layer.numberStyle)}
        </text>
      </g>
    );
  if (layer.type === 'text') {
    const text = formatNumbers(layer.text ?? '', layer.numberStyle);
    const isPersian = resolveTextLanguage(text, layer.textLanguage) === 'persian';
    return (
      <g {...common}>
        <text
          x={layer.x}
          y={layer.y}
          fill={layer.color}
          className={`headline ${isPersian ? 'persian-text' : ''}`}
          style={{ fontSize: layer.fontSize }}
          textAnchor="middle"
          direction={resolveTextDirection(text, layer.textDirection)}
          unicodeBidi="plaintext"
        >
          {text}
        </text>
      </g>
    );
  }
  if (layer.type === 'shape' || layer.type === 'image')
    return (
      <g {...common}>
        <rect
          x={layer.x}
          y={layer.y}
          width={layer.width}
          height={layer.height}
          rx="3"
          fill={layer.type === 'image' ? '#24364c' : layer.color}
          fillOpacity={layer.type === 'image' ? '.9' : '.25'}
          stroke={layer.color}
          strokeWidth="2"
        />
        <text
          x={layer.x + (layer.width ?? 0) / 2}
          y={layer.y + (layer.height ?? 0) / 2 + 4}
          textAnchor="middle"
          fill={layer.color}
          className="layer-caption"
        >
          {layer.type === 'image' ? 'IMAGE' : 'CALLOUT'}
        </text>
      </g>
    );
  if (layer.type === 'geo-effect') return <GeoEffect layer={layer} common={common} />;
  const dash = layer.type === 'route' ? '8 6' : undefined;
  return (
    <g {...common}>
      <line
        x1={layer.x}
        y1={layer.y}
        x2={layer.x2}
        y2={layer.y2}
        stroke={layer.color}
        strokeWidth={layer.type === 'arrow' ? 6 : 3}
        strokeDasharray={dash}
        markerEnd="url(#arrowhead)"
      />
      <circle cx={layer.x} cy={layer.y} r="4" fill={layer.color} />
    </g>
  );
}
function GeoEffect({
  layer,
  common,
}: {
  layer: Layer;
  common: { opacity: number; onPointerDown: (event: PointerEvent<SVGGElement>) => void; className: string };
}) {
  const size = layer.effectSize ?? 44;
  const duration = `${layer.effectDuration ?? 1.4}s`;
  const repeat = layer.effectRepeat === false ? 1 : 'indefinite';
  const type = layer.geoEffectType ?? 'impact-pulse';
  if (type === 'strike-marker')
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <circle
          cx={layer.x}
          cy={layer.y}
          r={size / 2}
          fill={layer.color}
          opacity=".14"
          className="effect-strike-ring"
        />
        <path
          d={`M ${layer.x} ${layer.y - size / 2} L ${layer.x + size / 7} ${layer.y - size / 7} L ${layer.x + size / 2} ${layer.y} L ${layer.x + size / 7} ${layer.y + size / 7} L ${layer.x} ${layer.y + size / 2} L ${layer.x - size / 7} ${layer.y + size / 7} L ${layer.x - size / 2} ${layer.y} L ${layer.x - size / 7} ${layer.y - size / 7} Z`}
          fill={layer.color}
          className="effect-strike"
        />
      </g>
    );
  if (type === 'smoke-plume')
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        {[0, 0.18, 0.36].map((delay, index) => (
          <circle
            key={index}
            cx={layer.x + index * size * 0.14}
            cy={layer.y - index * size * 0.19}
            r={size * (0.18 + index * 0.06)}
            fill={layer.color}
            opacity=".35"
            className="effect-smoke"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </g>
    );
  if (type === 'front-line' || type === 'blockade-line' || type === 'disputed-border') {
    const x2 = layer.x2 ?? layer.x + size * 3;
    const y2 = layer.y2 ?? layer.y;
    const dash = type === 'front-line' ? '12 5' : type === 'blockade-line' ? '3 7' : '2 5';
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <line
          x1={layer.x}
          y1={layer.y}
          x2={x2}
          y2={y2}
          stroke={layer.color}
          strokeWidth={type === 'front-line' ? 5 : 3}
          strokeDasharray={dash}
          className="effect-arc"
        />
        {type === 'front-line' && (
          <>
            {[0.18, 0.5, 0.82].map((t) => (
              <path
                key={t}
                d={`M ${layer.x + (x2 - layer.x) * t} ${layer.y + (y2 - layer.y) * t - 7} l 5 7 l -5 7`}
                fill="none"
                stroke={layer.color}
                strokeWidth="2"
              />
            ))}
          </>
        )}
      </g>
    );
  }
  if (type === 'territory-expansion' || type === 'control-zone' || type === 'influence-zone') {
    const radius = type === 'territory-expansion' ? size * 0.85 : size * 1.15;
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <circle
          cx={layer.x}
          cy={layer.y}
          r={radius}
          fill={layer.color}
          opacity={type === 'control-zone' ? '.22' : '.13'}
          className="effect-pulse"
        />
        <circle
          cx={layer.x}
          cy={layer.y}
          r={radius}
          fill="none"
          stroke={layer.color}
          strokeWidth="2"
          strokeDasharray={type === 'influence-zone' ? '5 5' : undefined}
        />
      </g>
    );
  }
  if (type === 'hotspot')
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <circle cx={layer.x} cy={layer.y} r={size * 0.18} fill={layer.color} />
        <circle
          cx={layer.x}
          cy={layer.y}
          r={size * 0.65}
          fill="none"
          stroke={layer.color}
          strokeWidth="2"
          className="effect-pulse"
        />
      </g>
    );
  if (type === 'refugee-flow') {
    const x2 = layer.x2 ?? layer.x + size * 3;
    const y2 = layer.y2 ?? layer.y + size * 0.8;
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <path
          d={`M ${layer.x} ${layer.y} Q ${(layer.x + x2) / 2} ${layer.y - size * 0.45} ${x2} ${y2}`}
          fill="none"
          stroke={layer.color}
          strokeWidth="3"
          strokeDasharray="8 6"
          className="effect-arc"
          markerEnd="url(#arrowhead)"
        />
        {[0.2, 0.45, 0.7].map((t) => (
          <circle
            key={t}
            cx={layer.x + (x2 - layer.x) * t}
            cy={layer.y + (y2 - layer.y) * t - size * 0.2 * Math.sin(Math.PI * t)}
            r="3"
            fill={layer.color}
          />
        ))}
      </g>
    );
  }
  if (type === 'missile-arc') {
    const x2 = layer.x2 ?? layer.x + size * 2.8;
    const y2 = layer.y2 ?? layer.y - size;
    const cx = (layer.x + x2) / 2;
    const cy = Math.min(layer.y, y2) - size;
    return (
      <g
        {...common}
        className={`${common.className} geo-effect`}
        style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
      >
        <path
          d={`M ${layer.x} ${layer.y} Q ${cx} ${cy} ${x2} ${y2}`}
          fill="none"
          stroke={layer.color}
          strokeWidth="2.5"
          strokeDasharray="7 5"
          className="effect-arc"
        />
        <circle cx={x2} cy={y2} r={size * 0.13} fill={layer.color} className="effect-impact" />
      </g>
    );
  }
  return (
    <g
      {...common}
      className={`${common.className} geo-effect`}
      style={{ '--effect-duration': duration, '--effect-repeat': repeat } as React.CSSProperties}
    >
      <circle cx={layer.x} cy={layer.y} r={size * 0.14} fill={layer.color} />
      <circle
        cx={layer.x}
        cy={layer.y}
        r={size * 0.42}
        fill="none"
        stroke={layer.color}
        strokeWidth="2.5"
        className="effect-pulse"
      />
      <circle
        cx={layer.x}
        cy={layer.y}
        r={size * 0.7}
        fill="none"
        stroke={layer.color}
        strokeWidth="1.5"
        className="effect-pulse effect-pulse-late"
      />
    </g>
  );
}
