import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
import { OfflineMap } from '../components/OfflineMap';
import type { MapMode } from '../components/OfflineMap';
import { browserFileSystemAdapter } from '../core/adapters';
import {
  BASEMAP_CAPABILITIES,
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
import { fitCountryCamera, fitLayerCamera, fitSelectionCamera, fitWorldCamera } from '../core/camera';
import { exportPortableProject, importPortableProjectDetailed } from '../core/portableProject';
import { DEFAULT_EXPORT_PRESET_ID, EXPORT_PRESETS, type ExportPresetId } from '../core/exportPresets';
import {
  cancelProjectVideoExport,
  exportProjectVideo,
  type ExportProgressState,
} from '../core/videoExporter';
import { renderViewThumbnails, VIEW_THUMBNAIL_HEIGHT, VIEW_THUMBNAIL_WIDTH } from '../core/frameRenderer';
import {
  ingestProjectImage,
  resolveProjectAssetUrls,
  validateProjectAssetStorage,
} from '../core/projectAssets';

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
type PlaybackState = 'stopped' | 'playing' | 'paused';

const HOLD_PIXELS_PER_SECOND = 36;
const TRANSITION_PIXELS_PER_SECOND = 36;
const MIN_VIEW_CARD_WIDTH = 160;
const MIN_TRANSITION_WIDTH = 58;
const VIEW_CARD_GAP = 9;

export function App() {
  const [project, setProject] = useState<Project>(() => createProject('Untitled documentary'));
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [notice, setNotice] = useState('Offline map data loaded');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTransitionIndex, setSelectedTransitionIndex] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [mapMode, setMapMode] = useState<MapMode>('flat');
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('stopped');
  const [layersPanelOpen, setLayersPanelOpen] = useState(true);
  const [draggedViewId, setDraggedViewId] = useState<string | null>(null);
  const [openViewMenuId, setOpenViewMenuId] = useState<string | null>(null);
  const [viewThumbnails, setViewThumbnails] = useState<Record<string, string>>({});
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [exportState, setExportState] = useState<ExportProgressState & { message?: string }>({
    status: 'idle',
    currentFrame: 0,
    totalFrames: 0,
    percentage: 0,
  });
  const [exportPresetId, setExportPresetId] = useState<ExportPresetId>(DEFAULT_EXPORT_PRESET_ID);
  const [portableBusy, setPortableBusy] = useState(false);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const exportAbort = useRef<AbortController | null>(null);
  const previewTimeRef = useRef(0);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const thumbnailRenderIdRef = useRef(0);
  const renderedThumbnailSignaturesRef = useRef<Record<string, string>>({});
  const exportPreset = EXPORT_PRESETS.find((preset) => preset.id === exportPresetId)!;
  const words = t(language);
  const style = MAP_STYLES.find((item) => item.id === project.mapSettings.styleId)!;
  const selected = project.layers.find((l) => l.id === selectedId) ?? null;
  const activeView = project.views.find((view) => view.id === activeViewId) ?? null;
  const visibleLayers = useMemo(
    () => project.layers.filter((l) => l.name.toLowerCase().includes(search.toLowerCase())),
    [project.layers, search],
  );
  const sequence = useMemo(() => compileViews(project.views), [project.views]);
  const previewState = previewTime === null ? null : evaluateProjectAtTime(project, previewTime);
  const previewDisplayTime = previewTime ?? 0;
  const playheadPosition = timelinePosition(sequence, previewDisplayTime, timelineZoom);
  const selectedTransition =
    selectedTransitionIndex !== null ? (project.views[selectedTransitionIndex] ?? null) : null;
  const activeTransitionIndex = useMemo(() => {
    if (previewTime === null) return null;
    const index = sequence.segments.findIndex(
      (segment) => previewTime > segment.holdEnd && previewTime < segment.end,
    );
    return index >= 0 ? index : null;
  }, [previewTime, sequence]);
  const thumbnailSignatures = useMemo(() => {
    const global = {
      mapMode,
      mapSettings: project.mapSettings,
      canvasWidth: project.canvas.width,
      canvasHeight: project.canvas.height,
    };
    return Object.fromEntries(
      project.views.map((view) => [
        view.id,
        JSON.stringify({ global, camera: view.camera, layers: view.layers }),
      ]),
    );
  }, [mapMode, project.mapSettings, project.canvas.width, project.canvas.height, project.views]);
  useEffect(() => {
    let active = true;
    resolveProjectAssetUrls(project)
      .then((urls) => active && setAssetUrls(urls))
      .catch((error) => active && setNotice(`Unable to load project asset: ${String(error)}`));
    return () => {
      active = false;
    };
  }, [project.assets]);
  useEffect(() => {
    previewTimeRef.current = previewDisplayTime;
  }, [previewDisplayTime]);
  useEffect(() => {
    if (playbackState !== 'playing') return;
    const startedAt = performance.now() - previewTimeRef.current * 1000;
    let frame = 0;
    const tick = () => {
      const next = (performance.now() - startedAt) / 1000;
      if (next >= sequence.duration) {
        previewTimeRef.current = sequence.duration;
        setPreviewTime(sequence.duration);
        setPlaybackState('paused');
        return;
      }
      previewTimeRef.current = next;
      setPreviewTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playbackState, sequence.duration]);
  useEffect(() => {
    if (!previewState) return;
    const current = project.views[previewState.activeViewIndex];
    if (current && current.id !== activeViewId) setActiveViewId(current.id);
  }, [activeViewId, previewState?.activeViewIndex, project.views]);
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller || playbackState !== 'playing') return;
    const edgePadding = 56;
    const left = playheadPosition;
    if (left < scroller.scrollLeft + edgePadding)
      scroller.scrollTo({ left: Math.max(0, left - edgePadding), behavior: 'smooth' });
    else if (left > scroller.scrollLeft + scroller.clientWidth - edgePadding)
      scroller.scrollTo({ left: left - scroller.clientWidth + edgePadding, behavior: 'smooth' });
  }, [playbackState, playheadPosition]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLayersPanelOpen(false);
        setOpenViewMenuId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const removed = Object.keys(renderedThumbnailSignaturesRef.current).filter(
      (id) => !(id in thumbnailSignatures),
    );
    if (removed.length) {
      for (const id of removed) delete renderedThumbnailSignaturesRef.current[id];
      setViewThumbnails((previous) => {
        const next = { ...previous };
        for (const id of removed) delete next[id];
        return next;
      });
    }
    if (exportState.status !== 'idle' || projectRef.current.views.length === 0) return;
    const pending = projectRef.current.views.filter(
      (view) => renderedThumbnailSignaturesRef.current[view.id] !== thumbnailSignatures[view.id],
    );
    if (pending.length === 0) return;
    const controller = new AbortController();
    const renderId = ++thumbnailRenderIdRef.current;
    const timer = window.setTimeout(() => {
      const latestProject = projectRef.current;
      void renderViewThumbnails(
        latestProject,
        pending.map((view) => view.id),
        VIEW_THUMBNAIL_WIDTH,
        VIEW_THUMBNAIL_HEIGHT,
        mapMode,
        (result) => {
          if (renderId !== thumbnailRenderIdRef.current) return;
          renderedThumbnailSignaturesRef.current[result.viewId] = thumbnailSignatures[result.viewId];
          setViewThumbnails((previous) => ({ ...previous, [result.viewId]: result.dataUrl }));
        },
        controller.signal,
      ).catch(() => undefined);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [exportState.status, mapMode, thumbnailSignatures]);
  const scrollViewCardIntoView = useCallback((viewId: string) => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const card = scroller.querySelector<HTMLElement>(`[data-view-id="${viewId}"]`);
    if (!card) return;
    const margin = 18;
    const left = card.offsetLeft - margin;
    const right = card.offsetLeft + card.offsetWidth + margin;
    if (left < scroller.scrollLeft) scroller.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    else if (right > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollTo({ left: right - scroller.clientWidth, behavior: 'smooth' });
  }, []);
  useEffect(() => {
    if (!activeViewId || playbackState === 'playing') return;
    scrollViewCardIntoView(activeViewId);
  }, [activeViewId, playbackState, project.views.length, scrollViewCardIntoView, timelineZoom]);
  const updateProject = (fn: (p: Project) => Project) => setProject(fn);
  const selectLayer = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedTransitionIndex(null);
  }, []);
  const selectTransition = useCallback((index: number) => {
    setSelectedTransitionIndex(index);
    setSelectedId(null);
  }, []);
  const applyCameraEdit = useCallback((next: CameraState) => {
    setCamera(next);
    setPreviewTime(null);
    setPlaybackState('stopped');
  }, []);
  const handleCameraChange = useCallback(
    (next: CameraState) => {
      if (playbackState === 'playing') return;
      applyCameraEdit(next);
    },
    [applyCameraEdit, playbackState],
  );
  const updateLayer = (id: string, patch: Partial<Layer>) =>
    updateProject((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  const addLayer = async (type: LayerType) => {
    const layer = createLayer(type, project.layers.length);
    let asset = null;
    if (type === 'image') {
      try {
        const sourcePath = await openFile({
          title: 'Import Project Image',
          multiple: false,
          directory: false,
          filters: [{ name: 'PNG or JPEG image', extensions: ['png', 'jpg', 'jpeg'] }],
        });
        if (typeof sourcePath !== 'string') return;
        asset = await ingestProjectImage(sourcePath);
        layer.assetId = asset.id;
        layer.name = asset.filename;
        layer.width = 160;
        layer.height = Math.max(30, Math.min(160, (160 * asset.height) / asset.width));
      } catch (error) {
        setNotice(`Import image failed: ${String(error)}`);
        return;
      }
    }
    if (type === 'geo-effect') {
      const effect =
        geoEffectCycle[project.layers.filter((l) => l.type === 'geo-effect').length % geoEffectCycle.length];
      layer.geoEffectType = effect.type;
      layer.name = effect.name;
    }
    updateProject((p) => ({
      ...p,
      assets:
        asset && !p.assets.some((candidate) => candidate.id === asset.id) ? [...p.assets, asset] : p.assets,
      layers: [...p.layers, layer],
    }));
    selectLayer(layer.id);
    setNotice(`${layer.name} added`);
  };
  const save = async () => {
    try {
      const next = {
        ...project,
        metadata: { ...project.metadata, updatedAt: new Date().toISOString() },
      };
      await validateProjectAssetStorage(next);
      await browserFileSystemAdapter.saveProject(next);
      setProject(next);
      setNotice(words.saved);
    } catch (error) {
      setNotice(`Save failed: ${String(error)}`);
    }
  };
  const open = async () => {
    try {
      const saved = await browserFileSystemAdapter.openProject();
      if (saved) {
        await validateProjectAssetStorage(saved);
        setProject(saved);
        setSelectedId(null);
        setActiveViewId(saved.views[0]?.id ?? null);
        setCamera(saved.views[0]?.camera ?? { x: 0, y: 0, zoom: 1 });
        setPreviewTime(0);
        setPlaybackState('stopped');
        setNotice(words.opened);
      } else setNotice('No saved local project yet');
    } catch (error) {
      setNotice(`Open failed: ${String(error)}`);
    }
  };
  const exportProjectPackage = async () => {
    if (portableBusy) return;
    setPortableBusy(true);
    try {
      const safeName = project.metadata.name.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'MapMotion project';
      const outputPath = await saveFile({
        title: 'Export Portable MapMotion Project',
        defaultPath: `${safeName}.mapmotionpack`,
        filters: [{ name: 'MapMotion portable project', extensions: ['mapmotionpack'] }],
      });
      if (typeof outputPath !== 'string') return;
      await exportPortableProject(project, outputPath);
      setNotice(`Portable project exported: ${project.metadata.name}`);
    } catch (error) {
      setNotice(`Export Project failed: ${String(error)}`);
    } finally {
      setPortableBusy(false);
    }
  };
  const importProjectPackage = async () => {
    if (portableBusy || exportIsActive) return;
    setPortableBusy(true);
    try {
      const inputPath = await openFile({
        title: 'Import Portable MapMotion Project',
        multiple: false,
        directory: false,
        filters: [{ name: 'MapMotion portable project', extensions: ['mapmotionpack'] }],
      });
      if (typeof inputPath !== 'string') return;
      const { project: imported, compatibility } = await importPortableProjectDetailed(inputPath);
      setProject(imported);
      setCamera(imported.views[0]?.camera ?? { x: 0, y: 0, zoom: 1 });
      setSelectedId(null);
      setActiveViewId(imported.views[0]?.id ?? null);
      setPreviewTime(0);
      setPlaybackState('stopped');
      const warningCount = compatibility.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'warning',
      ).length;
      setNotice(
        `Portable project imported: ${imported.metadata.name}${warningCount ? ` · ${warningCount} compatibility warning${warningCount === 1 ? '' : 's'}` : ''}`,
      );
    } catch (error) {
      setNotice(`Import Project failed: ${String(error)}`);
    } finally {
      setPortableBusy(false);
    }
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
    selectLayer(layer.id);
  };
  const remove = () => {
    if (!selected) return;
    updateProject((p) => ({
      ...p,
      layers: p.layers.filter((l) => l.id !== selected.id),
    }));
    selectLayer(null);
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
    setPlaybackState('stopped');
    setNotice(`${view.name} captured`);
  };
  const activateView = (id: string) => {
    const view = project.views.find((v) => v.id === id);
    if (!view) return;
    setActiveViewId(id);
    setCamera(view.camera);
    setPreviewTime(null);
    updateProject((p) => ({ ...p, layers: structuredClone(view.layers) }));
    setSelectedId(null);
    setSelectedTransitionIndex(null);
    setPlaybackState('stopped');
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
  const duplicateView = (viewId = activeViewId) => {
    const source = project.views.find((v) => v.id === viewId);
    if (!source) return addView();
    const view = {
      ...structuredClone(source),
      id: `view-${crypto.randomUUID()}`,
      name: `${source.name} copy`,
    };
    updateProject((p) => ({ ...p, views: [...p.views, view] }));
    setActiveViewId(view.id);
    setSelectedTransitionIndex(null);
    setPlaybackState('stopped');
    setOpenViewMenuId(null);
  };
  const renameView = (viewId = activeViewId) => {
    const source = project.views.find((v) => v.id === viewId);
    if (!source) return;
    const name = window.prompt('View name', source.name)?.trim();
    if (name)
      updateProject((p) => ({
        ...p,
        views: p.views.map((v) => (v.id === source.id ? { ...v, name } : v)),
      }));
    setOpenViewMenuId(null);
  };
  const deleteView = (viewId = activeViewId) => {
    if (!viewId) return;
    const index = project.views.findIndex((view) => view.id === viewId);
    if (index < 0) return;
    const remaining = project.views.filter((view) => view.id !== viewId);
    updateProject((p) => ({
      ...p,
      views: p.views.filter((v) => v.id !== viewId),
    }));
    const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
    setActiveViewId(next?.id ?? null);
    if (next) {
      setCamera(next.camera);
      const nextSequence = compileViews(remaining);
      const nextIndex = remaining.findIndex((view) => view.id === next.id);
      const nextTime = nextSequence.segments[Math.max(0, nextIndex)]?.start ?? 0;
      setPreviewTime(nextTime);
    } else {
      setPreviewTime(null);
    }
    setPlaybackState('stopped');
    setSelectedTransitionIndex(null);
    setOpenViewMenuId(null);
    setNotice(next ? `Deleted View; selected ${next.name}` : 'Deleted last View');
  };
  const reorderView = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    updateProject((p) => {
      const from = p.views.findIndex((view) => view.id === fromId);
      const to = p.views.findIndex((view) => view.id === toId);
      if (from < 0 || to < 0) return p;
      const views = [...p.views];
      const [moved] = views.splice(from, 1);
      views.splice(to, 0, moved);
      return { ...p, views };
    });
    setActiveViewId(fromId);
    setPreviewTime(0);
    setSelectedTransitionIndex(null);
    setPlaybackState('stopped');
  };
  const playPreview = () => {
    if (!project.views.length) return;
    const atEnd = previewTimeRef.current >= sequence.duration - 1 / project.canvas.fps;
    const nextTime = previewTime === null || atEnd ? 0 : previewTimeRef.current;
    previewTimeRef.current = nextTime;
    setPreviewTime(nextTime);
    setPlaybackState('playing');
  };
  const pausePreview = () => {
    if (playbackState === 'playing') setPlaybackState('paused');
  };
  const stopPreview = () => {
    previewTimeRef.current = 0;
    setPreviewTime(0);
    setPlaybackState('stopped');
  };
  const seekPreview = (time: number) => {
    const next = Math.max(0, Math.min(sequence.duration, time));
    previewTimeRef.current = next;
    setPreviewTime(next);
    if (playbackState === 'stopped') setPlaybackState('paused');
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
  const updateSelectedTransition = (
    patch: Partial<Pick<View, 'transitionDuration' | 'transitionPreset' | 'transitionType'>>,
  ) => {
    if (selectedTransitionIndex === null) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((view, index) => (index === selectedTransitionIndex ? { ...view, ...patch } : view)),
    }));
  };
  const zoomTimeline = (factor: number) =>
    setTimelineZoom((zoom) => Math.max(0.5, Math.min(3, Math.round(zoom * factor * 100) / 100)));
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey) {
        zoomTimeline(event.deltaY < 0 ? 1.1 : 1 / 1.1);
        return;
      }
      const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX || event.deltaY;
      scroller.scrollLeft += horizontalDelta;
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, []);
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
    applyCameraEdit(autoReframe(project.layers, camera, layout));
    setNotice('Auto Reframe applied');
  };
  const fitWorld = () => {
    applyCameraEdit(fitWorldCamera());
    setNotice('Fit World applied');
  };
  const fitCountry = () => {
    const countryId = selected?.countryId ?? window.prompt('Country id or ISO code', 'IRN')?.trim();
    if (!countryId) return;
    const next = fitCountryCamera(countryId);
    if (!next) {
      setNotice(`Country not found: ${countryId}`);
      return;
    }
    applyCameraEdit(next);
    setNotice(`Fit Country applied: ${countryId.toUpperCase()}`);
  };
  const fitSelection = () => {
    applyCameraEdit(fitSelectionCamera(project.layers, selectedId, camera));
    setNotice(selectedId ? 'Fit Selection applied' : 'Fit Layers applied');
  };
  const fitLayer = () => {
    if (!selected) {
      setNotice('Select a layer before Fit Layer');
      return;
    }
    applyCameraEdit(fitLayerCamera(selected, camera));
    setNotice(`Fit Layer applied: ${selected.name}`);
  };
  const exportProof = async () => {
    if (exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportState({ status: 'preparing', currentFrame: 0, totalFrames: 0, percentage: 0 });
    try {
      const outputPath = await saveFile({
        title: 'Export MapMotion Video',
        defaultPath: `${project.metadata.name}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (typeof outputPath !== 'string') {
        setExportState({ status: 'idle', currentFrame: 0, totalFrames: 0, percentage: 0 });
        return;
      }
      const result = await exportProjectVideo(project, outputPath, {
        settings: exportPreset,
        mapMode,
        signal: controller.signal,
        onProgress: setExportState,
      });
      setExportState((state) => ({
        ...state,
        status: 'completed',
        percentage: 100,
        message: `Saved ${result.totalFrames} frames with ${result.encoderLabel}.`,
      }));
      setNotice('Project video export completed');
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      setExportState((state) => ({
        ...state,
        status: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Export cancelled. Partial output removed.' : String(error),
      }));
      setNotice(cancelled ? 'Video export cancelled' : 'Video export failed');
    } finally {
      exportAbort.current = null;
    }
  };
  const cancelExport = () => {
    exportAbort.current?.abort();
    void cancelProjectVideoExport();
  };
  const exportIsActive = ['preparing', 'rendering', 'finalizing'].includes(exportState.status);
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
              setActiveViewId(null);
            }}
          >
            {words.new}
          </button>
          <button className="quiet" onClick={open}>
            {words.open}
          </button>
          <button className="quiet" onClick={importProjectPackage} disabled={portableBusy || exportIsActive}>
            Import Project
          </button>
          <button className="quiet" onClick={exportProjectPackage} disabled={portableBusy || exportIsActive}>
            Export Project
          </button>
          <button className="primary" onClick={save}>
            {words.save}
          </button>
          <label className="export-preset">
            <span>H.264 MP4 · Auto encoder</span>
            <select
              aria-label="Export preset"
              value={exportPresetId}
              disabled={exportIsActive}
              onChange={(event) => setExportPresetId(event.target.value as ExportPresetId)}
            >
              {EXPORT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} · {preset.width}×{preset.height} · {preset.fps} FPS
                </option>
              ))}
            </select>
          </label>
          <button className="export" onClick={exportProof} disabled={exportIsActive}>
            {exportIsActive ? 'Exporting…' : `${words.export} Video`}
          </button>
          <button className="lang" onClick={() => setLanguage((l) => (l === 'en' ? 'fa' : 'en'))}>
            {language === 'en' ? 'فا' : 'EN'}
          </button>
        </div>
      </header>
      <section className={`workspace ${layersPanelOpen ? 'layers-open' : 'layers-closed'}`}>
        {layersPanelOpen && (
          <aside className="panel left-panel" onWheel={(event) => event.stopPropagation()}>
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
                    onClick={() => selectLayer(layer.id)}
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
        )}
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
              {MAP_STYLES.map((preset) => (
                <button
                  key={preset.id}
                  className={style.id === preset.id ? 'active' : ''}
                  onClick={() =>
                    updateProject((p) => ({
                      ...p,
                      mapSettings: { ...p.mapSettings, styleId: preset.id },
                    }))
                  }
                >
                  {preset.id === 'documentary-dark'
                    ? words.dark
                    : preset.id === 'documentary-light'
                      ? words.light
                      : preset.name}
                </button>
              ))}
              <button
                disabled
                title={BASEMAP_CAPABILITIES.find((capability) => capability.id === 'satellite')?.reason}
              >
                Satellite
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
              <button
                className={mapMode === 'flat' ? 'active' : ''}
                onClick={() => {
                  setMapMode('flat');
                  setNotice('Flat map mode');
                }}
              >
                Flat
              </button>
              <button
                className={mapMode === 'globe' ? 'active' : ''}
                onClick={() => {
                  setMapMode('globe');
                  setNotice('Globe map mode');
                }}
              >
                Globe
              </button>
              <button onClick={reframe}>Auto Reframe</button>
              <button onClick={fitWorld}>Fit World</button>
              <button onClick={fitCountry}>Fit Country</button>
              <button onClick={fitSelection}>Fit Selection</button>
              <button onClick={fitLayer} disabled={!selected}>
                Fit Layer
              </button>
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
              mapMode={mapMode}
              layers={previewState?.layers ?? project.layers}
              camera={previewState?.camera ?? camera}
              onCameraChange={handleCameraChange}
              interactionEnabled={playbackState !== 'playing'}
              labelLanguage={project.mapSettings.labelLanguage}
              selectedId={selectedId}
              onSelect={selectLayer}
              onMoveLayer={(id, x, y) => updateLayer(id, { x, y })}
              safeArea={project.canvas.safeArea}
              showSafeArea={project.canvas.showSafeArea}
              assetUrls={assetUrls}
            />
            <div className="add-toolbar">
              {layerTypes.map((type) => (
                <button key={type} onClick={() => void addLayer(type)} title={`Add ${layerLabel[type]}`}>
                  <b>{icons[type]}</b>
                  {layerLabel[type]}
                </button>
              ))}
            </div>
            <div className="map-hint">{words.panZoom}</div>
          </div>
          {exportState.status !== 'idle' && (
            <div className={`export-status export-status-${exportState.status}`} aria-live="polite">
              <div>
                <strong>{exportStatusLabel(exportState.status)}</strong>
                <span>
                  {exportState.totalFrames > 0 &&
                    `Frame ${exportState.currentFrame} / ${exportState.totalFrames} · `}
                  {exportState.percentage}%{exportState.encoderLabel && ` · ${exportState.encoderLabel}`}
                </span>
                {exportState.message && <small>{exportState.message}</small>}
              </div>
              <progress max="100" value={exportState.percentage} />
              {exportIsActive && <button onClick={cancelExport}>Cancel</button>}
            </div>
          )}
        </section>
        <aside className="panel right-panel" onWheel={(event) => event.stopPropagation()}>
          <div className="panel-heading">
            <span>{words.properties}</span>
          </div>
          {selectedTransition ? (
            <TransitionInspector
              transition={selectedTransition}
              fromName={selectedTransition.name}
              toName={project.views[selectedTransitionIndex! + 1]?.name ?? ''}
              onChange={(patch) => updateSelectedTransition(patch)}
            />
          ) : selected ? (
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
      <TimelinePanel>
        <TimelineToolbar>
          <div className="transport-controls" role="group" aria-label="Preview transport">
            <button
              className={playbackState === 'playing' ? 'active' : ''}
              onClick={playPreview}
              disabled={project.views.length < 1}
              aria-label="Play preview"
              title="Play"
            >
              ▶
            </button>
            <button
              className={playbackState === 'paused' ? 'active' : ''}
              onClick={pausePreview}
              disabled={playbackState !== 'playing'}
              aria-label="Pause preview"
              title="Pause"
            >
              ⏸
            </button>
            <button
              className={playbackState === 'stopped' ? 'active' : ''}
              onClick={stopPreview}
              disabled={project.views.length < 1}
              aria-label="Stop preview"
              title="Stop"
            >
              ⏹
            </button>
          </div>
          <select aria-label="Preview mode" defaultValue="sequence">
            <option value="sequence">Sequence Preview</option>
            <option value="current">Current View</option>
          </select>
          <button type="button">Layout</button>
          <button type="button" onClick={() => setLayersPanelOpen((open) => !open)}>
            Layers
          </button>
          <div className="timeline-zoom-control" role="group" aria-label="Timeline zoom">
            <button
              onClick={() => zoomTimeline(1 / 1.25)}
              title="Zoom timeline out"
              aria-label="Zoom timeline out"
            >
              −
            </button>
            <span>{Math.round(timelineZoom * 100)}%</span>
            <button onClick={() => zoomTimeline(1.25)} title="Zoom timeline in" aria-label="Zoom timeline in">
              +
            </button>
          </div>
          {activeView && (
            <div className="timeline-view-fields">
              <label>
                Hold
                <input
                  aria-label="View hold duration"
                  type="number"
                  min="0.5"
                  max="30"
                  step="0.5"
                  value={activeView.holdDuration}
                  onChange={(e) => updateTransition({ holdDuration: Number(e.target.value) })}
                />
              </label>
              <button className="update-view" onClick={updateView} disabled={playbackState === 'playing'}>
                Update View
              </button>
            </div>
          )}
          <span className="timeline-preview-state">
            {previewTime !== null
              ? `${formatTimelineTime(previewDisplayTime)} / ${formatTimelineTime(sequence.duration)} · ${
                  activeTransitionIndex !== null
                    ? `Transition ${activeTransitionIndex + 1} → ${activeTransitionIndex + 2}`
                    : `View ${previewState!.activeViewIndex + 1}`
                } · ${playbackState}`
              : activeView
                ? 'Ready to preview'
                : 'Create a View to preview'}
          </span>
        </TimelineToolbar>
        <TimelineViewport>
          <div ref={timelineScrollRef} className="timeline-scroll">
            <div className="timeline-track">
              {project.views.length > 0 && (
                <div
                  className="timeline-playhead"
                  style={{ left: playheadPosition }}
                  aria-label={`Playhead at ${formatTimelineTime(previewDisplayTime)}`}
                >
                  <span />
                </div>
              )}
              {project.views.map((view, index) => {
                const segment = sequence.segments[index];
                const cardWidth = holdCardWidth(view.holdDuration, timelineZoom);
                const isLast = index === project.views.length - 1;
                return (
                  <Fragment key={view.id}>
                    <div
                      data-view-id={view.id}
                      className={`view-card ${activeViewId === view.id ? 'active' : ''}`}
                      style={{ flexBasis: cardWidth }}
                      draggable
                      tabIndex={0}
                      onClick={(event) => {
                        activateView(view.id);
                        if (segment) {
                          const bounds = event.currentTarget.getBoundingClientRect();
                          const ratio = Math.max(
                            0,
                            Math.min(1, (event.clientX - bounds.left) / bounds.width),
                          );
                          seekPreview(segment.start + ratio * view.holdDuration);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Delete') {
                          event.preventDefault();
                          deleteView(view.id);
                          return;
                        }
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          activateView(view.id);
                          return;
                        }
                        let targetIndex: number | null = null;
                        if (event.key === 'ArrowRight') targetIndex = index + 1;
                        else if (event.key === 'ArrowLeft') targetIndex = index - 1;
                        else if (event.key === 'Home') targetIndex = 0;
                        else if (event.key === 'End') targetIndex = project.views.length - 1;
                        if (targetIndex === null || targetIndex < 0 || targetIndex >= project.views.length)
                          return;
                        event.preventDefault();
                        const target = project.views[targetIndex];
                        activateView(target.id);
                        requestAnimationFrame(() => {
                          const element = timelineScrollRef.current?.querySelector<HTMLElement>(
                            `[data-view-id="${target.id}"]`,
                          );
                          element?.focus({ preventScroll: true });
                          scrollViewCardIntoView(target.id);
                        });
                      }}
                      onDragStart={() => setDraggedViewId(view.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggedViewId) reorderView(draggedViewId, view.id);
                        setDraggedViewId(null);
                      }}
                    >
                      <span className="view-thumb" style={{ background: view.thumbnailColor }}>
                        {viewThumbnails[view.id] && (
                          <img
                            src={viewThumbnails[view.id]}
                            alt={`${view.name} thumbnail`}
                            draggable={false}
                          />
                        )}
                        <span className="view-thumb-index">{String(index + 1).padStart(2, '0')}</span>
                      </span>
                      <strong>{view.name}</strong>
                      <button
                        className="view-menu-trigger"
                        aria-label={`Open actions for ${view.name}`}
                        aria-expanded={openViewMenuId === view.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenViewMenuId((openId) => (openId === view.id ? null : view.id));
                        }}
                      >
                        ⋯
                      </button>
                      <small>
                        <span className="view-duration-exact">Hold {view.holdDuration.toFixed(1)}s</span>
                        {isLast && 'final View'}
                      </small>
                      {openViewMenuId === view.id && (
                        <div
                          className="view-card-menu"
                          role="menu"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button onClick={() => renameView(view.id)} role="menuitem">
                            Rename
                          </button>
                          <button onClick={() => duplicateView(view.id)} role="menuitem">
                            Duplicate
                          </button>
                          <button className="danger" onClick={() => deleteView(view.id)} role="menuitem">
                            Delete View
                          </button>
                        </div>
                      )}
                    </div>
                    {!isLast && (
                      <button
                        type="button"
                        className={`view-transition ${selectedTransitionIndex === index ? 'selected' : ''} ${activeTransitionIndex === index ? 'active' : ''}`}
                        style={{ flexBasis: transitionWidth(view.transitionDuration, timelineZoom) }}
                        data-transition-index={index}
                        title={`Transition ${view.name} → ${project.views[index + 1].name}: ${view.transitionDuration.toFixed(1)}s ${transitionTypeLabel(view.transitionType)}`}
                        onClick={(event) => {
                          selectTransition(index);
                          if (segment) {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const ratio = Math.max(
                              0,
                              Math.min(1, (event.clientX - bounds.left) / bounds.width),
                            );
                            seekPreview(segment.holdEnd + ratio * view.transitionDuration);
                          }
                        }}
                      >
                        <strong>{view.transitionDuration.toFixed(1)}s</strong>
                        <small>{transitionTypeLabel(view.transitionType)}</small>
                      </button>
                    )}
                  </Fragment>
                );
              })}
              <button className="add-view" onClick={addView}>
                + Add View
              </button>
            </div>
          </div>
        </TimelineViewport>
        <TimelineStatusBar>
          <div>
            <strong>{words.views}</strong>
            <span>
              {project.views.length} view{project.views.length === 1 ? '' : 's'} ·{' '}
              {activeView ? activeView.name : 'No View selected'}
            </span>
          </div>
          {activeView && (
            <div className="view-actions">
              <button onClick={updateView}>Update</button>
              <button onClick={() => duplicateView()}>Duplicate</button>
              <button onClick={() => renameView()}>Rename</button>
              <button onClick={() => deleteView()}>Delete</button>
            </div>
          )}
        </TimelineStatusBar>
      </TimelinePanel>
    </main>
  );
}

function TimelinePanel({ children }: { children: React.ReactNode }) {
  return (
    <footer className="timeline-panel" aria-label="Timeline">
      {children}
    </footer>
  );
}

function TimelineToolbar({ children }: { children: React.ReactNode }) {
  return <div className="timeline-toolbar">{children}</div>;
}

function TimelineViewport({ children }: { children: React.ReactNode }) {
  return <div className="timeline-viewport">{children}</div>;
}

function TimelineStatusBar({ children }: { children: React.ReactNode }) {
  return <div className="timeline-status-bar">{children}</div>;
}

function holdCardWidth(holdDuration: number, zoom = 1) {
  return Math.max(MIN_VIEW_CARD_WIDTH, holdDuration * HOLD_PIXELS_PER_SECOND) * zoom;
}

function transitionWidth(duration: number, zoom = 1) {
  return Math.max(MIN_TRANSITION_WIDTH, duration * TRANSITION_PIXELS_PER_SECOND) * zoom;
}

function timelinePosition(sequence: ReturnType<typeof compileViews>, time: number, zoom = 1) {
  if (!sequence.segments.length) return 0;
  const clampedTime = Math.max(0, Math.min(sequence.duration, time));
  let position = 0;
  for (let index = 0; index < sequence.segments.length; index += 1) {
    const segment = sequence.segments[index];
    const cardWidth = holdCardWidth(segment.from.holdDuration, zoom);
    const isLast = index === sequence.segments.length - 1;
    if (clampedTime <= segment.holdEnd || isLast) {
      const progress =
        segment.from.holdDuration > 0 ? (clampedTime - segment.start) / segment.from.holdDuration : 0;
      return position + Math.max(0, Math.min(1, progress)) * cardWidth;
    }
    position += cardWidth + VIEW_CARD_GAP;
    const width = transitionWidth(segment.from.transitionDuration, zoom);
    if (clampedTime <= segment.end) {
      const progress =
        segment.from.transitionDuration > 0
          ? (clampedTime - segment.holdEnd) / segment.from.transitionDuration
          : 0;
      return position + Math.max(0, Math.min(1, progress)) * width;
    }
    position += width + VIEW_CARD_GAP;
  }
  return position;
}

function transitionTypeLabel(type: View['transitionType']) {
  if (type === 'pan') return 'Pan';
  if (type === 'zoom') return 'Zoom';
  if (type === 'fly-to') return 'Fly To';
  return 'Smooth';
}

function formatTimelineTime(time: number) {
  const safeTime = Math.max(0, time);
  const minutes = Math.floor(safeTime / 60);
  const seconds = safeTime - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

const exportStatusLabel = (status: ExportProgressState['status']) => {
  if (status === 'preparing') return 'Preparing video';
  if (status === 'rendering') return 'Exporting video';
  if (status === 'finalizing') return 'Finalizing video';
  if (status === 'completed') return 'Export completed';
  if (status === 'cancelled') return 'Export cancelled';
  if (status === 'failed') return 'Export failed';
  return 'Video export';
};

function TransitionInspector({
  transition,
  fromName,
  toName,
  onChange,
}: {
  transition: View;
  fromName: string;
  toName: string;
  onChange: (
    patch: Partial<Pick<View, 'transitionDuration' | 'transitionPreset' | 'transitionType'>>,
  ) => void;
}) {
  return (
    <div className="layer-inspector transition-inspector">
      <span className="type-chip">◈ Transition</span>
      <div className="transition-context">
        <span>{fromName}</span>
        <span className="transition-context-arrow">→</span>
        <span>{toName}</span>
      </div>
      <label>
        Type
        <select
          value={transition.transitionType ?? 'smooth'}
          onChange={(e) => onChange({ transitionType: e.target.value as View['transitionType'] })}
        >
          <option value="smooth">Smooth</option>
          <option value="pan">Pan</option>
          <option value="zoom">Zoom</option>
          <option value="fly-to">Fly To</option>
        </select>
      </label>
      <label>
        Duration (s)
        <input
          type="number"
          min="0"
          max="30"
          step="0.5"
          value={transition.transitionDuration}
          onChange={(e) => onChange({ transitionDuration: Number(e.target.value) })}
        />
      </label>
      <label>
        Easing
        <select
          value={transition.transitionPreset}
          onChange={(e) => onChange({ transitionPreset: e.target.value as View['transitionPreset'] })}
        >
          <option value="smooth">Smooth</option>
          <option value="linear">Linear</option>
          <option value="ease-in">Ease In</option>
          <option value="ease-out">Ease Out</option>
          <option value="ease-in-out">Ease In-Out</option>
          <option value="cinematic">Cinematic</option>
          <option value="bezier">Bezier</option>
        </select>
      </label>
      <p className="transition-hint">Applies to the camera and layer motion leaving {fromName}.</p>
    </div>
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
