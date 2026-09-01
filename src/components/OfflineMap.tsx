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
  applyCameraWheel,
  cameraForWorldAtScreen,
  CAMERA_SETTINGS,
  CAMERA_VIEWPORT,
  clamp,
  constrainCamera,
  fitWorldCamera,
  interpolateBearing,
  normalizeBearing,
  normalizeWheelDelta,
  projectWorldToScreen,
  roundCamera,
  unprojectScreenToWorld,
  zoomAtPoint,
} from '../core/camera';
import {
  PIN_DEFAULTS,
  pinLabelOffsetOf,
  pinSizeOf,
  pinStyleOf,
  type CameraState,
  type Layer,
  type MapMode,
  type MapStylePreset,
  type PinStyle,
  type Project,
} from '../core/project';
import { projectFlatMapLabel, selectMapLabels } from '../core/mapLabels';
import { constrainCameraForRenderer } from '../core/cameraZoomPolicy';
import { preparseSvgPaths, projectSvgPath } from '../core/perspectiveGeometry';
import { formatNumbers, resolveTextDirection, resolveTextLanguage } from '../core/text';
import { WebGLGlobe } from './WebGLGlobe';
import { CameraOrbitControl } from './CameraOrbitControl';
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

preparseSvgPaths([
  ...COUNTRIES.map((country) => country.path),
  LAKE_PATH,
  ...RIVER_PATHS,
  COUNTRY_BORDER_PATH,
  COASTLINE_PATH,
]);

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
  onDeleteSelected?: () => void;
  onBackgroundClick?: (point: { x: number; y: number }) => void;
  safeArea: number;
  showSafeArea: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  /** Render editor-only placeholders (e.g. custom pin with no image yet). */
  editorMode?: boolean;
  viewBox?: string;
}

export type { MapMode } from '../core/project';

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
  onBackgroundClick?: (point: { x: number; y: number }) => void;
  onLayerPointerDown?: (event: PointerEvent<SVGGElement>, layer: Layer) => void;
  assetUrls?: Readonly<Record<string, string>>;
  globeRotation?: GlobeRotation;
  editorMode?: boolean;
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
  onDeleteSelected,
  onBackgroundClick,
  safeArea,
  showSafeArea,
  assetUrls,
  editorMode = true,
  viewBox,
}: Props) {
  const drag = useRef<{ worldX: number; worldY: number } | null>(null);
  const lastPan = useRef<{ x: number; y: number; time: number } | null>(null);
  const velocity = useRef({ x: 0, y: 0 });
  const globeRotation = useRef<GlobeRotation>({ lon: 0, lat: 0 });
  const globeVelocity = useRef({ lon: 0, lat: 0 });
  const animation = useRef<number | null>(null);
  const globeAnimation = useRef<number | null>(null);
  const targetCamera = useRef(constrainCameraForRenderer(camera, 'legacy'));
  const currentCamera = useRef(constrainCameraForRenderer(camera, 'legacy'));
  const spacePan = useRef(false);
  const moving = useRef<string | null>(null);
  const movedSinceDown = useRef(false);
  const activePointerId = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
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
    if (viewportRef.current)
      viewportRef.current.style.cursor = interactionEnabledRef.current ? 'grab' : 'default';
    currentCamera.current = constrainCamera(currentCamera.current);
    targetCamera.current = currentCamera.current;
  }, [cancelCameraFrames]);
  useEffect(() => {
    if (animation.current || globeAnimation.current) return;
    currentCamera.current = constrainCameraForRenderer(camera, 'legacy');
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
    if (mapMode !== 'flat') return;
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => cancelActiveCameraInteraction());
    observer.observe(svg);
    return () => observer.disconnect();
  }, [cancelActiveCameraInteraction, mapMode]);
  useEffect(
    () => cancelActiveCameraInteraction(),
    [cancelActiveCameraInteraction, interactionEnabled, mapMode],
  );
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, select, textarea, [data-map-wheel-exempt="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!interactionEnabledRef.current) return;
      const mode = mapModeRef.current;
      if (mode === 'globe') {
        const result = applyCameraWheel(
          targetCamera.current,
          mode,
          event.deltaY,
          event.deltaMode,
          event.ctrlKey,
          event.altKey,
          viewport.clientHeight,
        );
        cancelCameraFrames();
        if (result.action !== 'reserved') {
          targetCamera.current = result.camera;
          currentCamera.current = result.camera;
          emitCameraChange(result.camera);
        }
        return;
      }
      const svg = svgRef.current;
      if (!svg) return;
      if (event.ctrlKey || event.altKey) {
        const result = applyCameraWheel(
          targetCamera.current,
          'flat',
          event.deltaY,
          event.deltaMode,
          event.ctrlKey,
          event.altKey,
          svg.clientHeight,
        );
        cancelCameraFrames();
        targetCamera.current = result.camera;
        currentCamera.current = result.camera;
        emitCameraChange(result.camera);
        return;
      }
      const { x, y } = svgPoint(event, svg);
      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, svg.clientHeight);
      targetCamera.current = zoomAtPoint(targetCamera.current, x, y, delta * CAMERA_SETTINGS.wheelSmoothing);
      if (!animation.current) glideToTarget();
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [cancelCameraFrames, emitCameraChange]);
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
        bearing: interpolateBearing(start.bearing, end.bearing, eased),
        pitch: (start.pitch ?? 0) + ((end.pitch ?? 0) - (start.pitch ?? 0)) * eased,
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
        bearing: currentCamera.current.bearing,
        pitch: currentCamera.current.pitch,
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
    const world = unprojectScreenToWorld(currentCamera.current, point.x, point.y);
    if (!world) return;
    drag.current = { worldX: world.x, worldY: world.y };
    lastPan.current = { x: event.clientX, y: event.clientY, time: performance.now() };
    velocity.current = { x: 0, y: 0 };
    movedSinceDown.current = false;
    activePointerId.current = event.pointerId;
    if (viewportRef.current) viewportRef.current.style.cursor = 'grabbing';
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    movedSinceDown.current = true;
    if (moving.current) {
      const point = svgPoint(event, event.currentTarget);
      // Convert the cursor's screen-space point to the layer's geographic
      // (world) coordinate so the graphic tracks the cursor at any zoom.
      const world =
        mapMode === 'globe' ? point : unprojectScreenToWorld(currentCamera.current, point.x, point.y);
      if (!world) return;
      onMoveLayer(moving.current, world.x, world.y);
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
      }
      lastPan.current = { x: event.clientX, y: event.clientY, time: now };
      if (mapMode === 'globe') {
        applyGlobeRotation({
          lon: globeRotation.current.lon - globeVelocity.current.lon,
          lat: globeRotation.current.lat + globeVelocity.current.lat,
        });
        return;
      }
      const point = svgPoint(event, event.currentTarget);
      const anchored = cameraForWorldAtScreen(
        currentCamera.current,
        drag.current.worldX,
        drag.current.worldY,
        point.x,
        point.y,
      );
      if (!anchored) return;
      const previousCamera = currentCamera.current;
      targetCamera.current = applyEdgeResistance(anchored);
      velocity.current = {
        x: targetCamera.current.x - previousCamera.x,
        y: targetCamera.current.y - previousCamera.y,
      };
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
    if (viewportRef.current) viewportRef.current.style.cursor = interactionEnabled ? 'grab' : 'default';
    if (shouldGlobeMomentum) runGlobeMomentum();
    else if (shouldMomentum) runMomentum();
    else {
      targetCamera.current = constrainCamera(targetCamera.current);
      currentCamera.current = targetCamera.current;
      emitCameraChange(targetCamera.current);
    }
  };
  /**
   * Handle pointerup with background click detection.
   * This is the primary mechanism for pin placement: when the user clicks
   * the map (no drag), we forward the event to onBackgroundClick. This
   * bypasses the rect onClick which is unreliable in Tauri WebView2 due
   * to setPointerCapture stealing events from child elements.
   */
  const onPointerUpHandler = (event: PointerEvent<SVGSVGElement>) => {
    const wasClick = drag.current !== null && !movedSinceDown.current && !moving.current;
    end();
    if (wasClick && onBackgroundClick) {
      const svgCoords = svgPoint(event, event.currentTarget);
      const worldPoint =
        mapModeRef.current === 'globe'
          ? svgCoords
          : unprojectScreenToWorld(currentCamera.current, svgCoords.x, svgCoords.y);
      if (worldPoint) onBackgroundClick(worldPoint);
    }
  };
  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!interactionEnabled) return;
    const { x, y } = svgPoint(event, event.currentTarget);
    if (mapMode === 'globe') {
      targetCamera.current = roundCamera({
        ...currentCamera.current,
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
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (onDeleteSelected) {
        event.preventDefault();
        onDeleteSelected();
      }
      return;
    }
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
  const mapRenderer =
    mapMode === 'globe' ? (
      <WebGLGlobe
        style={style}
        layers={layers}
        camera={camera}
        onCameraChange={onCameraChange}
        interactionEnabled={interactionEnabled}
        labelLanguage={labelLanguage}
        selectedId={selectedId}
        onSelect={onSelect}
        onMoveLayer={onMoveLayer}
        onBackgroundClick={onBackgroundClick}
      />
    ) : (
      <MapScene
        style={style}
        mapMode="flat"
        layers={layers}
        camera={camera}
        labelLanguage={labelLanguage}
        selectedId={selectedId}
        safeArea={safeArea}
        showSafeArea={showSafeArea}
        assetUrls={assetUrls}
        onBackgroundClick={onBackgroundClick ?? (() => onSelect(null))}
        editorMode={editorMode}
        viewBox={viewBox}
        onLayerPointerDown={beginLayerMove}
        svgProps={{
          ref: svgRef,
          onPointerDown,
          onPointerMove,
          onPointerUp: onPointerUpHandler,
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
  return (
    <div
      ref={viewportRef}
      className="map-navigation-viewport"
      data-map-mode={mapMode}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        cursor: interactionEnabled ? 'grab' : 'default',
      }}
    >
      {mapRenderer}
      {editorMode ? (
        <CameraOrbitControl
          camera={camera}
          mapMode={mapMode}
          disabled={!interactionEnabled}
          onChange={onCameraChange}
        />
      ) : null}
    </div>
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
  editorMode = false,
}: MapSceneProps) {
  const globe = globeProjection(camera, globeRotation);
  const bearing = normalizeBearing(camera.bearing);
  const flatPerspectiveCamera = mapMode === 'flat' && (camera.pitch ?? 0) !== 0 ? camera : undefined;
  const transform =
    mapMode === 'globe'
      ? undefined
      : flatPerspectiveCamera
        ? undefined
        : `translate(${CAMERA_VIEWPORT.width / 2} ${CAMERA_VIEWPORT.height / 2}) rotate(${bearing}) translate(${-CAMERA_VIEWPORT.width / 2} ${-CAMERA_VIEWPORT.height / 2}) translate(${camera.x} ${camera.y}) scale(${camera.zoom})`;
  const backgroundClick = (event: React.MouseEvent<SVGElement>) => {
    const point = svgPoint(event, event.currentTarget.ownerSVGElement as SVGSVGElement);
    const world = mapMode === 'globe' ? point : unprojectScreenToWorld(camera, point.x, point.y);
    if (world) onBackgroundClick?.(world);
  };
  const labels = useMemo(() => selectMapLabels(camera), [camera.x, camera.y, camera.zoom]);
  const projectedMap = useMemo(
    () =>
      mapMode === 'globe' || flatPerspectiveCamera
        ? {
            countries: new Map(
              COUNTRIES.map((country) => [
                country.id,
                mapMode === 'globe'
                  ? projectPathToGlobe(country.path, globe)
                  : projectPathToFlatCamera(country.path, camera),
              ]),
            ),
            lakes:
              mapMode === 'globe'
                ? projectPathToGlobe(LAKE_PATH, globe)
                : projectPathToFlatCamera(LAKE_PATH, camera),
            rivers: RIVER_PATHS.map((path) =>
              mapMode === 'globe' ? projectPathToGlobe(path, globe) : projectPathToFlatCamera(path, camera),
            ),
            borders:
              mapMode === 'globe'
                ? projectPathToGlobe(COUNTRY_BORDER_PATH, globe)
                : projectPathToFlatCamera(COUNTRY_BORDER_PATH, camera),
            coastlines:
              mapMode === 'globe'
                ? projectPathToGlobe(COASTLINE_PATH, globe)
                : projectPathToFlatCamera(COASTLINE_PATH, camera),
          }
        : null,
    [
      mapMode,
      globe.centerLat,
      globe.centerLon,
      globe.radius,
      camera.x,
      camera.y,
      camera.zoom,
      camera.bearing,
      camera.pitch,
      flatPerspectiveCamera,
    ],
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
      <rect width="1000" height="560" fill={style.backgroundColor} onClick={backgroundClick} />
      {mapMode === 'flat' ? (
        <rect width="1000" height="560" fill={style.waterColor} onClick={backgroundClick} />
      ) : (
        <ellipse
          cx="500"
          cy="280"
          rx={globe.radius}
          ry={globe.radius}
          fill="url(#globe-water)"
          filter="url(#globe-shadow)"
          className="globe-shell"
          onClick={backgroundClick}
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
          {mapMode === 'flat' && !flatPerspectiveCamera && (
            <rect x="-1000" y="-1000" width="3000" height="2560" fill="url(#grid)" />
          )}
          {flatPerspectiveCamera && (
            <path
              d={projectPathToFlatCamera(flatGridPath(), camera)}
              fill="none"
              stroke={style.countryBorderColor}
              strokeOpacity=".12"
              strokeWidth=".6"
            />
          )}
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
                flatCamera={flatPerspectiveCamera}
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
                flatCamera={flatPerspectiveCamera}
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
                flatCamera={flatPerspectiveCamera}
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
                flatCamera={flatPerspectiveCamera}
              />
            ))}
          {layers
            .filter((l) => l.visible)
            .map((layer) => {
              const customIconUrl =
                layer.type === 'pin' && layer.pinCustomAssetId
                  ? assetUrls[layer.pinCustomAssetId]
                  : undefined;
              const imageUrl = layer.assetId ? assetUrls[layer.assetId] : undefined;
              return (
                <LayerGraphic
                  key={layer.id}
                  layer={layer}
                  selected={layer.id === selectedId}
                  onPointerDown={(event) => onLayerPointerDown?.(event, layer)}
                  assetUrl={customIconUrl ?? imageUrl}
                  globe={mapMode === 'globe' ? globe : undefined}
                  flatCamera={flatPerspectiveCamera}
                  screenScale={
                    mapMode === 'globe' ? globe.symbolScale : flatPerspectiveCamera ? 1 : 1 / camera.zoom
                  }
                  screenRotation={mapMode === 'globe' || flatPerspectiveCamera ? 0 : -bearing}
                  editorMode={editorMode}
                />
              );
            })}
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

function projectLayerPoint(x: number, y: number, globe?: GlobeProjection, flatCamera?: CameraState) {
  return globe
    ? projectPointToGlobe([x, y], globe)
    : flatCamera
      ? projectWorldToScreen(flatCamera, x, y)
      : { x, y };
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

function projectPathToFlatCamera(path: string, camera: CameraState) {
  return projectSvgPath(path, camera);
}

function flatGridPath() {
  const commands: string[] = [];
  for (let x = -1000; x <= 2000; x += 70) {
    commands.push(`M${x} -1000`);
    for (let y = -930; y <= 1560; y += 70) commands.push(`L${x} ${y}`);
  }
  for (let y = -1000; y <= 1560; y += 70) commands.push(`M-1000 ${y}L2000 ${y}`);
  return commands.join('');
}

function mapPlaneLocalTransform(camera: CameraState, x: number, y: number) {
  const origin = projectWorldToScreen(camera, x, y);
  const horizontal = projectWorldToScreen(camera, x + 1, y);
  const vertical = projectWorldToScreen(camera, x, y + 1);
  if (!origin || !horizontal || !vertical) return undefined;
  const a = horizontal.x - origin.x;
  const b = horizontal.y - origin.y;
  const c = vertical.x - origin.x;
  const d = vertical.y - origin.y;
  const e = origin.x - a * x - c * y;
  const f = origin.y - b * x - d * y;
  return `matrix(${round(a, 6)} ${round(b, 6)} ${round(c, 6)} ${round(d, 6)} ${round(e, 6)} ${round(f, 6)})`;
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
  flatCamera,
}: {
  country: (typeof COUNTRIES)[number];
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  opacity: number;
  scale?: number;
  letterSpacing?: number;
  globe?: GlobeProjection;
  flatCamera?: CameraState;
}) {
  const fa = country.nameFa || country.name;
  const flatLabel = flatCamera
    ? projectFlatMapLabel(flatCamera, country.label[0], country.label[1])
    : undefined;
  const point = flatCamera ? flatLabel : projectLayerPoint(country.label[0], country.label[1], globe);
  if (!point) return null;
  const sourceX = flatCamera ? 0 : point.x;
  const sourceY = flatCamera ? 0 : point.y;
  return (
    <text
      x={sourceX}
      y={sourceY}
      transform={flatLabel?.transform}
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
          <tspan x={sourceX} dy="-4" direction="rtl" unicodeBidi="plaintext">
            {fa}
          </tspan>
          <tspan x={sourceX} dy="9">
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
  flatCamera,
}: {
  label: MapLabel;
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  className: string;
  opacity: number;
  globe?: GlobeProjection;
  flatCamera?: CameraState;
}) {
  const text = language === 'fa' ? label.nameFa : label.name;
  const flatLabel = flatCamera ? projectFlatMapLabel(flatCamera, label.point[0], label.point[1]) : undefined;
  const point = flatCamera ? flatLabel : projectLayerPoint(label.point[0], label.point[1], globe);
  if (!point) return null;
  const sourceX = flatCamera ? 0 : point.x;
  const sourceY = flatCamera ? 0 : point.y;
  return (
    <text
      x={sourceX}
      y={sourceY}
      transform={flatLabel?.transform}
      fill={color}
      className={`${className} ${language === 'fa' ? 'persian-text' : ''}`}
      textAnchor="middle"
      direction={language === 'fa' ? 'rtl' : 'ltr'}
      unicodeBidi="plaintext"
      opacity={opacity}
    >
      {language === 'both' ? (
        <>
          <tspan x={sourceX} dy="-3" className="persian-text" direction="rtl">
            {label.nameFa}
          </tspan>
          <tspan x={sourceX} dy="8">
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
  flatCamera,
}: {
  label: MapLabel;
  language: Project['mapSettings']['labelLanguage'];
  color: string;
  opacity: number;
  globe?: GlobeProjection;
  flatCamera?: CameraState;
}) {
  const text = language === 'fa' ? label.nameFa : label.name;
  const shown = language === 'both' ? `${label.name} · ${label.nameFa}` : text;
  const flatLabel = flatCamera ? projectFlatMapLabel(flatCamera, label.point[0], label.point[1]) : undefined;
  const point = flatCamera ? flatLabel : projectLayerPoint(label.point[0], label.point[1], globe);
  if (!point) return null;
  const sourceX = flatCamera ? 0 : point.x;
  const sourceY = flatCamera ? 0 : point.y;
  return (
    <g
      className={`city-label ${label.capital ? 'capital-label' : ''}`}
      opacity={opacity}
      transform={flatLabel?.transform}
    >
      <circle cx={sourceX} cy={sourceY} r={label.capital ? 1.8 : 1.2} fill={color} />
      <text
        x={sourceX + 3}
        y={sourceY - 2}
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
interface PinBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Screen-space bounding box of a pin glyph, anchored so the stored
 * geographic point is the visual anchor: centered for point styles,
 * at the tip for pin shapes.
 */
const pinBounds = (style: PinStyle, s: number): PinBounds => {
  if (style === 'location' || style === 'map-pin')
    return { top: -1.35 * s, bottom: 0.05 * s, left: -0.85 * s, right: 0.85 * s };
  return { top: -s, bottom: s, left: -s, right: s };
};

const starPath = (s: number) => {
  const points: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? s : s * 0.42;
    const angle = -Math.PI / 2 + (Math.PI / 5) * i;
    points.push(`${(r * Math.cos(angle)).toFixed(3)} ${(r * Math.sin(angle)).toFixed(3)}`);
  }
  return `M ${points.join(' L ')} Z`;
};

const locationPinPath = (s: number) => {
  const r = 0.8 * s;
  const cy = -0.5 * s;
  const attach = -0.5 * s + Math.sqrt(r * r - 0.16 * s * s);
  return [
    `M 0 ${cy - r}`,
    `A ${r} ${r} 0 1 1 ${-0.001} ${cy - r}`,
    `M ${-0.4 * s} ${attach}`,
    `Q ${-0.06 * s} ${0.34 * s} 0 ${0.98 * s}`,
    `Q ${0.06 * s} ${0.34 * s} ${0.4 * s} ${attach}`,
    'Z',
  ].join(' ');
};

const mapPinPath = (s: number) => {
  const teardrop = locationPinPath(s);
  const holeR = 0.26 * s;
  const holeCy = -0.5 * s;
  return `${teardrop} M 0 ${holeCy} a ${holeR} ${holeR} 0 1 0 ${0.001} ${holeCy}`;
};

function PinGraphic({
  layer,
  selected,
  onPointerDown,
  point,
  screenScale,
  screenRotation,
  assetUrl,
  editorMode = false,
}: {
  layer: Layer;
  selected: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  point: { x: number; y: number };
  screenScale: number;
  screenRotation: number;
  assetUrl?: string;
  editorMode?: boolean;
}) {
  const style = pinStyleOf(layer);
  const size = pinSizeOf(layer);
  const popScale = layer.pinPopScale ?? 1;
  const dropOffsetY = layer.pinDropOffsetY ?? 0;
  const scale = screenScale * popScale;
  const fill = layer.color;
  const border = layer.pinBorderColor ?? PIN_DEFAULTS.borderColor;
  const borderWidth = layer.pinBorderWidth ?? PIN_DEFAULTS.borderWidth;
  const text = formatNumbers(layer.text ?? '', layer.numberStyle);
  const showLabel = (layer.pinLabelVisible ?? PIN_DEFAULTS.labelVisible) && text.length > 0;
  const labelSize = layer.pinLabelSize ?? PIN_DEFAULTS.labelSize;
  const labelColor = layer.pinLabelColor ?? PIN_DEFAULTS.labelColor;
  const labelOpacity = (layer.pinLabelOpacity ?? PIN_DEFAULTS.labelOpacity) * (layer.pinSceneOpacity ?? 1);
  const labelBorderColor = layer.pinLabelBorderColor ?? PIN_DEFAULTS.labelBorderColor;
  const labelBorderWidth = layer.pinLabelBorderWidth ?? PIN_DEFAULTS.labelBorderWidth;
  const bounds = pinBounds(style, size);
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const visualCenterX = style === 'custom' ? 0 : centerX;
  const visualCenterY = style === 'custom' ? (layer.pinCustomAnchor === 'center' ? 0 : -size) : centerY;
  const isPersian = resolveTextLanguage(layer.text ?? '', layer.textLanguage) === 'persian';
  const glyph = (() => {
    switch (style) {
      case 'map-pin':
        return (
          <path
            d={mapPinPath(size)}
            fill={fill}
            fillRule="evenodd"
            stroke={border}
            strokeWidth={borderWidth}
            strokeLinejoin="round"
          />
        );
      case 'location':
        return (
          <path
            d={locationPinPath(size)}
            fill={fill}
            stroke={border}
            strokeWidth={borderWidth}
            strokeLinejoin="round"
          />
        );
      case 'target':
        return (
          <>
            <circle r={size} fill="none" stroke={border} strokeWidth={Math.max(1.5, borderWidth)} />
            <circle r={size * 0.6} fill="none" stroke={fill} strokeWidth={Math.max(1.2, borderWidth * 0.8)} />
            <circle
              r={size * 0.26}
              fill={fill}
              stroke={border}
              strokeWidth={Math.max(1, borderWidth * 0.6)}
            />
          </>
        );
      case 'star':
        return (
          <path
            d={starPath(size)}
            fill={fill}
            stroke={border}
            strokeWidth={borderWidth}
            strokeLinejoin="round"
          />
        );
      case 'circle':
        return <circle r={size} fill={fill} fillOpacity=".9" stroke={border} strokeWidth={borderWidth} />;
      case 'custom':
        if (assetUrl) {
          // Render the custom icon image, anchored at bottom-center by default.
          // The geographic anchor is always the stored pin coordinate; the
          // image box is positioned relative to it and never re-projected.
          const anchor = layer.pinCustomAnchor ?? 'bottom-center';
          const imgW = size * 2;
          const imgH = size * 2;
          const imgX = -imgW / 2;
          const imgY = anchor === 'bottom-center' ? -imgH : -imgH / 2;
          const tintEnabled = layer.pinTintEnabled ?? false;
          const tintColor = layer.pinTintColor ?? PIN_DEFAULTS.tintColor;
          const filterId = `pin-tint-${layer.id}`;
          return (
            <>
              {tintEnabled && (
                <defs>
                  <filter id={filterId} colorInterpolationFilters="sRGB">
                    {/* Flat tint color masked by the image's own alpha… */}
                    <feFlood floodColor={tintColor} result="flood" />
                    <feComposite in="flood" in2="SourceGraphic" operator="in" result="tinted" />
                    {/* …multiplied with the original pixels (deterministic duotone). */}
                    <feComposite
                      in="tinted"
                      in2="SourceGraphic"
                      operator="arithmetic"
                      k1="1"
                      k2="0"
                      k3="0"
                      k4="0"
                    />
                  </filter>
                </defs>
              )}
              <image
                href={assetUrl}
                x={imgX}
                y={imgY}
                width={imgW}
                height={imgH}
                preserveAspectRatio="xMidYMid meet"
                pointerEvents="none"
                filter={tintEnabled ? `url(#${filterId})` : undefined}
              />
              {borderWidth > 0.5 && (
                <rect
                  x={imgX}
                  y={imgY}
                  width={imgW}
                  height={imgH}
                  rx={Math.max(1, imgW * 0.06)}
                  fill="none"
                  stroke={border}
                  strokeWidth={Math.max(0.5, borderWidth)}
                  pointerEvents="none"
                />
              )}
            </>
          );
        }
        // No image chosen yet: show a restrained editor-only placeholder so
        // the pin stays selectable on the canvas. It never renders in
        // Preview/Export (those paths render without editorMode).
        if (editorMode)
          return (
            <>
              <circle
                r={size}
                fill="none"
                stroke={fill}
                strokeWidth={Math.max(1, borderWidth * 0.5)}
                strokeDasharray="4 3"
              />
              <circle r={Math.max(1.5, size * 0.12)} fill={fill} />
            </>
          );
        return null;
      case 'dot':
      default:
        return (
          <>
            <circle r={size} fill={fill} stroke={border} strokeWidth={borderWidth} />
            <circle r={Math.max(2.2, size * 0.3)} fill="#17202d" />
          </>
        );
    }
  })();
  const labelOffset = pinLabelOffsetOf(layer);
  const label = showLabel ? (
    <text
      x={visualCenterX + labelOffset.x}
      y={visualCenterY + labelOffset.y}
      fill={labelColor}
      stroke={labelBorderColor}
      strokeWidth={labelBorderWidth}
      paintOrder="stroke fill"
      opacity={labelOpacity}
      className={`pin-label ${isPersian ? 'persian-text' : ''}`}
      style={{ fontSize: labelSize }}
      textAnchor="middle"
      dominantBaseline="central"
      direction={resolveTextDirection(layer.text ?? '', layer.textDirection)}
      unicodeBidi="plaintext"
    >
      {text}
    </text>
  ) : null;
  return (
    <g
      {...(() => {
        const { opacity: _opacity, ...props } = commonProps(layer, selected, onPointerDown);
        return props;
      })()}
    >
      <g
        transform={`translate(${point.x} ${point.y + dropOffsetY}) rotate(${screenRotation}) scale(${scale})`}
      >
        <g opacity={layer.opacity}>{glyph}</g>
        {label}
        {selected && (
          <g className="pin-selection" pointerEvents="none">
            <ellipse
              cx={centerX}
              cy={centerY}
              rx={(bounds.right - bounds.left) / 2 + 5}
              ry={(bounds.bottom - bounds.top) / 2 + 5}
              fill="none"
              stroke="#7fd4ff"
              strokeWidth="1.4"
              strokeDasharray="4 3"
              opacity=".95"
            />
            <circle cx={0} cy={0} r="2.4" fill="#7fd4ff" opacity=".95" />
          </g>
        )}
      </g>
    </g>
  );
}

const commonProps = (
  layer: Layer,
  selected: boolean,
  onPointerDown: (event: PointerEvent<SVGGElement>) => void,
) => ({
  opacity: layer.opacity,
  onPointerDown,
  className: `layer-graphic ${selected ? 'selected-layer' : ''}`,
});

function LayerGraphic({
  layer,
  selected,
  onPointerDown,
  assetUrl,
  globe,
  flatCamera,
  screenScale = 1,
  screenRotation = 0,
  editorMode = false,
}: {
  layer: Layer;
  selected: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  assetUrl?: string;
  globe?: GlobeProjection;
  flatCamera?: CameraState;
  screenScale?: number;
  screenRotation?: number;
  editorMode?: boolean;
}) {
  const common = {
    opacity: layer.opacity,
    onPointerDown,
    className: `layer-graphic ${selected ? 'selected-layer' : ''}`,
  };
  const point = projectLayerPoint(layer.x, layer.y, globe, flatCamera);
  const point2 =
    typeof layer.x2 === 'number' && typeof layer.y2 === 'number'
      ? projectLayerPoint(layer.x2, layer.y2, globe, flatCamera)
      : null;
  if (!point) return null;
  if (layer.type === 'region') {
    const country = findCountry(layer.countryId);
    const geometryPath = layer.regionGeometry
      ? (() => {
          const polygons =
            layer.regionGeometry.type === 'Polygon'
              ? [layer.regionGeometry.coordinates as number[][][]]
              : (layer.regionGeometry.coordinates as number[][][][]);
          return polygons
            .flatMap((polygon) => polygon)
            .map(
              (ring) =>
                ring
                  .map(
                    ([longitude, latitude], index) =>
                      `${index === 0 ? 'M' : 'L'}${((longitude + 180) / 360) * 1000} ${((90 - latitude) / 180) * 500}`,
                  )
                  .join('') + 'Z',
            )
            .join('');
        })()
      : undefined;
    const sourcePath = geometryPath ?? country?.path;
    const path = sourcePath
      ? globe
        ? projectPathToGlobe(sourcePath, globe)
        : flatCamera
          ? projectPathToFlatCamera(sourcePath, flatCamera)
          : sourcePath
      : undefined;
    if (!path) return null;
    return (
      <g {...common}>
        <path
          d={path}
          fill={layer.regionFillColor ?? layer.color}
          fillOpacity={layer.regionFillOpacity ?? 0.45}
          stroke={layer.regionStrokeColor ?? layer.color}
          strokeOpacity={layer.regionStrokeOpacity ?? 1}
          strokeWidth={layer.regionStrokeWidth ?? 3}
          fillRule="evenodd"
        />
        <text x={point.x} y={point.y + 28} fill={layer.color} textAnchor="middle" className="layer-caption">
          {layer.name}
        </text>
      </g>
    );
  }
  if (layer.type === 'pin')
    return (
      <PinGraphic
        layer={layer}
        selected={selected}
        onPointerDown={onPointerDown}
        point={point}
        screenScale={screenScale}
        screenRotation={screenRotation}
        assetUrl={assetUrl}
        editorMode={editorMode}
      />
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
      <g
        {...common}
        transform={flatCamera ? mapPlaneLocalTransform(flatCamera, layer.x, layer.y) : undefined}
      >
        <image
          href={assetUrl}
          x={flatCamera ? layer.x : point.x}
          y={flatCamera ? layer.y : point.y}
          width={(layer.width ?? 0) * (globe?.symbolScale ?? 1)}
          height={(layer.height ?? 0) * (globe?.symbolScale ?? 1)}
          preserveAspectRatio="xMidYMid meet"
        />
      </g>
    );
  if (layer.type === 'shape' || layer.type === 'image')
    return (
      <g
        {...common}
        transform={flatCamera ? mapPlaneLocalTransform(flatCamera, layer.x, layer.y) : undefined}
      >
        <rect
          x={flatCamera ? layer.x : point.x}
          y={flatCamera ? layer.y : point.y}
          width={(layer.width ?? 0) * (globe?.symbolScale ?? 1)}
          height={(layer.height ?? 0) * (globe?.symbolScale ?? 1)}
          rx="3"
          fill={layer.type === 'image' ? '#24364c' : layer.color}
          fillOpacity={layer.type === 'image' ? '.9' : '.25'}
          stroke={layer.color}
          strokeWidth="2"
        />
        <text
          x={(flatCamera ? layer.x : point.x) + ((layer.width ?? 0) * (globe?.symbolScale ?? 1)) / 2}
          y={(flatCamera ? layer.y : point.y) + ((layer.height ?? 0) * (globe?.symbolScale ?? 1)) / 2 + 4}
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
