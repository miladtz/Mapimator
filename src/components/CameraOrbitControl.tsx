import React, { useRef, type PointerEvent } from 'react';
import { clamp, MAX_CAMERA_PITCH, MIN_CAMERA_PITCH, normalizeBearing, roundCamera } from '../core/camera';
import { IDENTITY_QUATERNION, type CameraState, type MapMode } from '../core/project';

interface Props {
  camera: CameraState;
  mapMode: MapMode;
  disabled: boolean;
  onChange: (camera: CameraState) => void;
}

export function CameraOrbitControl({ camera, mapMode, disabled, onChange }: Props) {
  const ringRef = useRef<HTMLDivElement>(null);
  const bearing = normalizeBearing(camera.bearing);
  const pitch = clamp(camera.pitch ?? 0, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH);
  const setBearingAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = ringRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    onChange(roundCamera({ ...camera, bearing: normalizeBearing((Math.atan2(x, -y) * 180) / Math.PI) }));
  };
  const beginBearing = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setBearingAtPointer(event);
  };
  if (mapMode === 'globe')
    return (
      <div
        className="camera-orbit-control"
        data-map-wheel-exempt="true"
        data-map-mode="globe"
        aria-label="Globe camera orientation"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        style={{
          position: 'absolute',
          right: 14,
          bottom: 42,
          zIndex: 8,
          display: 'grid',
          gap: 6,
          width: 116,
          padding: 9,
          border: '1px solid rgba(145, 174, 204, .42)',
          borderRadius: 9,
          background: 'rgba(13, 24, 38, .88)',
          boxShadow: '0 8px 24px rgba(0,0,0,.24)',
          color: '#d9e8f7',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <span style={{ fontSize: 9, color: '#8fa8bf', textAlign: 'center' }}>CAMERA PITCH</span>
        <input
          aria-label="Pitch"
          title={`Pitch ${Math.round(pitch)}°`}
          type="range"
          min={MIN_CAMERA_PITCH}
          max={MAX_CAMERA_PITCH}
          step="1"
          value={pitch}
          disabled={disabled}
          onChange={(event) => onChange(roundCamera({ ...camera, pitch: Number(event.target.value) }))}
          style={{ width: '100%', accentColor: '#58c9f3' }}
        />
        <span style={{ fontSize: 10, textAlign: 'center' }}>P {Math.round(pitch)}°</span>
        <button
          type="button"
          disabled={disabled}
          title="Reset physical Globe orientation without changing Pitch or Zoom"
          onClick={(event) => {
            event.stopPropagation();
            onChange(
              roundCamera({
                ...camera,
                globeOrientation: { ...IDENTITY_QUATERNION },
                globeFocus: { x: 1, y: 0, z: 0 },
              }),
            );
          }}
          style={{
            minHeight: 24,
            padding: '2px 7px',
            border: '1px solid #47647f',
            borderRadius: 4,
            background: '#182b40',
            color: '#d9e8f7',
            fontSize: 10,
          }}
        >
          Reset Globe
        </button>
        <button
          type="button"
          disabled={disabled || pitch === 0}
          onClick={() => onChange(roundCamera({ ...camera, pitch: 0 }))}
          style={{
            minHeight: 22,
            border: '1px solid #38536d',
            borderRadius: 4,
            background: '#132438',
            color: '#a9bfd3',
            fontSize: 9,
          }}
        >
          Reset Pitch
        </button>
      </div>
    );
  return (
    <div
      className="camera-orbit-control"
      data-map-wheel-exempt="true"
      data-map-mode={mapMode}
      aria-label="Flat camera orientation"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 42,
        zIndex: 8,
        display: 'grid',
        gridTemplateColumns: '68px 28px',
        gap: 7,
        alignItems: 'center',
        padding: 8,
        border: '1px solid rgba(145, 174, 204, .42)',
        borderRadius: 9,
        background: 'rgba(13, 24, 38, .88)',
        boxShadow: '0 8px 24px rgba(0,0,0,.24)',
        color: '#d9e8f7',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div
        ref={ringRef}
        role="slider"
        aria-label="Bearing"
        aria-valuemin={-180}
        aria-valuemax={180}
        aria-valuenow={Math.round(bearing)}
        title={`Bearing ${Math.round(bearing)}°`}
        onPointerDown={beginBearing}
        onPointerMove={(event) => {
          if (!disabled && event.currentTarget.hasPointerCapture(event.pointerId)) setBearingAtPointer(event);
        }}
        style={{ position: 'relative', width: 66, height: 66, cursor: disabled ? 'default' : 'crosshair' }}
      >
        <svg viewBox="0 0 66 66" width="66" height="66" aria-hidden="true">
          <circle cx="33" cy="33" r="28" fill="#132438" stroke="#6785a2" strokeWidth="1.2" />
          <text x="33" y="11" textAnchor="middle" fill="#f2c96d" fontSize="8" fontWeight="700">
            N
          </text>
          <text x="56" y="36" textAnchor="middle" fill="#7f9ab4" fontSize="7">
            E
          </text>
          <text x="33" y="60" textAnchor="middle" fill="#7f9ab4" fontSize="7">
            S
          </text>
          <text x="10" y="36" textAnchor="middle" fill="#7f9ab4" fontSize="7">
            W
          </text>
          <g transform={`rotate(${bearing} 33 33)`}>
            <path d="M33 14 L37 31 L33 35 L29 31 Z" fill="#58c9f3" />
            <circle cx="33" cy="33" r="3.2" fill="#dcecf9" />
          </g>
        </svg>
      </div>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 3 }}>
        <span style={{ fontSize: 8, color: '#8fa8bf' }}>+85</span>
        <input
          aria-label="Pitch"
          title={`Pitch ${Math.round(pitch)}°`}
          type="range"
          min={MIN_CAMERA_PITCH}
          max={MAX_CAMERA_PITCH}
          step="1"
          value={pitch}
          disabled={disabled}
          onChange={(event) => onChange(roundCamera({ ...camera, pitch: Number(event.target.value) }))}
          style={{
            width: 48,
            height: 18,
            transform: 'rotate(-90deg)',
            margin: '15px 0',
            accentColor: '#58c9f3',
          }}
        />
        <span style={{ fontSize: 8, color: '#8fa8bf' }}>−85</span>
      </div>
      <button
        type="button"
        disabled={disabled}
        title="Reset Bearing and Pitch"
        onClick={(event) => {
          event.stopPropagation();
          onChange(roundCamera({ ...camera, bearing: 0, pitch: 0 }));
        }}
        style={{
          gridColumn: '1 / -1',
          minHeight: 24,
          padding: '2px 7px',
          border: '1px solid #47647f',
          borderRadius: 4,
          background: '#182b40',
          color: '#d9e8f7',
          fontSize: 10,
        }}
      >
        Reset orientation · B {Math.round(bearing)}° · P {Math.round(pitch)}°
      </button>
    </div>
  );
}
