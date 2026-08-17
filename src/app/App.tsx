import { useEffect, useMemo, useState } from 'react';
import { OfflineMap } from '../components/OfflineMap';
import { browserFileSystemAdapter } from '../core/adapters';
import {
  MAP_STYLES,
  CANVAS_LAYOUTS,
  createLayer,
  createProject,
  createView,
  layerLabel,
  type AppLanguage,
  type CameraState,
  type GeoEffectType,
  type Layer,
  type LayerType,
  type Project,
  type View,
} from '../core/project';
import { t } from '../core/i18n';
import { compileViews, evaluateProjectAtTime } from '../core/viewCompiler';
import { autoReframe } from '../core/layout';

const layerTypes: LayerType[] = ['pin', 'route', 'text', 'image', 'shape', 'region', 'arrow', 'geo-effect'];
const icons: Record<LayerType, string> = {
  region: '▰',
  pin: '●',
  text: 'T',
  shape: '◇',
  arrow: '➜',
  image: '▧',
  route: '⌁',
  'geo-effect': '✦',
};
const geoEffectCycle: { type: GeoEffectType; name: string }[] = [
  { type: 'impact-pulse', name: 'Impact pulse' },
  { type: 'strike-marker', name: 'Strike marker' },
  { type: 'smoke-plume', name: 'Smoke plume' },
  { type: 'missile-arc', name: 'Missile arc' },
  { type: 'front-line', name: 'Front line' },
  { type: 'territory-expansion', name: 'Territory expansion' },
  { type: 'hotspot', name: 'Hotspot' },
  { type: 'control-zone', name: 'Control zone' },
  { type: 'refugee-flow', name: 'Refugee flow' },
  { type: 'blockade-line', name: 'Blockade line' },
  { type: 'disputed-border', name: 'Disputed border' },
  { type: 'influence-zone', name: 'Influence zone' },
];
export function App() {
  const [project, setProject] = useState<Project>(() => createProject('Untitled documentary'));
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [notice, setNotice] = useState('Offline map data loaded');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const words = t(language);
  const style = MAP_STYLES.find((item) => item.id === project.mapSettings.styleId)!;
  const selected = project.layers.find((l) => l.id === selectedId) ?? null;
  const visibleLayers = useMemo(
    () => project.layers.filter((l) => l.name.toLowerCase().includes(search.toLowerCase())),
    [project.layers, search],
  );
  const sequence = useMemo(() => compileViews(project.views), [project.views]);
  const previewState = previewTime === null ? null : evaluateProjectAtTime(project, previewTime);
  useEffect(() => {
    if (previewTime === null) return;
    const startedAt = performance.now() - previewTime * 1000;
    let frame = 0;
    const tick = () => {
      const next = (performance.now() - startedAt) / 1000;
      if (next >= sequence.duration) {
        setPreviewTime(null);
        return;
      }
      setPreviewTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewTime === null, sequence.duration]);
  const updateProject = (fn: (p: Project) => Project) => setProject(fn);
  const updateLayer = (id: string, patch: Partial<Layer>) =>
    updateProject((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  const addLayer = (type: LayerType) => {
    const layer = createLayer(type, project.layers.length);
    if (type === 'geo-effect') {
      const effect =
        geoEffectCycle[project.layers.filter((l) => l.type === 'geo-effect').length % geoEffectCycle.length];
      layer.geoEffectType = effect.type;
      layer.name = effect.name;
    }
    updateProject((p) => ({ ...p, layers: [...p.layers, layer] }));
    setSelectedId(layer.id);
    setNotice(`${layer.name} added`);
  };
  const save = async () => {
    const next = {
      ...project,
      metadata: { ...project.metadata, updatedAt: new Date().toISOString() },
    };
    await browserFileSystemAdapter.saveProject(next);
    setProject(next);
    setNotice(words.saved);
  };
  const open = async () => {
    const saved = await browserFileSystemAdapter.openProject();
    if (saved) {
      setProject(saved);
      setSelectedId(null);
      setNotice(words.opened);
    } else setNotice('No saved local project yet');
  };
  const duplicate = () => {
    if (!selected) return;
    const layer = {
      ...selected,
      id: `${selected.type}-${crypto.randomUUID()}`,
      name: `${selected.name} copy`,
      x: selected.x + 22,
      y: selected.y + 18,
    };
    updateProject((p) => ({ ...p, layers: [...p.layers, layer] }));
    setSelectedId(layer.id);
  };
  const remove = () => {
    if (!selected) return;
    updateProject((p) => ({
      ...p,
      layers: p.layers.filter((l) => l.id !== selected.id),
    }));
    setSelectedId(null);
  };
  const move = (direction: -1 | 1) => {
    if (!selected) return;
    updateProject((p) => {
      const i = p.layers.findIndex((l) => l.id === selected.id);
      const j = Math.max(0, Math.min(p.layers.length - 1, i + direction));
      const layers = [...p.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...p, layers };
    });
  };
  const addView = () => {
    const view = createView(`View ${project.views.length + 1}`, project.layers, camera);
    updateProject((p) => ({ ...p, views: [...p.views, view] }));
    setActiveViewId(view.id);
    setNotice(`${view.name} captured`);
  };
  const activateView = (id: string) => {
    const view = project.views.find((v) => v.id === id);
    if (!view) return;
    setActiveViewId(id);
    setCamera(view.camera);
    updateProject((p) => ({ ...p, layers: structuredClone(view.layers) }));
    setSelectedId(null);
    setNotice(`${view.name} previewed`);
  };
  const updateView = () => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((v) =>
        v.id === activeViewId ? { ...v, camera: { ...camera }, layers: structuredClone(p.layers) } : v,
      ),
    }));
    setNotice('View updated — project not saved yet');
  };
  const duplicateView = () => {
    const source = project.views.find((v) => v.id === activeViewId);
    if (!source) return addView();
    const view = {
      ...structuredClone(source),
      id: `view-${crypto.randomUUID()}`,
      name: `${source.name} copy`,
    };
    updateProject((p) => ({ ...p, views: [...p.views, view] }));
    setActiveViewId(view.id);
  };
  const renameView = () => {
    const source = project.views.find((v) => v.id === activeViewId);
    if (!source) return;
    const name = window.prompt('View name', source.name)?.trim();
    if (name)
      updateProject((p) => ({
        ...p,
        views: p.views.map((v) => (v.id === source.id ? { ...v, name } : v)),
      }));
  };
  const deleteView = () => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.filter((v) => v.id !== activeViewId),
    }));
    setActiveViewId(null);
  };
  const updateTransition = (
    patch: Partial<Pick<View, 'holdDuration' | 'transitionDuration' | 'transitionPreset'>>,
  ) => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((v) => (v.id === activeViewId ? { ...v, ...patch } : v)),
    }));
  };
  const setCanvasLayout = (layoutId: Project['canvas']['layoutId']) => {
    if (layoutId === 'custom') {
      const width = Number(window.prompt('Canvas width', String(project.canvas.width)));
      const height = Number(window.prompt('Canvas height', String(project.canvas.height)));
      if (width > 0 && height > 0)
        updateProject((p) => ({ ...p, canvas: { ...p.canvas, layoutId, width, height } }));
      return;
    }
    const layout = CANVAS_LAYOUTS.find((item) => item.id === layoutId);
    if (!layout) return;
    updateProject((p) => ({
      ...p,
      canvas: {
        ...p.canvas,
        layoutId,
        width: layout.width,
        height: layout.height,
        safeArea: layout.safeArea,
      },
    }));
    setNotice(`${layout.name} selected`);
  };
  const reframe = () => {
    const layout = CANVAS_LAYOUTS.find((item) => item.id === project.canvas.layoutId);
    if (!layout) return;
    setCamera(autoReframe(project.layers, camera, layout));
    setNotice('Auto Reframe applied');
  };
  return (
    <main className="studio" dir={language === 'fa' ? 'rtl' : 'ltr'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>MAPMOTION</span>
          <small>STUDIO</small>
        </div>
        <div className="project-title">
          <span className="eyebrow">PROJECT</span>
          <strong>{project.metadata.name}</strong>
        </div>
        <div className="top-actions">
          <button
            className="quiet"
            onClick={() => {
              setProject(createProject('Untitled documentary'));
              setSelectedId(null);
            }}
          >
            {words.new}
          </button>
          <button className="quiet" onClick={open}>
            {words.open}
          </button>
          <button className="primary" onClick={save}>
            {words.save}
          </button>
          <button className="export" disabled>
            {words.export}
          </button>
          <button className="lang" onClick={() => setLanguage((l) => (l === 'en' ? 'fa' : 'en'))}>
            {language === 'en' ? 'فا' : 'EN'}
          </button>
        </div>
      </header>
      <section className="workspace">
        <aside className="panel left-panel">
          <div className="panel-heading">
            <span>{words.project}</span>
            <span className="status-dot" />
          </div>
          <div className="project-card">
            <div className="mini-map">◇</div>
            <div>
              <strong>{project.metadata.name}</strong>
              <small>1920 × 1080 · {project.canvas.fps} FPS</small>
            </div>
          </div>
          <div className="panel-heading layers-heading">
            <span>{words.layers}</span>
            <span className="layer-count">{project.layers.length}</span>
          </div>
          <input
            className="search"
            placeholder={words.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="layer-list">
            {visibleLayers.length ? (
              visibleLayers.map((layer) => (
                <button
                  key={layer.id}
                  className={`layer-row ${selectedId === layer.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(layer.id)}
                >
                  <span className="layer-icon">{icons[layer.type]}</span>
                  <span className="layer-row-name">
                    <strong>{layer.name}</strong>
                    <small>{layerLabel[layer.type].toUpperCase()}</small>
                  </span>
                  <span className="row-status">{layer.locked ? '▣' : layer.visible ? '◉' : '○'}</span>
                </button>
              ))
            ) : (
              <div className="empty-state">
                <span className="empty-icon">▱</span>
                <strong>No layers yet</strong>
                <p>Add a tool from the map canvas.</p>
              </div>
            )}
          </div>
        </aside>
        <section className="canvas-column">
          <div className="canvas-head">
            <div>
              <span className="eyebrow">{words.map}</span>
              <span className="map-status">● {notice}</span>
            </div>
            <div className="style-switch">
              <select
                aria-label="Map label language"
                value={project.mapSettings.labelLanguage}
                onChange={(e) =>
                  updateProject((p) => ({
                    ...p,
                    mapSettings: {
                      ...p.mapSettings,
                      labelLanguage: e.target.value as Project['mapSettings']['labelLanguage'],
                    },
                  }))
                }
              >
                <option value="en">EN labels</option>
                <option value="fa">فا labels</option>
                <option value="both">EN + فا</option>
                <option value="none">No labels</option>
              </select>
              <button
                className={style.id === 'documentary-dark' ? 'active' : ''}
                onClick={() =>
                  updateProject((p) => ({
                    ...p,
                    mapSettings: {
                      ...p.mapSettings,
                      styleId: 'documentary-dark',
                    },
                  }))
                }
              >
                {words.dark}
              </button>
              <button
                className={style.id === 'documentary-light' ? 'active' : ''}
                onClick={() =>
                  updateProject((p) => ({
                    ...p,
                    mapSettings: {
                      ...p.mapSettings,
                      styleId: 'documentary-light',
                    },
                  }))
                }
              >
                {words.light}
              </button>
            </div>
            <div className="layout-controls">
              <select
                aria-label="Canvas layout"
                value={project.canvas.layoutId}
                onChange={(e) => setCanvasLayout(e.target.value as Project['canvas']['layoutId'])}
              >
                {CANVAS_LAYOUTS.map((layout) => (
                  <option key={layout.id} value={layout.id}>
                    {layout.name}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              <button onClick={reframe}>Auto Reframe</button>
              <label>
                <input
                  aria-label="Show safe area"
                  type="checkbox"
                  checked={project.canvas.showSafeArea}
                  onChange={(e) =>
                    updateProject((p) => ({ ...p, canvas: { ...p.canvas, showSafeArea: e.target.checked } }))
                  }
                />{' '}
                Safe
              </label>
            </div>
          </div>
          <div className="map-frame">
            <OfflineMap
              style={style}
              layers={previewState?.layers ?? project.layers}
              camera={previewState?.camera ?? camera}
              onCameraChange={previewTime === null ? setCamera : () => {}}
              labelLanguage={project.mapSettings.labelLanguage}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMoveLayer={(id, x, y) => updateLayer(id, { x, y })}
              safeArea={project.canvas.safeArea}
              showSafeArea={project.canvas.showSafeArea}
            />
            <div className="add-toolbar">
              {layerTypes.map((type) => (
                <button key={type} onClick={() => addLayer(type)} title={`Add ${layerLabel[type]}`}>
                  <b>{icons[type]}</b>
                  {layerLabel[type]}
                </button>
              ))}
            </div>
            <div className="map-hint">{words.panZoom}</div>
          </div>
          <div className="preview-bar">
            <button
              className="play"
              onClick={() => setPreviewTime(previewTime === null ? 0 : null)}
              disabled={project.views.length < 2}
            >
              {previewTime === null ? '▶ Preview' : '■ Stop'}
            </button>
            <span>
              {previewTime !== null
                ? `Previewing View ${previewState!.activeViewIndex + 1} · ${previewState!.transitionProgress < 1 ? 'transition' : 'hold'}`
                : activeViewId
                  ? 'Edit scene, then Update View'
                  : 'Create a View to capture this scene'}
            </span>
            <button
              className="update-view"
              onClick={updateView}
              disabled={!activeViewId || previewTime !== null}
            >
              Update View
            </button>
          </div>
        </section>
        <aside className="panel right-panel">
          <div className="panel-heading">
            <span>{words.properties}</span>
          </div>
          {selected ? (
            <Inspector
              layer={selected}
              onChange={(patch) => updateLayer(selected.id, patch)}
              onDuplicate={duplicate}
              onRemove={remove}
              onMove={move}
            />
          ) : (
            <div className="inspector">
              <span className="inspector-icon">◌</span>
              <strong>Nothing selected</strong>
              <p>Select a Layer on the canvas or in the Project Layers panel.</p>
              <hr />
              <div className="foundation">
                <span>PHASE 2</span>
                <p>Static Layers are ready</p>
                <p>Use the Add toolbar to begin composing your map.</p>
              </div>
            </div>
          )}
        </aside>
      </section>
      <footer className="views-strip">
        <div className="views-title">
          <span>{words.views}</span>
          <small>Scenes, not keyframes</small>
        </div>
        <div className="view-cards">
          {project.views.map((view, index) => (
            <button
              key={view.id}
              className={`view-card ${activeViewId === view.id ? 'active' : ''}`}
              onClick={() => activateView(view.id)}
            >
              <span className="view-thumb" style={{ background: view.thumbnailColor }}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <strong>{view.name}</strong>
              <small>
                {view.holdDuration.toFixed(1)}s hold · {view.transitionDuration.toFixed(1)}s{' '}
                {view.transitionPreset}
              </small>
            </button>
          ))}
          <button className="add-view" onClick={addView}>
            + Add View
          </button>
          {activeViewId && (
            <div className="view-actions">
              <label>
                Hold
                <input
                  aria-label="View hold duration"
                  type="number"
                  min="0.5"
                  max="30"
                  step="0.5"
                  value={project.views.find((v) => v.id === activeViewId)!.holdDuration}
                  onChange={(e) => updateTransition({ holdDuration: Number(e.target.value) })}
                />
              </label>
              <label>
                Transition
                <input
                  aria-label="View transition duration"
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  value={project.views.find((v) => v.id === activeViewId)!.transitionDuration}
                  onChange={(e) =>
                    updateTransition({
                      transitionDuration: Number(e.target.value),
                    })
                  }
                />
              </label>
              <select
                aria-label="Transition easing"
                value={project.views.find((v) => v.id === activeViewId)!.transitionPreset}
                onChange={(e) =>
                  updateTransition({
                    transitionPreset: e.target.value as View['transitionPreset'],
                  })
                }
              >
                <option value="smooth">Smooth</option>
                <option value="cinematic">Cinematic</option>
                <option value="linear">Linear</option>
              </select>
              <button onClick={updateView}>Update</button>
              <button onClick={duplicateView}>Duplicate</button>
              <button onClick={renameView}>Rename</button>
              <button onClick={deleteView}>Delete</button>
            </div>
          )}
        </div>
      </footer>
    </main>
  );
}
function Inspector({
  layer,
  onChange,
  onDuplicate,
  onRemove,
  onMove,
}: {
  layer: Layer;
  onChange: (patch: Partial<Layer>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const isText = layer.type === 'text' || layer.type === 'pin';
  return (
    <div className="layer-inspector">
      <span className="type-chip">
        {icons[layer.type]} {layerLabel[layer.type]}
      </span>
      <label>
        Name
        <input value={layer.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      {isText && (
        <label>
          {layer.type === 'text' ? 'Content' : 'Label'}
          <textarea
            dir={layer.textDirection === 'rtl' ? 'rtl' : 'auto'}
            value={layer.text ?? ''}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </label>
      )}
      {layer.type === 'text' && (
        <>
          <div className="two-col">
            <label>
              Language
              <select
                value={layer.textLanguage ?? 'auto'}
                onChange={(e) =>
                  onChange({
                    textLanguage: e.target.value as Layer['textLanguage'],
                  })
                }
              >
                <option value="auto">Auto detect</option>
                <option value="persian">Persian</option>
                <option value="english">English</option>
              </select>
            </label>
            <label>
              Direction
              <select
                value={layer.textDirection ?? 'auto'}
                onChange={(e) =>
                  onChange({
                    textDirection: e.target.value as Layer['textDirection'],
                  })
                }
              >
                <option value="auto">Auto</option>
                <option value="rtl">RTL</option>
                <option value="ltr">LTR</option>
              </select>
            </label>
          </div>
          <div className="two-col">
            <label>
              Numbers
              <select
                value={layer.numberStyle ?? 'english'}
                onChange={(e) =>
                  onChange({
                    numberStyle: e.target.value as Layer['numberStyle'],
                  })
                }
              >
                <option value="english">English 123</option>
                <option value="persian">Persian ۱۲۳</option>
              </select>
            </label>
            <label>
              Font size
              <input
                type="range"
                min="12"
                max="48"
                value={layer.fontSize ?? 19}
                onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
              />
            </label>
          </div>
        </>
      )}
      <div className="two-col">
        <label>
          Color
          <input type="color" value={layer.color} onChange={(e) => onChange({ color: e.target.value })} />
        </label>
        <label>
          Opacity
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={layer.opacity}
            onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="toggle">
        <span>Visible</span>
        <input
          type="checkbox"
          checked={layer.visible}
          onChange={(e) => onChange({ visible: e.target.checked })}
        />
      </label>
      <label className="toggle">
        <span>Lock direct editing</span>
        <input
          type="checkbox"
          checked={layer.locked}
          onChange={(e) => onChange({ locked: e.target.checked })}
        />
      </label>
      <div className="order-actions">
        <button onClick={() => onMove(-1)}>Move back</button>
        <button onClick={() => onMove(1)}>Move forward</button>
      </div>
      <details>
        <summary>Advanced</summary>
        <p>Per-View properties and animation controls are introduced in later phases.</p>
      </details>
      <button className="duplicate" onClick={onDuplicate}>
        Duplicate Layer
      </button>
      <button className="delete-layer" onClick={onRemove}>
        Delete Layer
      </button>
    </div>
  );
}
