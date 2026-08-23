import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type SVGProps,
} from 'react';
import {
  applyEdgeResistance,
  CAMERA_SETTINGS,
  CAMERA_VIEWPORT,
  clamp,
  constrainCamera,
  fitWorldCamera,
  roundCamera,
  zoomAtPoint,
} from '../core/camera';
import type { CameraState, Layer, MapStylePreset, Project } from '../core/project';
import { selectMapLabels } from '../core/mapLabels';
import { formatNumbers, resolveTextDirection, resolveTextLanguage } from '../core/text';
import {
  COASTLINE_PATH,
  COUNTRIES,
  COUNTRY_BORDER_PATH,
  findCountry,
  LAKE_PATH,
  RIVER_PATHS,
  WORLD_MAP_DATASET,
  type MapLabel,
} from '../data/worldMap';

interface Props {
  style: MapStylePreset;
  mapMode: MapMode;
  layers: Layer[];
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  interactionEnabled?: boolean;
  labelLanguage: Project['mapSettings']['labelLanguage'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveLayer: (id: string, x: number, y: number) => void;
  safeArea: number;
  showSafeArea: boolean;
  assetUrls?: Readonly<Record<string, string>>;
}

export type MapMode = 'flat' | 'globe';

export interface MapSceneProps {
  style: MapStylePreset;
  mapMode?: MapMode;
  layers: Layer[];
  camera: CameraState;
  labelLanguage: Project['mapSettings']['labelLanguage'];
  width?: number | string;
  height?: number | string;
  viewBox?: string;
  selectedId?: string | null;
  safeArea?: number;
  showSafeArea?: boolean;
  svgProps?: SVGProps<SVGSVGElement>;
  onBackgroundClick?: () => void;
  onLayerPointerDown?: (event: PointerEvent<SVGGElement>, layer: Layer) => void;
  assetUrls?: Readonly<Record<string, string>>;
  globeRotation?: GlobeRotation;
}

interface GlobeRotation {
  lon: number;
  lat: number;
}
export function OfflineMap({
  style,
  mapMode,
  layers,
  camera,
  onCameraChange,
  interactionEnabled = true,
  labelLanguage,
  selectedId,
  onSelect,
  onMoveLayer,
  safeArea,
  showSafeArea,
  assetUrls,
}: Props) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const lastPan = useRef<{ x: number; y: number; time: number } | null>(null);
  const velocity = useRef({ x: 0, y: 0 });
  const globeRotation = useRef<GlobeRotation>({ lon: 0, lat: 0 });
  const globeVelocity = useRef({ lon: 0, lat: 0 });
  const animation = useRef<number | null>(null);
  const globeAnimation = useRef<number | null>(null);
  const targetCamera = useRef(constrainCamera(camera));
  const currentCamera = useRef(constrainCamera(camera));
  const spacePan = useRef(false);
  const moving = useRef<string | null>(null);
  const activePointerId = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const onCameraChangeRef = useRef(onCameraChange);
  const interactionEnabledRef = useRef(interactionEnabled);
  const mapModeRef = useRef(mapMode);
  interactionEnabledRef.current = interactionEnabled;
  mapModeRef.current = mapMode;
  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);
  const emitCameraChange = useCallback((next: CameraState) => {
    onCameraChangeRef.current(next);
  }, []);
  const cancelCameraFrames = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    if (globeAnimation.current !== null) cancelAnimationFrame(globeAnimation.current);
    animation.current = null;
    globeAnimation.current = null;
  }, []);
  const cancelActiveCameraInteraction = useCallback(() => {
    cancelCameraFrames();
    const svg = svgRef.current;
    const pointerId = activePointerId.current;
    activePointerId.current = null;
    if (svg && pointerId !== null && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    drag.current = null;
    lastPan.current = null;
    moving.current = null;
    spacePan.current = false;
    velocity.current = { x: 0, y: 0 };
    globeVelocity.current = { lon: 0, lat: 0 };
    currentCamera.current = constrainCamera(currentCamera.current);
    targetCamera.current = currentCamera.current;
  }, [cancelCameraFrames]);
  useEffect(() => {
    if (animation.current || globeAnimation.current) return;
    currentCamera.current = constrainCamera(camera);
    targetCamera.current = currentCamera.current;
  }, [camera]);
  useEffect(() => {
    const recover = () => cancelActiveCameraInteraction();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') recover();
    };
    window.addEventListener('blur', recover);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', recover);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelActiveCameraInteraction();
    };
  }, [cancelActiveCameraInteraction]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => cancelActiveCameraInteraction());
    observer.observe(svg);
    return () => observer.disconnect();
  }, [cancelActiveCameraInteraction]);
  useEffect(
    () => cancelActiveCameraInteraction(),
    [cancelActiveCameraInteraction, interactionEnabled, mapMode],
  );
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!interactionEnabledRef.current) return;
      const { x, y } = svgPoint(event, svg);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (mapModeRef.current === 'globe') {
        const adaptiveSpeed =
          CAMERA_SETTINGS.zoomSpeed * (0.72 + Math.log2(Math.max(1, targetCamera.current.zoom)) * 0.14);
        const zoom = clamp(
          targetCamera.current.zoom * Math.exp(-delta * CAMERA_SETTINGS.wheelSmoothing * adaptiveSpeed),
          CAMERA_SETTINGS.minZoom,
          CAMERA_SETTINGS.maxZoom,
        );
        targetCamera.current = roundCamera({ x: 0, y: 0, zoom });
        if (!animation.current) glideToTarget();
        return;
      }
      targetCamera.current = zoomAtPoint(targetCamera.current, x, y, delta * CAMERA_SETTINGS.wheelSmoothing);
      if (!animation.current) glideToTarget();
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);
  const animateTo = (target: CameraState, duration = CAMERA_SETTINGS.animatedZoomMs) => {
    cancelCameraFrames();
    const start = constrainCamera(targetCamera.current);
    const end = constrainCamera(target);
    const startedAt = performance.now();
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      const next = roundCamera({
        x: start.x + (end.x - start.x) * eased,
        y: start.y + (end.y - start.y) * eased,
        zoom: start.zoom * Math.pow(end.zoom / start.zoom, eased),
      });
      targetCamera.current = next;
      currentCamera.current = next;
      emitCameraChange(next);
      if (progress < 1) animation.current = requestAnimationFrame(tick);
      else animation.current = null;
    };
    animation.current = requestAnimationFrame(tick);
  };
  const glideToTarget = () => {
    cancelCameraFrames();
    const tick = () => {
      const next = roundCamera({
        x: currentCamera.current.x + (targetCamera.current.x - currentCamera.current.x) * 0.34,
        y: currentCamera.current.y + (targetCamera.current.y - currentCamera.current.y) * 0.34,
        zoom:
          currentCamera.current.zoom * Math.pow(targetCamera.current.zoom / currentCamera.current.zoom, 0.34),
      });
      currentCamera.current = next;
      emitCameraChange(next);
      if (
        Math.abs(next.x - targetCamera.current.x) > 0.02 ||
        Math.abs(next.y - targetCamera.current.y) > 0.02 ||
        Math.abs(next.zoom - targetCamera.current.zoom) > 0.0001
      )
        animation.current = requestAnimationFrame(tick);
      else {
        currentCamera.current = targetCamera.current;
        emitCameraChange(targetCamera.current);
        animation.current = null;
      }
    };
    animation.current = requestAnimationFrame(tick);
  };
  const runMomentum = () => {
    cancelCameraFrames();
    const tick = () => {
      velocity.current = {
        x: velocity.current.x * CAMERA_SETTINGS.panFriction,
        y: velocity.current.y * CAMERA_SETTINGS.panFriction,
      };
      if (Math.hypot(velocity.current.x, velocity.current.y) < 0.05) {
        targetCamera.current = constrainCamera(targetCamera.current);
        currentCamera.current = targetCamera.current;
        emitCameraChange(targetCamera.current);
        animation.current = null;
        return;
      }
      targetCamera.current = applyEdgeResistance({
        ...targetCamera.current,
        x: targetCamera.current.x + velocity.current.x,
        y: targetCamera.current.y + velocity.current.y,
      });
      currentCamera.current = targetCamera.current;
      emitCameraChange(targetCamera.current);
      animation.current = requestAnimationFrame(tick);
    };
    animation.current = requestAnimationFrame(tick);
  };
  const applyGlobeRotation = (rotation: GlobeRotation) => {
    globeRotation.current = {
      lon: wrap(rotation.lon, -180, 180),
      lat: clamp(rotation.lat, -82, 82),
    };
    emitCameraChange({ ...currentCamera.current });
  };
  const runGlobeMomentum = () => {
    cancelCameraFrames();
    const tick = () => {
      globeVelocity.current = {
        lon: globeVelocity.current.lon * 0.92,
        lat: globeVelocity.current.lat * 0.9,
      };
      if (Math.hypot(globeVelocity.current.lon, globeVelocity.current.lat) < 0.05) {
        globeAnimation.current = null;
        return;
      }
      applyGlobeRotation({
        lon: globeRotation.current.lon + globeVelocity.current.lon,
        lat: globeRotation.current.lat + globeVelocity.current.lat,
      });
      globeAnimation.current = requestAnimationFrame(tick);
    };
    globeAnimation.current = requestAnimationFrame(tick);
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactionEnabled) return;
    if (moving.current) return;
    cancelActiveCameraInteraction();
    event.currentTarget.focus();
    const point = svgPoint(event, event.currentTarget);
    drag.current = { x: point.x - currentCamera.current.x, y: point.y - currentCamera.current.y };
    lastPan.current = { x: event.clientX, y: event.clientY, time: performance.now() };
    velocity.current = { x: 0, y: 0 };
    activePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (moving.current) {
      const point = svgPoint(event, event.currentTarget);
      onMoveLayer(moving.current, point.x, point.y);
    } else if (drag.current) {
      const now = performance.now();
      const previous = lastPan.current;
      if (previous) {
        const dt = Math.max(1, now - previous.time);
        if (mapMode === 'globe')
          globeVelocity.current = {
            lon: ((event.clientX - previous.x) / dt) * 16.67 * 0.42,
            lat: ((event.clientY - previous.y) / dt) * 16.67 * 0.42,
          };
        else
          velocity.current = {
            x: ((event.clientX - previous.x) / dt) * 16.67,
            y: ((event.clientY - previous.y) / dt) * 16.67,
          };
      }
      lastPan.current = { x: event.clientX, y: event.clientY, time: now };
      if (mapMode === 'globe') {
        applyGlobeRotation({
          lon: globeRotation.current.lon - globeVelocity.current.lon,
          lat: globeRotation.current.lat + globeVelocity.current.lat,
        });
        return;
      }
      targetCamera.current = applyEdgeResistance({
        ...currentCamera.current,
        x: svgPoint(event, event.currentTarget).x - drag.current.x,
        y: svgPoint(event, event.currentTarget).y - drag.current.y,
      });
      currentCamera.current = targetCamera.current;
      emitCameraChange(targetCamera.current);
    }
  };
  const end = () => {
    const shouldMomentum = drag.current && Math.hypot(velocity.current.x, velocity.current.y) > 0.5;
    const shouldGlobeMomentum =
      drag.current &&
      mapMode === 'globe' &&
      Math.hypot(globeVelocity.current.lon, globeVelocity.current.lat) > 0.5;
    drag.current = null;
    lastPan.current = null;
    moving.current = null;
    activePointerId.current = null;
    if (shouldGlobeMomentum) runGlobeMomentum();
    else if (shouldMomentum) runMomentum();
    else {
      targetCamera.current = constrainCamera(targetCamera.current);
      currentCamera.current = targetCamera.current;
      emitCameraChange(targetCamera.current);
    }
  };
  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!interactionEnabled) return;
    const { x, y } = svgPoint(event, event.currentTarget);
    if (mapMode === 'globe') {
      targetCamera.current = roundCamera({
        x: 0,
        y: 0,
        zoom: clamp(currentCamera.current.zoom * 1.62, CAMERA_SETTINGS.minZoom, CAMERA_SETTINGS.maxZoom),
      });
      glideToTarget();
      return;
    }
    animateTo(zoomAtPoint(currentCamera.current, x, y, -420));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!interactionEnabled) return;
    if (event.code === 'Space') spacePan.current = true;
    if (event.key === 'Home') {
      event.preventDefault();
      animateTo(fitWorldCamera());
    }
    const step = CAMERA_SETTINGS.keyboardStep;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const next = movement[event.key];
    if (!next) return;
    event.preventDefault();
    animateTo(
      constrainCamera({
        ...currentCamera.current,
        x: currentCamera.current.x + next[0],
        y: currentCamera.current.y + next[1],
      }),
      180,
    );
  };
  const onKeyUp = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.code === 'Space') spacePan.current = false;
  };
  const beginLayerMove = (event: PointerEvent<SVGGElement>, layer: Layer) => {
    if (!interactionEnabled) return;
    if (layer.locked) return;
    if (spacePan.current) return;
    event.stopPropagation();
    moving.current = layer.id;
    activePointerId.current = event.pointerId;
    onSelect(layer.id);
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  };
  return (
    <MapScene
      style={style}
      mapMode={mapMode}
      layers={layers}
      camera={camera}
      labelLanguage={labelLanguage}
      selectedId={selectedId}
      safeArea={safeArea}
      showSafeArea={showSafeArea}
      assetUrls={assetUrls}
      globeRotation={globeRotation.current}
      onBackgroundClick={() => onSelect(null)}
      onLayerPointerDown={beginLayerMove}
      svgProps={{
        ref: svgRef,
        onPointerDown,
        onPointerMove,
        onPointerUp: end,
        onPointerLeave: end,
        onPointerCancel: cancelActiveCameraInteraction,
        onLostPointerCapture: (event) => {
          if (activePointerId.current === event.pointerId) cancelActiveCameraInteraction();
        },
        onDoubleClick,
        onKeyDown,
        onKeyUp,
        tabIndex: 0,
      }}
    />
  );
}

function svgPoint(event: { clientX: number; clientY: number }, svg: SVGSVGElement) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const transformed = point.matrixTransform(svg.getScreenCTM()?.inverse());
  return { x: transformed.x, y: transformed.y };
}

export function MapScene({
  style,
  mapMode = 'flat',
  layers,
  camera,
  labelLanguage,
  width = '100%',
  height = '100%',
  viewBox = '0 0 1000 560',
  selectedId = null,
  safeArea = 0,
  showSafeArea = false,
  svgProps,
  onBackgroundClick,
  onLayerPointerDown,
  assetUrls = {},
  globeRotation = { lon: 0, lat: 0 },
}: MapSceneProps) {
  const globe = globeProjection(camera, globeRotation);
  const transform =
    mapMode === 'globe' ? undefined : `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`;
  const labels = useMemo(() => selectMapLabels(camera), [camera.x, camera.y, camera.zoom]);
  const projectedMap = useMemo(
    () =>
      mapMode === 'globe'
        ? {
            countries: new Map(
              COUNTRIES.map((country) => [country.id, projectPathToGlobe(country.path, globe)]),
            ),
            lakes: projectPathToGlobe(LAKE_PATH, globe),
            rivers: RIVER_PATHS.map((path) => projectPathToGlobe(path, globe)),
            borders: projectPathToGlobe(COUNTRY_BORDER_PATH, globe),
            coastlines: projectPathToGlobe(COASTLINE_PATH, globe),
          }
        : null,
    [mapMode, globe.centerLat, globe.centerLon, globe.radius],
  );
  return (
    <svg
      {...svgProps}
      xmlns="http://www.w3.org/2000/svg"
      className="offline-map"
      width={width}
      height={height}
      viewBox={viewBox}
      role="img"
      aria-label="Offline political map"
      style={{ background: mapMode === 'globe' ? style.backgroundColor : style.waterColor }}
    >
      <defs>
        <clipPath id="globe-clip">
          <circle cx="500" cy="280" r={globe.radius} />
        </clipPath>
        <radialGradient id="globe-water" cx=".38" cy=".28" r=".74">
          <stop offset="0" stopColor={style.waterColor} />
          <stop offset=".72" stopColor={style.waterColor} />
          <stop offset="1" stopColor={style.backgroundColor} />
        </radialGradient>
        <filter id="globe-shadow" x="-8%" y="-8%" width="116%" height="116%">
          <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#000000" floodOpacity=".28" />
        </filter>
        <pattern id="grid" width="70" height="70" patternUnits="userSpaceOnUse">
          <path
            d="M 70 0 L 0 0 0 70"
            fill="none"
            stroke={style.countryBorderColor}
            strokeOpacity=".12"
            strokeWidth=".6"
          />
        </pattern>
        <linearGradient id="modern-land" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={style.landColor} />
          <stop offset="1" stopColor="#a9c5bb" />
        </linearGradient>
        <linearGradient id="terrain-land" x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#d7d39a" />
          <stop offset=".38" stopColor={style.landColor} />
          <stop offset=".72" stopColor="#789665" />
          <stop offset="1" stopColor="#b59b72" />
        </linearGradient>
        <pattern id="ink-land" width="7" height="7" patternUnits="userSpaceOnUse">
          <rect width="7" height="7" fill={style.landColor} />
          <path d="M0 7L7 0" stroke="#514c44" strokeWidth=".35" opacity=".18" />
        </pattern>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8Z" fill="context-stroke" />
        </marker>
      </defs>
      <rect width="1000" height="560" fill={style.backgroundColor} onClick={onBackgroundClick} />
      {mapMode === 'flat' ? (
        <>
          <rect width="1000" height="560" fill={style.waterColor} onClick={onBackgroundClick} />
          <rect width="1000" height="560" fill="url(#grid)" onClick={onBackgroundClick} />
        </>
      ) : (
        <ellipse
          cx="500"
          cy="280"
          rx={globe.radius}
          ry={globe.radius}
          fill="url(#globe-water)"
          filter="url(#globe-shadow)"
          className="globe-shell"
          onClick={onBackgroundClick}
        />
      )}
      {showSafeArea && (
        <rect
          className="safe-area-guide"
          x={safeArea / 2}
          y={safeArea / 2}
          width={1000 - safeArea}
          height={560 - safeArea}
        />
      )}
      <g clipPath={mapMode === 'globe' ? 'url(#globe-clip)' : undefined}>
        {mapMode === 'globe' && <GlobeGraticule color={style.countryBorderColor} />}
        <g transform={transform}>
          {COUNTRIES.map((c) => {
            const projected = projectedMap ? projectedMap.countries.get(c.id) : c.path;
            return projected ? (
              <path
                key={c.id}
                d={projected}
                fill={
                  style.texture === 'modern'
                    ? 'url(#modern-land)'
                    : style.texture === 'terrain'
                      ? 'url(#terrain-land)'
                      : style.texture === 'ink'
                        ? 'url(#ink-land)'
                        : style.landColor
                }
                fillRule="evenodd"
                className="country"
              />
            ) : null;
          })}
          <path
            d={projectedMap ? projectedMap.lakes : LAKE_PATH}
            fill={style.lakeColor}
            fillRule="evenodd"
            className="physical-lakes"
            opacity={labels.lakesOpacity}
          />
          {RIVER_PATHS.map((path, index) => (
            <path
              key={`rivers-${index}`}
              d={projectedMap ? projectedMap.rivers[index] : path}
              fill="none"
              stroke={style.riverColor}
              strokeWidth={[1.05, 0.7, 0.45][index]}
              opacity={[0.9, 0.72, 0.52][index] * labels.riversOpacity}
              vectorEffect="non-scaling-stroke"
              className="physical-rivers"
            />
          ))}
          <path
            d={projectedMap ? projectedMap.borders : COUNTRY_BORDER_PATH}
            fill="none"
            stroke={style.countryBorderColor}
            strokeWidth={style.countryBorderWidth}
            vectorEffect="non-scaling-stroke"
            className="country-borders"
          />
          <path
            d={projectedMap ? projectedMap.coastlines : COASTLINE_PATH}
            fill="none"
            stroke={style.coastlineColor}
            strokeWidth={Math.max(0.75, style.countryBorderWidth)}
            vectorEffect="non-scaling-stroke"
            className="coastlines"
          />
          {labelLanguage !== 'none' &&
            labels.continents.map(({ item: label, opacity }) => (
              <MapFeatureLabel
                key={`${label.id}-continent`}
                label={label}
                language={labelLanguage}
                color={style.continentLabelColor}
                className="continent-label"
                opacity={opacity}
                globe={mapMode === 'globe' ? globe : undefined}
              />
            ))}
          {labelLanguage !== 'none' &&
            labels.oceans.map(({ item: label, opacity }) => (
              <MapFeatureLabel
                key={`${label.id}-marine`}
                label={label}
                language={labelLanguage}
                color={style.physicalLabelColor}
                className="marine-label"
                opacity={opacity}
                globe={mapMode === 'globe' ? globe : undefined}
              />
            ))}
          {labelLanguage !== 'none' &&
            labels.countries.map(({ item: c, opacity, scale, letterSpacing }) => (
              <CountryLabel
                key={`${c.id}-label`}
                country={c}
                language={labelLanguage}
                color={style.countryLabelColor}
                opacity={opacity}
                scale={scale}
                letterSpacing={letterSpacing}
                globe={mapMode === 'globe' ? globe : undefined}
              />
            ))}
          {labelLanguage !== 'none' &&
            [...labels.capitals, ...labels.cities].map(({ item: label, opacity }) => (
              <CityLabel
                key={`${label.id}-city`}
                label={label}
                language={labelLanguage}
                color={style.cityColor}
                opacity={opacity}
                globe={mapMode === 'globe' ? globe : undefined}
              />
            ))}
          {layers
            .filter((l) => l.visible)
            .map((layer) => (
              <LayerGraphic
                key={layer.id}
                layer={layer}
                selected={layer.id === selectedId}
                onPointerDown={(event) => onLayerPointerDown?.(event, layer)}
                assetUrl={layer.assetId ? assetUrls[layer.assetId] : undefined}
                globe={mapMode === 'globe' ? globe : undefined}
              />
            ))}
        </g>
      </g>
      <text x="26" y="526" fill={style.countryLabelColor} opacity=".52" className="map-credit">
        NATURAL EARTH 1:50M · OFFLINE · {WORLD_MAP_DATASET.version}
      </text>
    </svg>
  );
}

function GlobeGraticule({ color }: { color: string }) {
  return (
    <g className="globe-graticule" stroke={color} fill="none" opacity=".18">
      {[260, 340, 420, 500, 580, 660, 740].map((x) => (
        <path key={`lon-${x}`} d={`M ${x} 18 C ${x - 52} 142 ${x - 52} 418 ${x} 542`} />
      ))}
      {[100, 160, 220, 280, 340, 400, 460].map((y) => (
        <ellipse key={`lat-${y}`} cx="500" cy={y} rx={Math.max(80, 270 - Math.abs(280 - y) * 0.64)} ry="20" />
      ))}
      <circle cx="500" cy="280" r="270" strokeWidth="1.3" opacity=".6" />
    </g>
  );
}

interface GlobeProjection {
  cx: number;
  cy: number;
  radius: number;
  centerLon: number;
  centerLat: number;
  symbolScale: number;
}

function globeProjection(camera: CameraState, rotation: GlobeRotation): GlobeProjection {
  const radius = clamp(230 + (camera.zoom - 1) * 40, 230, 430);
  return {
    cx: 500,
    cy: 280,
    radius,
    centerLon: rotation.lon,
    centerLat: rotation.lat,
    symbolScale: clamp(radius / 270, 0.82, 1.42),
  };
}

function projectLayerPoint(x: number, y: number, globe?: GlobeProjection) {
  return globe ? projectPointToGlobe([x, y], globe) : { x, y };
}

function projectPointToGlobe(point: readonly [number, number], globe: GlobeProjection) {
  const lon = (point[0] / 1000) * 360 - 180;
  const lat = 90 - (point[1] / 560) * 180;
  const lambda = degToRad(lon - globe.centerLon);
  const phi = degToRad(lat);
  const phi0 = degToRad(globe.centerLat);
  const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda);
  if (cosc < -0.012) return null;
  return {
    x: round(globe.cx + globe.radius * Math.cos(phi) * Math.sin(lambda), 3),
    y: round(
      globe.cy -
        globe.radius * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda)),
      3,
    ),
  };
}

function projectPathToGlobe(path: string, globe: GlobeProjection) {
  const tokens = path.match(/[MLZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const commands: string[] = [];
  let index = 0;
  let penVisible = false;
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === 'Z') {
      if (penVisible) commands.push('Z');
      penVisible = false;
      continue;
    }
    if (token !== 'M' && token !== 'L') continue;
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const projected = projectPointToGlobe([x, y], globe);
    if (!projected) {
      penVisible = false;
      continue;
    }
    commands.push(`${penVisible && token === 'L' ? 'L' : 'M'}${projected.x} ${projected.y}`);
    penVisible = true;
  }
  return commands.join('');
}

function degToRad(value: number) {
  return (value * Math.PI) / 180;
}

function round(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function wrap(value: number, min: number, max: number) {
  const width = max - min;
  return ((((value - min) % width) + width) % width) + min;
}

function CountryLabel({
  country,
  language,
  color,
  opacity,
  scale = 1,
  letterSpacing = 0.16,
  globe,
}: {
  country: (typeof COUNTRIES)[number];
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  opacity: number;
  scale?: number;
  letterSpacing?: number;
  globe?: GlobeProjection;
}) {
  const fa = country.nameFa || country.name;
  const point = projectLayerPoint(country.label[0], country.label[1], globe);
  if (!point) return null;
  return (
    <text
      x={point.x}
      y={point.y}
      fill={color}
      className="country-label"
      style={{ fontSize: `${5.9 * scale}px`, letterSpacing }}
      textAnchor="middle"
      opacity={opacity}
    >
      {language === 'en' && country.name}
      {language === 'fa' && (
        <tspan direction="rtl" unicodeBidi="plaintext">
          {fa}
        </tspan>
      )}
      {language === 'both' && (
        <>
          <tspan x={point.x} dy="-4" direction="rtl" unicodeBidi="plaintext">
            {fa}
          </tspan>
          <tspan x={point.x} dy="9">
            {country.name}
          </tspan>
        </>
      )}
    </text>
  );
}
function MapFeatureLabel({
  label,
  language,
  color,
  className,
  opacity,
  globe,
}: {
  label: MapLabel;
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  className: string;
  opacity: number;
  globe?: GlobeProjection;
}) {
  const text = language === 'fa' ? label.nameFa : label.name;
  const point = projectLayerPoint(label.point[0], label.point[1], globe);
  if (!point) return null;
  return (
    <text
      x={point.x}
      y={point.y}
      fill={color}
      className={`${className} ${language === 'fa' ? 'persian-text' : ''}`}
      textAnchor="middle"
      direction={language === 'fa' ? 'rtl' : 'ltr'}
      unicodeBidi="plaintext"
      opacity={opacity}
    >
      {language === 'both' ? (
        <>
          <tspan x={point.x} dy="-3" className="persian-text" direction="rtl">
            {label.nameFa}
          </tspan>
          <tspan x={point.x} dy="8">
            {label.name}
          </tspan>
        </>
      ) : (
        text
      )}
    </text>
  );
}

function CityLabel({
  label,
  language,
  color,
  opacity,
  globe,
}: {
  label: MapLabel;
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  opacity: number;
  globe?: GlobeProjection;
}) {
  const text = language === 'fa' ? label.nameFa : label.name;
  const shown = language === 'both' ? `${label.name} · ${label.nameFa}` : text;
  const point = projectLayerPoint(label.point[0], label.point[1], globe);
  if (!point) return null;
  return (
    <g className={`city-label ${label.capital ? 'capital-label' : ''}`} opacity={opacity}>
      <circle cx={point.x} cy={point.y} r={label.capital ? 1.8 : 1.2} fill={color} />
      <text
        x={point.x + 3}
        y={point.y - 2}
        fill={color}
        className={language !== 'en' ? 'persian-text' : ''}
        direction={language === 'fa' ? 'rtl' : 'ltr'}
        unicodeBidi="plaintext"
      >
        {shown}
      </text>
    </g>
  );
}
function LayerGraphic({
  layer,
  selected,
  onPointerDown,
  assetUrl,
  globe,
}: {
  layer: Layer;
  selected: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  assetUrl?: string;
  globe?: GlobeProjection;
}) {
  const common = {
    opacity: layer.opacity,
    onPointerDown,
    className: `layer-graphic ${selected ? 'selected-layer' : ''}`,
  };
  const point = projectLayerPoint(layer.x, layer.y, globe);
  const point2 =
    typeof layer.x2 === 'number' && typeof layer.y2 === 'number'
      ? projectLayerPoint(layer.x2, layer.y2, globe)
      : null;
  if (!point) return null;
  if (layer.type === 'region') {
    const country = findCountry(layer.countryId);
    const path = country && globe ? projectPathToGlobe(country.path, globe) : country?.path;
    if (!country || !path) return null;
    return country ? (
      <g {...common}>
        <path d={path} fill={layer.color} fillOpacity=".45" stroke={layer.color} strokeWidth="3" />
        <text x={point.x} y={point.y + 28} fill={layer.color} textAnchor="middle" className="layer-caption">
          {layer.name}
        </text>
      </g>
    ) : null;
  }
  if (layer.type === 'pin')
    return (
      <g {...common}>
        <circle
          cx={point.x}
          cy={point.y}
          r={13 * (globe?.symbolScale ?? 1)}
          fill={layer.color}
          stroke="#fff"
          strokeWidth="3"
        />
        <circle cx={point.x} cy={point.y} r={4 * (globe?.symbolScale ?? 1)} fill="#17202d" />
        <text
          x={point.x + 18 * (globe?.symbolScale ?? 1)}
          y={point.y + 4}
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
          x={point.x}
          y={point.y}
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
  if (layer.type === 'image' && assetUrl)
    return (
      <g {...common}>
        <image
          href={assetUrl}
          x={point.x}
          y={point.y}
          width={(layer.width ?? 0) * (globe?.symbolScale ?? 1)}
          height={(layer.height ?? 0) * (globe?.symbolScale ?? 1)}
          preserveAspectRatio="xMidYMid meet"
        />
      </g>
    );
  if (layer.type === 'shape' || layer.type === 'image')
    return (
      <g {...common}>
        <rect
          x={point.x}
          y={point.y}
          width={(layer.width ?? 0) * (globe?.symbolScale ?? 1)}
          height={(layer.height ?? 0) * (globe?.symbolScale ?? 1)}
          rx="3"
          fill={layer.type === 'image' ? '#24364c' : layer.color}
          fillOpacity={layer.type === 'image' ? '.9' : '.25'}
          stroke={layer.color}
          strokeWidth="2"
        />
        <text
          x={point.x + ((layer.width ?? 0) * (globe?.symbolScale ?? 1)) / 2}
          y={point.y + ((layer.height ?? 0) * (globe?.symbolScale ?? 1)) / 2 + 4}
          textAnchor="middle"
          fill={layer.color}
          className="layer-caption"
        >
          {layer.type === 'image' ? 'IMAGE' : 'CALLOUT'}
        </text>
      </g>
    );
  if (layer.type === 'geo-effect')
    return <GeoEffect layer={projectedLayer(layer, point, point2, globe)} common={common} />;
  const dash = layer.type === 'route' ? '8 6' : undefined;
  if (!point2) return null;
  return (
    <g {...common}>
      <line
        x1={point.x}
        y1={point.y}
        x2={point2.x}
        y2={point2.y}
        stroke={layer.color}
        strokeWidth={layer.type === 'arrow' ? 6 : 3}
        strokeDasharray={dash}
        markerEnd="url(#arrowhead)"
      />
      <circle cx={point.x} cy={point.y} r="4" fill={layer.color} />
    </g>
  );
}

function projectedLayer(
  layer: Layer,
  point: { x: number; y: number },
  point2: { x: number; y: number } | null,
  globe?: GlobeProjection,
): Layer {
  const scale = globe?.symbolScale ?? 1;
  return {
    ...layer,
    x: point.x,
    y: point.y,
    x2: point2?.x ?? layer.x2,
    y2: point2?.y ?? layer.y2,
    effectSize: (layer.effectSize ?? 44) * scale,
  };
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
