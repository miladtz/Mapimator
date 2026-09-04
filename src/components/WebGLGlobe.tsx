import React, { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { applyCameraWheel, roundCamera } from '../core/camera';
import {
  cameraWithTargetLonLat,
  conjugateQuaternion,
  globeScreenContact,
  globeOrientationOf,
  globeFocusOf,
  intersectGlobeScreenRay,
  lonLatToWorld,
  multiplyQuaternions,
  projectGlobeLonLat,
  quaternionBetweenVectors,
  rotateVector,
  sphereToLonLat,
  worldToLonLat,
  type GlobeCameraMatrices,
  type Vec3,
} from '../core/globeMath';
import { GlobeWebGLRenderer } from '../core/globeRenderer';
import { selectMapLabels } from '../core/mapLabels';
import { pinSizeOf, type CameraState, type Layer, type MapStylePreset, type Project } from '../core/project';
import { arrowHeadCoordinates, evaluatedShapeCoordinates } from '../core/shapes';

interface Props {
  style: MapStylePreset;
  layers: Layer[];
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  interactionEnabled: boolean;
  labelLanguage: Project['mapSettings']['labelLanguage'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveLayer: (id: string, x: number, y: number) => void;
  onBackgroundClick?: (point: { x: number; y: number }) => void;
}

interface Size {
  width: number;
  height: number;
}

export function WebGLGlobe({
  style,
  layers,
  camera,
  onCameraChange,
  interactionEnabled,
  labelLanguage,
  selectedId,
  onSelect,
  onMoveLayer,
  onBackgroundClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlobeWebGLRenderer | null>(null);
  const frameRef = useRef<number | null>(null);
  const interactionFrameRef = useRef<number | null>(null);
  const pendingInteractionCameraRef = useRef<CameraState | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    camera: CameraState;
    layerId?: string;
    frozenMatrices?: GlobeCameraMatrices;
    startObjectContact?: Vec3;
    startWorldContact?: Vec3;
  } | null>(null);
  const cameraRef = useRef(camera);
  const styleRef = useRef(style);
  const [size, setSize] = useState<Size>({ width: 1000, height: 560 });
  const [rendererError, setRendererError] = useState<string | null>(null);
  const firstDrawLoggedRef = useRef(false);
  cameraRef.current = camera;
  styleRef.current = style;

  const emitInteractionCamera = useCallback(
    (next: CameraState) => {
      pendingInteractionCameraRef.current = next;
      if (interactionFrameRef.current !== null) return;
      interactionFrameRef.current = requestAnimationFrame(() => {
        interactionFrameRef.current = null;
        const pending = pendingInteractionCameraRef.current;
        pendingInteractionCameraRef.current = null;
        if (pending) onCameraChange(pending);
      });
    },
    [onCameraChange],
  );

  const render = useCallback(() => {
    frameRef.current = null;
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      renderer.render(cameraRef.current, styleRef.current);
      setRendererError(null);
      if (import.meta.env.DEV && !firstDrawLoggedRef.current) {
        firstDrawLoggedRef.current = true;
        console.info('[Globe] first draw', {
          clientWidth: canvasRef.current?.clientWidth ?? 0,
          clientHeight: canvasRef.current?.clientHeight ?? 0,
          devicePixelRatio: window.devicePixelRatio,
          ...renderer.diagnostics(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRendererError(message);
      if (import.meta.env.DEV) console.error('[Globe] render failed', message, renderer.diagnostics());
    }
  }, []);
  const scheduleRender = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(render);
  }, [render]);
  const forceRender = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      return {
        width: Math.max(2, Math.round(rect.width * ratio)),
        height: Math.max(2, Math.round(rect.height * ratio)),
      };
    };
    const create = () => {
      try {
        rendererRef.current?.dispose();
        const measured = measure();
        canvas.width = measured.width;
        canvas.height = measured.height;
        setSize(measured);
        rendererRef.current = new GlobeWebGLRenderer(canvas);
        setRendererError(null);
        forceRender();
      } catch (error) {
        rendererRef.current = null;
        const message = error instanceof Error ? error.message : String(error);
        setRendererError(message);
        if (import.meta.env.DEV) console.error('[Globe] initialization failed', message);
      }
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      rendererRef.current = null;
    };
    const onRestored = () => create();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    create();
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const measured = measure();
      const changed = rendererRef.current?.resize(measured.width, measured.height) ?? false;
      setSize(measured);
      if (changed) forceRender();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (interactionFrameRef.current !== null) cancelAnimationFrame(interactionFrameRef.current);
      interactionFrameRef.current = null;
      pendingInteractionCameraRef.current = null;
      dragRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [forceRender]);
  useEffect(scheduleRender, [camera, style, scheduleRender]);

  const localPoint = (clientX: number, clientY: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * size.width,
      y: ((clientY - rect.top) / rect.height) * size.height,
    };
  };
  const surfacePoint = (clientX: number, clientY: number) => {
    const point = localPoint(clientX, clientY);
    const matrices = rendererRef.current?.matrices;
    return point && matrices ? intersectGlobeScreenRay(matrices, point.x, point.y) : null;
  };
  const commitSurface = (clientX: number, clientY: number, layerId?: string) => {
    const hit = surfacePoint(clientX, clientY);
    if (!hit) return;
    const point = lonLatToWorld(hit.lon, hit.lat);
    if (layerId) onMoveLayer(layerId, point.x, point.y);
    else onBackgroundClick?.(point);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactionEnabled || event.button !== 0) return;
    const layerId = (event.target as Element).closest<SVGElement>('[data-layer-id]')?.dataset.layerId;
    if (layerId) onSelect(layerId);
    else onSelect(null);
    const point = localPoint(event.clientX, event.clientY);
    const matrices = rendererRef.current?.matrices;
    const contact =
      !layerId && point && matrices ? globeScreenContact(matrices, point.x, point.y, false) : null;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera: cameraRef.current,
      layerId,
      ...(matrices && contact
        ? {
            frozenMatrices: {
              ...matrices,
              viewProjection: new Float32Array(matrices.viewProjection),
              inverseViewProjection: new Float32Array(matrices.inverseViewProjection),
              orientation: { ...matrices.orientation },
            },
            startObjectContact: contact.object,
            startWorldContact: contact.world,
          }
        : {}),
    };
    event.currentTarget.style.cursor = 'grabbing';
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.layerId) {
      commitSurface(event.clientX, event.clientY, drag.layerId);
      return;
    }
    const point = localPoint(event.clientX, event.clientY);
    if (!point || !drag.frozenMatrices || !drag.startObjectContact || !drag.startWorldContact) return;
    const current = globeScreenContact(drag.frozenMatrices, point.x, point.y, true);
    if (!current) return;
    const delta = quaternionBetweenVectors(drag.startWorldContact, current.world);
    // World-space contact delta premultiplies the fixed pointer-down object orientation.
    const globeOrientation = multiplyQuaternions(delta, globeOrientationOf(drag.camera));
    const globeFocus = rotateVector(conjugateQuaternion(globeOrientation), drag.frozenMatrices.target);
    emitInteractionCamera(
      roundCamera({
        ...drag.camera,
        globeOrientation,
        globeFocus: { x: globeFocus[0], y: globeFocus[1], z: globeFocus[2] },
      }),
    );
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.layerId && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3)
      commitSurface(event.clientX, event.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.style.cursor = interactionEnabled ? 'grab' : 'default';
    dragRef.current = null;
  };
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactionEnabled) return;
    event.preventDefault();
    onCameraChange(applyCameraWheel(cameraRef.current, 'globe', -240, 0, false, false).camera);
  };

  return (
    <div
      ref={hostRef}
      className="webgl-globe"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        touchAction: 'none',
        cursor: interactionEnabled ? 'grab' : 'default',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={onDoubleClick}
      tabIndex={0}
    >
      <canvas
        ref={canvasRef}
        aria-label="Offline WebGL globe"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      <GlobeOverlay
        width={size.width}
        height={size.height}
        renderer={rendererRef.current}
        camera={camera}
        style={style}
        layers={layers}
        labelLanguage={labelLanguage}
        selectedId={selectedId}
      />
      {rendererError ? (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            padding: 24,
            color: '#f1f5f9',
            background: '#101a2a',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <span>
            Globe renderer unavailable.
            {import.meta.env.DEV ? ` ${rendererError}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export interface GlobeOverlayProps {
  width: number;
  height: number;
  renderer: GlobeWebGLRenderer | null;
  camera: CameraState;
  style: MapStylePreset;
  layers: Layer[];
  labelLanguage: Project['mapSettings']['labelLanguage'];
  selectedId: string | null;
}

export function GlobeOverlay({
  width,
  height,
  renderer,
  camera,
  style,
  layers,
  labelLanguage,
  selectedId,
}: GlobeOverlayProps) {
  const labels = useMemo(() => {
    const center = sphereToLonLat(globeFocusOf(camera));
    return selectMapLabels(cameraWithTargetLonLat(camera, center.lon, center.lat));
  }, [camera]);
  const matrices = renderer?.matrices;
  const projectPoint = (point: [number, number]) => {
    if (!matrices) return null;
    const { lon, lat } = worldToLonLat(point[0], point[1]);
    return projectGlobeLonLat(matrices, lon, lat);
  };
  const text = (item: { name: string; nameFa: string }) =>
    labelLanguage === 'fa'
      ? item.nameFa
      : labelLanguage === 'both'
        ? `${item.name} / ${item.nameFa}`
        : item.name;
  const labelNodes = [
    ...labels.continents.map((entry) => ({ ...entry, kind: 'continent' as const, point: entry.item.point })),
    ...labels.oceans.map((entry) => ({ ...entry, kind: 'ocean' as const, point: entry.item.point })),
    ...labels.countries.map((entry) => ({ ...entry, kind: 'country' as const, point: entry.item.label })),
    ...labels.capitals.map((entry) => ({ ...entry, kind: 'capital' as const, point: entry.item.point })),
    ...labels.cities.map((entry) => ({ ...entry, kind: 'city' as const, point: entry.item.point })),
  ];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {labelNodes.map((entry) => {
        const point = projectPoint(entry.point);
        if (!point || labelLanguage === 'none') return null;
        const base =
          entry.kind === 'continent' ? 16 : entry.kind === 'ocean' ? 13 : entry.kind === 'country' ? 11 : 9;
        return (
          <text
            key={`${entry.kind}-${entry.item.id}`}
            x={point.x}
            y={point.y}
            fill={
              entry.kind === 'ocean'
                ? style.physicalLabelColor
                : entry.kind === 'continent'
                  ? style.continentLabelColor
                  : style.countryLabelColor
            }
            opacity={entry.opacity}
            fontFamily="Inter, Vazirmatn, sans-serif"
            fontSize={base * (entry.scale ?? 1) * Math.max(1, width / 1000)}
            fontStyle={entry.kind === 'ocean' ? 'italic' : undefined}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ direction: labelLanguage === 'fa' ? 'rtl' : 'ltr' }}
          >
            {text(entry.item)}
          </text>
        );
      })}
      {layers
        .filter((layer) => layer.visible && layer.type === 'shape')
        .map((layer) => {
          const rendered = evaluatedShapeCoordinates(layer);
          const projected = rendered.coordinates.map((coordinate) => projectPoint(coordinate));
          if (projected.some((coordinate) => coordinate === null)) return null;
          const visible = projected as Array<{ x: number; y: number }>;
          if (visible.length < 2) return null;
          const path = `${visible
            .map((coordinate, index) => `${index === 0 ? 'M' : 'L'}${coordinate.x} ${coordinate.y}`)
            .join(' ')}${rendered.closed ? ' Z' : ''}`;
          const head =
            layer.shapeKind === 'arrow'
              ? arrowHeadCoordinates(layer).map((coordinate) => projectPoint(coordinate))
              : [];
          const headPath =
            head.length === 3 && head.every(Boolean)
              ? `${(head as Array<{ x: number; y: number }>).map((coordinate, index) => `${index ? 'L' : 'M'}${coordinate.x} ${coordinate.y}`).join(' ')} Z`
              : '';
          return (
            <g key={layer.id} data-layer-id={layer.id}>
              <path
                d={path}
                fill={rendered.closed ? (layer.shapeFillColor ?? layer.color) : 'none'}
                fillOpacity={rendered.closed ? (layer.shapeFillOpacity ?? 0.25) * layer.opacity : 0}
                stroke={layer.shapeStrokeColor ?? layer.color}
                strokeOpacity={(layer.shapeStrokeOpacity ?? 1) * layer.opacity}
                strokeWidth={(layer.shapeStrokeWidth ?? 3) * Math.max(1, width / 1000)}
                strokeDasharray={
                  layer.shapeStrokeStyle === 'dashed'
                    ? '9 6'
                    : layer.shapeStrokeStyle === 'dotted'
                      ? '1 6'
                      : undefined
                }
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {headPath && (
                <path
                  d={headPath}
                  fill={layer.shapeStrokeColor ?? layer.color}
                  fillOpacity={(layer.shapeStrokeOpacity ?? 1) * layer.opacity}
                />
              )}
            </g>
          );
        })}
      {layers
        .filter((layer) => layer.visible && ['pin', 'text', 'geo-effect'].includes(layer.type))
        .map((layer) => {
          const point = projectPoint([layer.x, layer.y]);
          if (!point) return null;
          const size = layer.type === 'pin' ? pinSizeOf(layer) : (layer.effectSize ?? 18);
          return (
            <g
              key={layer.id}
              data-layer-id={layer.id}
              transform={`translate(${point.x} ${point.y})`}
              opacity={layer.opacity}
              style={{ pointerEvents: 'all', cursor: 'grab' }}
            >
              {layer.type === 'text' ? (
                <text
                  fill={layer.color}
                  fontFamily="Inter, Vazirmatn, sans-serif"
                  fontSize={(layer.fontSize ?? 24) * Math.max(1, width / 1000)}
                  textAnchor="middle"
                  style={{ direction: layer.textDirection === 'rtl' ? 'rtl' : undefined }}
                >
                  {layer.text}
                </text>
              ) : (
                <>
                  <circle
                    r={size * Math.max(1, width / 1000)}
                    fill={layer.color}
                    stroke={layer.id === selectedId ? '#fff' : '#17202d'}
                    strokeWidth={layer.id === selectedId ? 3 : 1.5}
                  />
                  {layer.type === 'pin' && layer.pinLabelVisible !== false && layer.text ? (
                    <text
                      y={-size - 7}
                      fill={layer.pinLabelColor ?? layer.color}
                      fontFamily="Inter, Vazirmatn, sans-serif"
                      fontSize={(layer.pinLabelSize ?? 13) * Math.max(1, width / 1000)}
                      textAnchor="middle"
                    >
                      {layer.text}
                    </text>
                  ) : null}
                </>
              )}
            </g>
          );
        })}
    </svg>
  );
}
