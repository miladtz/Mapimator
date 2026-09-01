import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { normalizeHexColor } from '../core/color';
import { OfflineMap } from '../components/OfflineMap';
import type { MapMode } from '../components/OfflineMap';
import { OnlineOpenFreeMap } from '../components/OnlineOpenFreeMap';
import { SearchPanel } from '../components/SearchPanel';
import {
  fitProjectViewport,
  projectRenderViewport,
  projectSceneViewBox,
  type LogicalViewport,
} from '../core/projectRenderViewport';
import { OPENFREEMAP_3D_CAMERA, OPENFREEMAP_STYLES } from '../core/openFreeMapAdapter';
import {
  getPinStyles,
  savePinStyle,
  renamePinStyle,
  deletePinStyle,
  type PinStyleEntry,
} from '../core/pinStyleLibrary';
import {
  BASEMAP_CAPABILITIES,
  MAP_STYLES,
  CANVAS_LAYOUTS,
  addProjectLayer,
  createLayer,
  createProject,
  createTransition,
  createView,
  deleteProjectLayer,
  layerLabel,
  setTransitionLayerIncluded,
  setViewLayerIncluded,
  sequenceMapMode,
  transitionAnimOf,
  transitionLayerConfigsOf,
  transitionMemberIds,
  viewAnimOf,
  viewLayerConfigsOf,
  viewLayersOf,
  viewMemberIds,
  type AppLanguage,
  type BasemapRenderer,
  type CameraState,
  type GeoEffectType,
  type Layer,
  type LayerType,
  type OnlineBasemapStyleId,
  type Project,
  type SegmentRef,
  type Transition,
  type View,
  type ViewLayerConfig,
} from '../core/project';
import { t } from '../core/i18n';
import { compileTimeline, evaluateProjectAtTime } from '../core/viewCompiler';
import {
  createGeographicRegionLayer,
  createRegionLayer,
  customRegionGeometry,
  findAdministrativeRegion,
  searchAdministrativeRegions,
  GEOGRAPHIC_REGIONS,
  type LngLat,
} from '../core/regions';
import { cameraForSearchResult, trimRecentSearches, type SearchResult } from '../core/locationSearch';
import { lngLatToMapMotionWorld } from '../core/openFreeMapAdapter';
import {
  buildTimelineLayout,
  resolveTimelineAtTime,
  timelinePosition,
  timelineTimeAtPosition,
} from '../core/timelineGeometry';
import { resolveEditingScene } from '../core/editingScene';
import { PreviewClock } from '../core/previewClock';
import {
  normalizeDialogPath,
  parseProjectFile,
  PROJECT_FILE_EXTENSION,
  serializeCanonicalProject,
} from '../core/projectFile';
import { formatExportDuration } from '../core/exportProgress';
import { canEditMembership } from '../core/editorPreviewModes';
import { validateTransitionLayer, validateViewLayer, type SegmentWarning } from '../core/segmentValidation';
import { autoReframe } from '../core/layout';
import {
  fitCountryCamera,
  fitLayerCamera,
  fitSelectionCamera,
  fitWorldCamera,
  MAX_CAMERA_PITCH,
  roundCamera,
} from '../core/camera';
import { cameraAtZoomForRenderer, getCameraZoomRange } from '../core/cameraZoomPolicy';
import {
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITION_SPEED_STEP,
  setTransitionDuration,
  setTransitionSpeed,
  transitionDisplaySpeed,
  transitionSpeedRange,
} from '../core/transitionTiming';
import { cameraWithGlobeFocus } from '../core/globeMath';
import { exportPortableProject, importPortableProjectDetailed } from '../core/portableProject';
import {
  isProjectFrameFormatLocked,
  projectThumbnailViewport,
  resolveProjectFrameFormat,
  validateCustomFrameDimensions,
} from '../core/projectFrameFormat';
import {
  cancelProjectVideoExport,
  exportProjectVideo,
  type ExportProgressState,
} from '../core/videoExporter';
import { renderViewThumbnails } from '../core/frameRenderer';
import {
  ingestProjectImage,
  ingestProjectImageBytes,
  cleanupProjectAssets,
  resolveProjectAssetUrls,
  validateProjectAssetStorage,
} from '../core/projectAssets';

const BUILTIN_PIN_STYLES: { id: NonNullable<Layer['pinStyle']>; label: string }[] = [
  { id: 'location', label: 'Location' },
  { id: 'map-pin', label: 'Map Pin' },
  { id: 'dot', label: 'Dot' },
  { id: 'target', label: 'Target' },
  { id: 'star', label: 'Star' },
  { id: 'circle', label: 'Circle' },
];

function PinStyleGlyph({ id, color }: { id: NonNullable<Layer['pinStyle']>; color: string }) {
  const stroke = 'currentColor';
  switch (id) {
    case 'dot':
      return (
        <svg viewBox="-8 -8 16 16" width="20" height="20" aria-hidden="true">
          <circle r="6.5" fill={color} stroke={stroke} strokeWidth="1.5" />
          <circle r="2.6" fill="#17202d" stroke="none" />
        </svg>
      );
    case 'location':
      return (
        <svg viewBox="-10 -20 20 20" width="20" height="20" aria-hidden="true">
          <path
            d="M0 -16.8 A 8.4 8.4 0 1 1 -0.01 -16.8 M -4.3 1.2 Q -0.7 3.6 0 9.8 Q 0.7 3.6 4.3 1.2 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'map-pin':
      return (
        <svg viewBox="-10 -20 20 20" width="20" height="20" aria-hidden="true">
          <path
            d="M0 -16.8 A 8.4 8.4 0 1 1 -0.01 -16.8 M -4.3 1.2 Q -0.7 3.6 0 9.8 Q 0.7 3.6 4.3 1.2 Z M0 -8.6 a 2.6 2.6 0 1 0 0.01 -8.6"
            fill={color}
            fillRule="evenodd"
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'target':
      return (
        <svg viewBox="-8 -8 16 16" width="20" height="20" aria-hidden="true">
          <circle r="6.5" fill="none" stroke={stroke} strokeWidth="1.5" />
          <circle r="4" fill="none" stroke={stroke} strokeWidth="1.2" />
          <circle r="1.7" fill={color} stroke="none" />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="-9 -9 18 18" width="20" height="20" aria-hidden="true">
          <path
            d="M0 -8 L2.2 -2.4 L8 -2.4 L3.4 1.4 L4.9 7 L0 3.6 L-4.9 7 L-3.4 1.4 L-8 -2.4 L-2.2 -2.4 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'circle':
      return (
        <svg viewBox="-8 -8 16 16" width="20" height="20" aria-hidden="true">
          <circle r="6.5" fill={color} stroke={stroke} strokeWidth="1.5" />
        </svg>
      );
    default:
      return null;
  }
}

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

export function App() {
  const [project, setProject] = useState<Project>(() => createProject('Untitled documentary'));
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [notice, setNotice] = useState('Experimental OpenFreeMap renderer');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The sole authoritative stable-ID View/Transition selection. Null means Map Mode while stopped. */
  const [timelineSelection, setTimelineSelection] = useState<SegmentRef | null>(null);
  const [transitionPopoverId, setTransitionPopoverId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 });
  const [mapMode, setMapMode] = useState<MapMode>('flat');
  const [playbackState, setPlaybackState] = useState<PlaybackState>('stopped');
  const [layersPanelOpen, setLayersPanelOpen] = useState(true);
  const [placing, setPlacing] = useState<LayerType | null>(null);
  const [regionDraft, setRegionDraft] = useState<LngLat[]>([]);
  const [regionToolOpen, setRegionToolOpen] = useState(false);
  const [regionSearch, setRegionSearch] = useState('');
  const [locationSearchOpen, setLocationSearchOpen] = useState(false);
  const [locationSearchFocusRequest, setLocationSearchFocusRequest] = useState(0);
  const [recentLocations, setRecentLocations] = useState<SearchResult[]>([]);
  const [searchNavigation, setSearchNavigation] = useState<{ id: number; camera: CameraState } | null>(null);
  const [draggedViewId, setDraggedViewId] = useState<string | null>(null);
  /** Editor-only temporary layer hiding (eye). Never persisted, never affects Preview/Export. */
  const [eyeHidden, setEyeHidden] = useState<Record<string, boolean>>({});
  const [allEyesHidden, setAllEyesHidden] = useState(false);
  const [openViewMenuId, setOpenViewMenuId] = useState<string | null>(null);
  const [viewThumbnails, setViewThumbnails] = useState<Record<string, string>>({});
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [exportState, setExportState] = useState<ExportProgressState & { message?: string }>({
    status: 'idle',
    currentFrame: 0,
    totalFrames: 0,
    percentage: 0,
  });
  const [customFrameDraft, setCustomFrameDraft] = useState<{ width: string; height: string } | null>(null);
  const [portableBusy, setPortableBusy] = useState(false);
  const [projectFilePath, setProjectFilePath] = useState<string | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const exportAbort = useRef<AbortController | null>(null);
  const previewClock = useMemo(() => new PreviewClock(), []);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const globalMembershipRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const thumbnailRenderIdRef = useRef(0);
  const renderedThumbnailSignaturesRef = useRef<Record<string, string>>({});
  const frameFormat = resolveProjectFrameFormat(project);
  const frameFormatLocked = isProjectFrameFormatLocked(project);
  const words = t(language);
  const style = MAP_STYLES.find((item) => item.id === project.mapSettings.styleId)!;
  const selected = project.layers.find((l) => l.id === selectedId) ?? null;
  const projectMode = timelineSelection === null;
  const selectedTransitionId = timelineSelection?.kind === 'transition' ? timelineSelection.id : null;
  const activeViewId = timelineSelection?.kind === 'view' ? timelineSelection.id : null;
  const selectedTransitionIndex = selectedTransitionId
    ? project.transitions.findIndex((transition) => transition.id === selectedTransitionId)
    : null;
  const activeView = project.views.find((view) => view.id === activeViewId) ?? null;
  const visibleLayers = useMemo(
    () => project.layers.filter((l) => l.name.toLowerCase().includes(search.toLowerCase())),
    [project.layers, search],
  );
  const sequence = useMemo(() => compileTimeline(project), [project]);
  const lockedMapMode = sequenceMapMode(project);
  useEffect(() => {
    if (lockedMapMode && mapMode !== lockedMapMode) setMapMode(lockedMapMode);
  }, [lockedMapMode, mapMode]);
  const selectedTimelineEntity = timelineSelection;
  const editingScene = useMemo(
    () => resolveEditingScene(project, selectedTimelineEntity, camera),
    [project, selectedTimelineEntity?.kind, selectedTimelineEntity?.id, camera],
  );
  const timelineLayout = useMemo(() => buildTimelineLayout(project, timelineZoom), [project, timelineZoom]);
  const selectedTransition =
    selectedTransitionIndex !== null ? (project.transitions[selectedTransitionIndex] ?? null) : null;
  const thumbnailSignatures = useMemo(() => {
    const global = {
      mapSettings: project.mapSettings,
      canvasWidth: project.canvas.width,
      canvasHeight: project.canvas.height,
    };
    // Layer visual state is canonical in project.layers, so a global Layer
    // change updates every View thumbnail that uses it (see section: global
    // property behavior).  Membership changes update each View's signature.
    return Object.fromEntries(
      project.views.map((view) => [
        view.id,
        JSON.stringify({
          global,
          mapMode: view.mapMode,
          camera: view.camera,
          layers: viewLayersOf(project, view),
        }),
      ]),
    );
  }, [project.mapSettings, project.canvas.width, project.canvas.height, project.views, project.layers]);
  useEffect(() => {
    let active = true;
    resolveProjectAssetUrls(project)
      .then((urls) => active && setAssetUrls(urls))
      .catch((error) => active && setNotice(`Unable to load project asset: ${String(error)}`));
    return () => {
      active = false;
    };
  }, [project.assets]);
  /** Authoritative Stop semantics shared by the transport and natural completion. */
  const stopPlayback = useCallback(() => {
    previewClock.stop();
    setPlaybackState('stopped');
    setTimelineSelection(null);
    setTransitionPopoverId(null);
  }, [previewClock]);
  useEffect(() => () => previewClock.destroy(), [previewClock]);
  // Preview evaluation must not change the editor's selected segment. In
  // particular, seeking into a Transition must not replace its Layers-panel
  // context with the adjacent View; View/Transition selection is user-owned.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (locationSearchOpen) {
          setLocationSearchOpen(false);
          return;
        }
        setPlacing(null);
        setRegionDraft([]);
        setRegionToolOpen(false);
        setLayersPanelOpen(false);
        setOpenViewMenuId(null);
        setLocationSearchOpen(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setLocationSearchOpen(true);
        setLocationSearchFocusRequest((request) => request + 1);
      }
      const editable =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (placing === 'region' && event.key === 'Backspace' && !editable) {
        event.preventDefault();
        setRegionDraft((points) => points.slice(0, -1));
      }
      if (placing === 'region' && event.key === 'Enter' && !editable) {
        const geometry = customRegionGeometry(regionDraft);
        if (!geometry) {
          setNotice('A Region needs at least 3 unique, non-collinear vertices.');
          return;
        }
        const count = projectRef.current.layers.filter(
          (layer) => layer.type === 'region' && layer.regionSource === 'custom',
        ).length;
        const layer = createRegionLayer(`Custom Region ${count + 1}`, geometry);
        updateProject((current) => addProjectLayer(current, layer));
        selectLayer(layer.id);
        setRegionDraft([]);
        setPlacing(null);
        setNotice(`${layer.name} added`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locationSearchOpen, placing, regionDraft]);
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
      const thumbnailViewport = projectThumbnailViewport(latestProject);
      void renderViewThumbnails(
        latestProject,
        pending.map((view) => view.id),
        thumbnailViewport.width,
        thumbnailViewport.height,
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
  /** Select a layer. A selected Transition stays selected so the layer can be
   *  configured for that transition (the Layers panel keeps its segment context). */
  const selectLayer = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);
  const selectTransition = (transitionId: string) => {
    setTimelineSelection({ kind: 'transition', id: transitionId });
    setTransitionPopoverId(transitionId);
  };
  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);
  const applyCameraEdit = useCallback((next: CameraState) => {
    setCamera(next);
    previewClock.stop();
    setPlaybackState('stopped');
  }, []);
  const handleCameraChange = useCallback(
    (next: CameraState) => {
      if (playbackState !== 'stopped') return;
      applyCameraEdit(next);
    },
    [applyCameraEdit, playbackState],
  );
  const updateLayer = (id: string, patch: Partial<Layer>) =>
    updateProject((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  /** Which segment the Layers panel currently edits: a Transition or the active View. */
  const editingTransitionIndex =
    selectedTransitionIndex !== null && project.transitions[selectedTransitionIndex]
      ? selectedTransitionIndex
      : null;
  const editingViewIndex =
    editingTransitionIndex === null && activeView
      ? project.views.findIndex((v) => v.id === activeView.id)
      : -1;
  /**
   * The selected segment's layer membership (checkbox state), derived from the
   * segment's own per-layer configuration keyed by project layer id. The
   * Layers panel always lists the full project registry; only the checkboxes
   * change with the selected View/Transition.
   */
  const segmentVisibleIds = useMemo(() => {
    if (editingTransitionIndex !== null)
      return transitionMemberIds(project.transitions[editingTransitionIndex]);
    if (editingViewIndex >= 0) return viewMemberIds(project.views[editingViewIndex]);
    return new Set<string>();
  }, [editingTransitionIndex, editingViewIndex, project.views, project.transitions]);
  /**
   * Update the selected segment's layer membership (checkbox) immediately.
   * This is an explicit View/Transition configuration edit and does NOT
   * require Update View.  Only the segment's usage config changes — Layer
   * visual properties are project-global and never touched here.
   */
  const setSegmentMembership = (layerId: string, checked: boolean) => {
    if (projectMode) return;
    if (selectedTransitionId) {
      updateProject((p) => setTransitionLayerIncluded(p, selectedTransitionId, layerId, checked));
      return;
    }
    if (activeViewId) updateProject((p) => setViewLayerIncluded(p, activeViewId, layerId, checked));
  };
  /** Patch the selected Transition's per-layer animation config. */
  const patchTransitionAnim = (
    layerId: string,
    patch: Partial<import('../core/project').SegmentLayerAnimation>,
  ) => {
    if (!selectedTransitionId) return;
    updateProject((p) => ({
      ...p,
      transitions: p.transitions.map((transition) =>
        transition.id === selectedTransitionId
          ? {
              ...transition,
              layerConfigs: {
                ...transition.layerConfigs,
                [layerId]: {
                  ...(transition.layerConfigs[layerId] ?? { included: false }),
                  animation: {
                    ...(transition.layerConfigs[layerId]?.animation ?? {}),
                    ...patch,
                  },
                },
              },
            }
          : transition,
      ),
    }));
  };
  /** Patch the active View's per-layer animation config (View-hold lifecycle). */
  const patchViewAnim = (
    layerId: string,
    patch: Partial<import('../core/project').SegmentLayerAnimation>,
  ) => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((v) =>
        v.id === activeViewId
          ? {
              ...v,
              layerConfigs: {
                ...viewLayerConfigsOf(v),
                [layerId]: {
                  included: viewLayerConfigsOf(v)[layerId]?.included ?? false,
                  animation: {
                    ...(viewLayerConfigsOf(v)[layerId]?.animation ?? {}),
                    ...patch,
                  },
                },
              },
            }
          : v,
      ),
    }));
  };
  const segmentAllChecked =
    project.layers.length > 0 && (projectMode || project.layers.every((l) => segmentVisibleIds.has(l.id)));
  const segmentSomeChecked = projectMode || project.layers.some((l) => segmentVisibleIds.has(l.id));
  const allocationCheckboxDisabled = !canEditMembership(playbackState, selectedTimelineEntity);
  const segmentContextLabel = projectMode
    ? 'Project Layers'
    : editingTransitionIndex !== null
      ? `Editing Transition ${editingTransitionIndex + 1} → ${editingTransitionIndex + 2}`
      : editingViewIndex >= 0
        ? `Editing View ${editingViewIndex + 1}`
        : words.layers;
  useEffect(() => {
    if (globalMembershipRef.current)
      globalMembershipRef.current.indeterminate = !projectMode && segmentSomeChecked && !segmentAllChecked;
  }, [projectMode, segmentSomeChecked, segmentAllChecked]);
  /** Global membership checkbox: check/uncheck every layer for the selected segment. */
  const toggleAllMembership = () => {
    if (projectMode) return;
    const target = !segmentAllChecked;
    if (selectedTransitionId) {
      updateProject((p) => ({
        ...p,
        transitions: p.transitions.map((transition) =>
          transition.id === selectedTransitionId
            ? {
                ...transition,
                layerConfigs: Object.fromEntries(
                  p.layers.map((l) => {
                    const existing = transition.layerConfigs[l.id];
                    return [l.id, { included: target, animation: existing?.animation }];
                  }),
                ),
              }
            : transition,
        ),
      }));
      return;
    }
    if (activeViewId) {
      updateProject((p) => ({
        ...p,
        views: p.views.map((v) =>
          v.id === activeViewId
            ? {
                ...v,
                layerConfigs: Object.fromEntries(
                  p.layers.map((l) => {
                    const existing = viewLayerConfigsOf(v)[l.id];
                    return [l.id, { included: target, animation: existing?.animation }];
                  }),
                ),
              }
            : v,
        ),
      }));
    }
  };
  const placeLayerAt = (type: LayerType, point: { x: number; y: number }) => {
    const layer = createLayer(type, project.layers.length);
    layer.x = point.x;
    layer.y = point.y;
    if (type === 'pin') {
      const pinCount = project.layers.filter((l) => l.type === 'pin').length;
      layer.name = `Pin ${pinCount + 1}`;
    }
    updateProject((p) => addProjectLayer(p, layer));
    selectLayer(layer.id);
    setPlacing(null);
    setNotice(`${layer.name} added — click its Properties to style it`);
  };
  const addLayer = async (type: LayerType) => {
    setPlacing(null);
    if (type === 'pin') {
      setPlacing('pin');
      setNotice('Click the map to place the Pin — Esc to cancel');
      return;
    }
    if (type === 'region') {
      setRegionToolOpen((open) => !open);
      setNotice('Choose an existing geographic Region or draw a custom polygon');
      return;
    }
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
    updateProject((p) =>
      addProjectLayer(
        {
          ...p,
          assets:
            asset && !p.assets.some((candidate) => candidate.id === asset.id)
              ? [...p.assets, asset]
              : p.assets,
        },
        layer,
      ),
    );
    selectLayer(layer.id);
    setNotice(`${layer.name} added`);
  };
  const save = async () => {
    if (playbackState !== 'stopped') {
      setNotice('Stop Preview before saving the project.');
      return;
    }
    try {
      const next = {
        ...project,
        metadata: { ...project.metadata, updatedAt: new Date().toISOString() },
      };
      await validateProjectAssetStorage(next);
      const serialized = serializeCanonicalProject(next);
      const selectedPath =
        projectFilePath ??
        normalizeDialogPath(
          await saveFile({
            title: 'Save MapMotion Project',
            defaultPath: `${safeProjectName(project.metadata.name)}.${PROJECT_FILE_EXTENSION}`,
            filters: [{ name: 'MapMotion project', extensions: [PROJECT_FILE_EXTENSION] }],
          }),
        );
      if (!selectedPath) return;
      const result = await invoke<{ path: string; bytesWritten: number }>('write_project_file', {
        outputPath: selectedPath,
        projectJson: serialized.json,
      });
      setProject(serialized.project);
      setProjectFilePath(result.path);
      setNotice(words.saved);
    } catch (error) {
      if (import.meta.env.DEV) console.error('Project Save failed', { projectFilePath, error });
      setNotice(`Save failed · ${conciseRuntimeError(error, 'Unable to write the project file.')}`);
    }
  };
  const open = async () => {
    if (playbackState !== 'stopped') {
      setNotice('Stop Preview before opening a project.');
      return;
    }
    try {
      const selectedPath = normalizeDialogPath(
        await openFile({
          title: 'Open MapMotion Project',
          multiple: false,
          directory: false,
          filters: [{ name: 'MapMotion project', extensions: [PROJECT_FILE_EXTENSION] }],
        }),
      );
      if (!selectedPath) return;
      const json = await invoke<string>('read_project_file', { inputPath: selectedPath });
      const saved = parseProjectFile(json);
      await validateProjectAssetStorage(saved);
      setProject(saved);
      setProjectFilePath(selectedPath);
      setSelectedId(null);
      setTimelineSelection(null);
      setTransitionPopoverId(null);
      setCamera(saved.views[0]?.camera ?? { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 });
      previewClock.stop();
      setPlaybackState('stopped');
      setNotice(words.opened);
    } catch (error) {
      if (import.meta.env.DEV) console.error('Project Open failed', { error });
      setNotice(`Open failed · ${conciseRuntimeError(error, 'Unable to read the project file.')}`);
    }
  };
  const exportProjectPackage = async () => {
    if (portableBusy) return;
    setPortableBusy(true);
    try {
      const safeName = safeProjectName(project.metadata.name);
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
      setProjectFilePath(null);
      setCamera(imported.views[0]?.camera ?? { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 });
      setSelectedId(null);
      setTimelineSelection(null);
      setTransitionPopoverId(null);
      previewClock.stop();
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
    updateProject((p) => addProjectLayer(p, layer));
    selectLayer(layer.id);
  };
  const removeLayerById = async (layerId: string) => {
    const target = projectRef.current.layers.find((layer) => layer.id === layerId);
    if (!target) return;
    const name = target.name;
    const ok = window.confirm(
      `Delete ${name} from the project?\nIt will be removed from all Views and Transitions.`,
    );
    if (!ok) return;
    // Centralized project-level cascade: removes the Layer from the registry
    // and from every View/Transition usage.
    const deleted = deleteProjectLayer(projectRef.current, layerId);
    setProject(deleted);
    if (selectedId === layerId) selectLayer(null);
    try {
      const cleaned = await cleanupProjectAssets(deleted);
      setProject((current) => ({ ...current, assets: cleaned.project.assets }));
      setNotice(`${name} deleted from project and all segments`);
    } catch (error) {
      setNotice(`${name} deleted; asset cleanup will retry later: ${String(error)}`);
    }
  };
  const remove = () => (selected ? removeLayerById(selected.id) : Promise.resolve());
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
    const viewMapMode = lockedMapMode ?? mapMode;
    const view = createView(
      `View ${project.views.length + 1}`,
      project.layers,
      camera,
      project.layers,
      viewMapMode,
    );
    updateProject((p) => {
      const views = [...p.views];
      // Initialize the previous View's outgoing transition membership from its
      // own config (convenience only — after creation the states are independent).
      const last = views.at(-1);
      views.push(view);
      return {
        ...p,
        views,
        transitions: last
          ? [...p.transitions, createTransition(last.id, view.id, p.layers, last)]
          : p.transitions,
      };
    });
    setTimelineSelection({ kind: 'view', id: view.id });
    previewClock.stop();
    setPlaybackState('stopped');
    setTransitionPopoverId(null);
    setNotice(`${view.name} captured`);
  };
  const activateView = (id: string) => {
    const view = project.views.find((v) => v.id === id);
    if (!view) return;
    setTimelineSelection({ kind: 'view', id });
    setCamera(view.camera);
    setMapMode(view.mapMode);
    previewClock.stop();
    // Layer visual properties are project-global, so activating a View does
    // NOT change the editor canvas layers — only camera and the segment
    // context (membership checkboxes / animation editor) change.
    setTransitionPopoverId(null);
    setPlaybackState('stopped');
    setNotice(`${view.name} previewed`);
  };
  /**
   * With the normalized model, Layer properties are project-global, so
   * "Update View" now saves only the View-owned state that remains — the
   * camera.  Layer membership/animation are timeline config edits applied
   * immediately from the Layers panel / segment editor.
   */
  const updateView = () => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((v) =>
        v.id === activeViewId ? { ...v, camera: { ...camera }, mapMode: sequenceMapMode(p) ?? mapMode } : v,
      ),
    }));
    setNotice('View updated — project not saved yet');
  };
  /** True when the active View's camera no longer matches the working camera. */
  const activeViewStale = useMemo(() => {
    const active = project.views.find((v) => v.id === activeViewId);
    if (!active) return false;
    return JSON.stringify(active.camera) !== JSON.stringify(camera) || active.mapMode !== mapMode;
  }, [project.views, activeViewId, camera, mapMode]);

  const duplicateView = (viewId = activeViewId) => {
    const source = project.views.find((v) => v.id === viewId);
    if (!source) return addView();
    const view = {
      ...structuredClone(source),
      id: `view-${crypto.randomUUID()}`,
      name: `${source.name} copy`,
    };
    updateProject((p) => {
      const last = p.views.at(-1);
      return {
        ...p,
        views: [...p.views, view],
        transitions: last
          ? [...p.transitions, createTransition(last.id, view.id, p.layers, last)]
          : p.transitions,
      };
    });
    setTimelineSelection({ kind: 'view', id: view.id });
    previewClock.stop();
    setTransitionPopoverId(null);
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
    updateProject((p) => {
      const views = p.views.filter((v) => v.id !== viewId);
      const transitions = p.transitions.filter(
        (transition) => transition.fromViewId !== viewId && transition.toViewId !== viewId,
      );
      const previous = p.views[index - 1];
      const following = p.views[index + 1];
      return {
        ...p,
        views,
        transitions:
          previous && following
            ? [...transitions, createTransition(previous.id, following.id, p.layers, previous)]
            : transitions,
      };
    });
    const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
    setTimelineSelection(next ? { kind: 'view', id: next.id } : null);
    if (next) {
      setCamera(next.camera);
    }
    previewClock.stop();
    setPlaybackState('stopped');
    setTransitionPopoverId(null);
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
      const transitions = views.slice(0, -1).map((view, index) => {
        const next = views[index + 1];
        return (
          p.transitions.find(
            (transition) => transition.fromViewId === view.id && transition.toViewId === next.id,
          ) ?? createTransition(view.id, next.id, p.layers, view)
        );
      });
      return { ...p, views, transitions };
    });
    setTimelineSelection({ kind: 'view', id: fromId });
    previewClock.stop();
    setTransitionPopoverId(null);
    setPlaybackState('stopped');
  };
  const playPreview = () => {
    if (!project.views.length) return;
    const currentTime = previewClock.getSnapshot();
    const atEnd = currentTime >= sequence.duration - 1 / project.canvas.fps;
    if (atEnd || playbackState === 'stopped') previewClock.seek(0);
    previewClock.play(sequence.duration, stopPlayback);
    setPlaybackState('playing');
  };
  const pausePreview = () => {
    if (playbackState === 'playing') {
      previewClock.pause();
      setPlaybackState('paused');
    }
  };
  const toggleProjectMode = (enabled: boolean) => {
    if (playbackState !== 'stopped') return;
    if (enabled) {
      setTimelineSelection(null);
      setTransitionPopoverId(null);
      previewClock.stop();
      setNotice('Map Mode — editing Project Layers');
      return;
    }
    const first = project.views[0];
    if (!first) {
      setTimelineSelection(null);
      setNotice('Add a View before leaving Map Mode.');
      return;
    }
    setTimelineSelection({ kind: 'view', id: first.id });
    setTransitionPopoverId(null);
    setCamera(first.camera);
    previewClock.stop();
    setNotice(`${first.name} selected`);
  };
  const seekPreview = (time: number) => {
    const next = Math.max(0, Math.min(sequence.duration, time));
    previewClock.seek(next);
    if (playbackState === 'stopped') setPlaybackState('paused');
  };
  const scrubTimeline = (event: React.PointerEvent<HTMLDivElement>) => {
    const scrubTrack = timelineScrollRef.current?.querySelector<HTMLElement>('.timeline-scrub-track');
    if (!scrubTrack) return;
    const bounds = scrubTrack.getBoundingClientRect();
    seekPreview(timelineTimeAtPosition(project, event.clientX - bounds.left, timelineZoom));
  };
  const updateTransition = (patch: Partial<Pick<View, 'holdDuration'>>) => {
    if (!activeViewId) return;
    updateProject((p) => ({
      ...p,
      views: p.views.map((v) => (v.id === activeViewId ? { ...v, ...patch } : v)),
    }));
  };
  const updateSelectedTransition = (
    patch: Partial<Pick<Transition, 'duration' | 'speed' | 'preset' | 'type'>>,
  ) => {
    if (!selectedTransitionId) return;
    updateProject((p) => ({
      ...p,
      transitions: p.transitions.map((transition) =>
        transition.id === selectedTransitionId
          ? patch.speed !== undefined
            ? setTransitionSpeed(transition, patch.speed)
            : patch.duration !== undefined
              ? setTransitionDuration(transition, patch.duration)
              : { ...transition, ...patch }
          : transition,
      ),
    }));
  };
  const zoomTimeline = (factor: number) =>
    setTimelineZoom((zoom) => Math.max(0.5, Math.min(3, Math.round(zoom * factor * 100) / 100)));
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.timeline-duration-input')) {
        event.stopPropagation();
        return;
      }
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
    if (project.views.length > 0) {
      setNotice('Frame size is locked after the first View is created.');
      return;
    }
    if (layoutId === 'custom') {
      setCustomFrameDraft({ width: String(project.canvas.width), height: String(project.canvas.height) });
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
        fps: layout.id === 'landscape' ? p.canvas.fps : 30,
        safeArea: layout.safeArea,
      },
    }));
    setNotice(`${layout.name} selected`);
  };
  const applyCustomFrame = () => {
    if (!customFrameDraft || project.views.length > 0) return;
    try {
      const dimensions = validateCustomFrameDimensions(
        Number(customFrameDraft.width),
        Number(customFrameDraft.height),
      );
      updateProject((current) => ({
        ...current,
        canvas: {
          ...current.canvas,
          layoutId: 'custom',
          width: dimensions.width,
          height: dimensions.height,
          fps: 30,
        },
      }));
      setCustomFrameDraft(null);
      setNotice(`Custom frame ${dimensions.width} × ${dimensions.height} selected`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
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
    applyCameraEdit({ ...next, bearing: camera.bearing, pitch: camera.pitch });
    setNotice(`Fit Country applied: ${countryId.toUpperCase()}`);
  };
  const fitSelection = () => {
    applyCameraEdit({
      ...fitSelectionCamera(project.layers, selectedId, camera),
      bearing: camera.bearing,
      pitch: camera.pitch,
    });
    setNotice(selectedId ? 'Fit Selection applied' : 'Fit Layers applied');
  };
  const fitLayer = () => {
    if (!selected) {
      setNotice('Select a layer before Fit Layer');
      return;
    }
    applyCameraEdit({ ...fitLayerCamera(selected, camera), bearing: camera.bearing, pitch: camera.pitch });
    setNotice(`Fit Layer applied: ${selected.name}`);
  };
  const focusLayerFromRow = (layer: Layer) => {
    selectLayer(layer.id);
    const fitted = fitLayerCamera(layer, camera);
    const pinZoom = layer.type === 'pin' ? Math.max(fitted.zoom, 3.25) : fitted.zoom;
    applyCameraEdit({ ...fitted, zoom: pinZoom, bearing: camera.bearing, pitch: 0 });
  };
  const rememberLocation = (result: SearchResult) =>
    setRecentLocations((current) => trimRecentSearches([result, ...current]));
  const goToSearchResult = (result: SearchResult) => {
    const target = cameraForSearchResult(
      result,
      camera,
      project.mapSettings.basemapRenderer,
      projectRenderViewport(project),
    );
    previewClock.stop();
    setPlaybackState('stopped');
    if (project.mapSettings.basemapRenderer === 'online' && mapMode === 'flat') {
      setSearchNavigation((current) => ({ id: (current?.id ?? 0) + 1, camera: target }));
    } else applyCameraEdit(target);
    rememberLocation(result);
    setNotice(`Navigated to ${result.name}`);
  };
  const addPinFromSearch = (result: SearchResult) => {
    const point = lngLatToMapMotionWorld(result.coordinates.longitude, result.coordinates.latitude);
    const layer = {
      ...createLayer('pin'),
      name: result.name,
      x: point.x,
      y: point.y,
    };
    updateProject((current) => addProjectLayer(current, layer));
    selectLayer(layer.id);
    rememberLocation(result);
    setNotice(`${result.name} Pin added`);
  };
  const addRegionFromSearch = (result: SearchResult) => {
    if (!result.geographicFeatureId) return;
    const region = GEOGRAPHIC_REGIONS.find((candidate) => candidate.id === result.geographicFeatureId);
    if (!region) return;
    const key = `${region.kind}:${region.id}`;
    const existing = findAdministrativeRegion(projectRef.current.layers, key);
    if (existing) {
      selectLayer(existing.id);
      focusLayerFromRow(existing);
      setNotice(`${existing.name} Region already exists`);
    } else {
      const layer = createGeographicRegionLayer(region);
      updateProject((current) => addProjectLayer(current, layer));
      selectLayer(layer.id);
      setNotice(`${layer.name} Region added`);
    }
    rememberLocation(result);
  };
  const exportProof = async () => {
    if (exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportState({ status: 'preparing', currentFrame: 0, totalFrames: 0, percentage: 0 });
    try {
      const outputPath = await saveFile({
        title: 'Export MapMotion Video',
        defaultPath: `${safeProjectName(project.metadata.name)}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (typeof outputPath !== 'string') {
        setExportState({ status: 'idle', currentFrame: 0, totalFrames: 0, percentage: 0 });
        return;
      }
      const result = await exportProjectVideo(project, outputPath, {
        mapMode,
        signal: controller.signal,
        onProgress: setExportState,
      });
      if (import.meta.env.DEV) {
        console.info('Video Export completed', {
          outputPath,
          requestedEncoder: result.requestedEncoder,
          actualEncoder: result.encoder,
          fallbackUsed: result.fallbackUsed,
          fallbackReason: result.fallbackReason,
          frames: result.totalFrames,
          durationSeconds: result.duration,
          totalMs: result.elapsedMs,
          effectiveFps: result.totalFrames / (result.elapsedMs / 1000),
          realTimeFactor: result.duration / (result.elapsedMs / 1000),
          prepareMs: result.prepareMs,
          renderMs: result.renderMs,
          evaluatorMs: result.evaluateMs,
          evaluatorMsPerFrame: result.evaluateMs / result.totalFrames,
          sceneMs: result.sceneMs,
          sceneMsPerFrame: result.sceneMs / result.totalFrames,
          serializeMs: result.serializeMs,
          serializeMsPerFrame: result.serializeMs / result.totalFrames,
          blobMs: result.blobMs,
          blobMsPerFrame: result.blobMs / result.totalFrames,
          imageDecodeMs: result.imageDecodeMs,
          imageDecodeMsPerFrame: result.imageDecodeMs / result.totalFrames,
          canvasDrawMs: result.canvasDrawMs,
          canvasDrawMsPerFrame: result.canvasDrawMs / result.totalFrames,
          rgbaExtractionMs: result.rgbaMs,
          rgbaExtractionMsPerFrame: result.rgbaMs / result.totalFrames,
          ipcAndStdinWriteMs: result.ipcWriteMs,
          ipcAndStdinWriteMsPerFrame: result.ipcWriteMs / result.totalFrames,
          finalizationMs: result.finalizationMs,
          outputBytes: result.native.outputBytes,
          ffmpegExitCode: result.native.exitCode,
        });
        const stages = {
          prepare: result.prepareMs,
          evaluator: result.evaluateMs,
          reactScene: result.sceneMs,
          svgSerialize: result.serializeMs,
          blob: result.blobMs,
          imageDecode: result.imageDecodeMs,
          canvasDraw: result.canvasDrawMs,
          rgbaReadback: result.rgbaMs,
          ipcAndFfmpegWrite: result.ipcWriteMs,
          finalization: result.finalizationMs,
        };
        console.table(
          Object.entries(stages).map(([stage, totalMs]) => ({
            stage,
            totalMs: Number(totalMs.toFixed(2)),
            msPerFrame: Number((totalMs / result.totalFrames).toFixed(3)),
            percentOfWallTime: Number(((totalMs / result.elapsedMs) * 100).toFixed(1)),
          })),
        );
      }
      setExportState((state) => ({
        ...state,
        status: 'completed',
        percentage: 100,
        elapsedMs: result.elapsedMs,
        etaSeconds: undefined,
        message: `Saved ${result.totalFrames} frames with ${result.encoderLabel} in ${formatExportDuration(result.elapsedMs)}.`,
      }));
      setNotice('Project video export completed');
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      setExportState((state) => ({
        ...state,
        status: cancelled ? 'cancelled' : 'failed',
        etaSeconds: undefined,
        message: cancelled
          ? 'Export cancelled. Partial output removed.'
          : conciseRuntimeError(error, 'FFmpeg exited unexpectedly.'),
      }));
      if (!cancelled && import.meta.env.DEV) console.error('Video Export failed', error);
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
            className={locationSearchOpen ? 'quiet active' : 'quiet'}
            onClick={() => setLocationSearchOpen((open) => !open)}
            title="Search locations (Ctrl+K)"
          >
            ⌕ Search
          </button>
          <button
            className="quiet"
            onClick={() => {
              setProject(createProject('Untitled documentary'));
              setProjectFilePath(null);
              setSelectedId(null);
              stopPlayback();
            }}
          >
            {words.new}
          </button>
          <button
            className="quiet"
            onClick={open}
            disabled={playbackState !== 'stopped'}
            title="Open a saved MapMotion working project."
          >
            Open Project
          </button>
          <button
            className="quiet"
            onClick={importProjectPackage}
            disabled={portableBusy || exportIsActive}
            title="Open a portable MapMotion package containing a project and its assets."
          >
            Import Package
          </button>
          <button
            className="quiet"
            onClick={exportProjectPackage}
            disabled={portableBusy || exportIsActive}
            title="Create a portable package containing the project and its assets for transfer or sharing."
          >
            Export Package
          </button>
          <button
            className="primary"
            onClick={save}
            disabled={playbackState !== 'stopped'}
            title={playbackState === 'stopped' ? 'Save Project' : 'Stop Preview before saving'}
          >
            Save Project
          </button>
          <label className="export-preset">
            <span>H.264 MP4 · Auto encoder</span>
            <strong>
              {frameFormat.label} · {frameFormat.exportWidth}×{frameFormat.exportHeight} ·{' '}
              {project.canvas.fps} FPS
            </strong>
          </label>
          <button className="export" onClick={exportProof} disabled={exportIsActive}>
            {exportIsActive ? 'Exporting…' : `${words.export} Video`}
          </button>
          <button className="lang" onClick={() => setLanguage((l) => (l === 'en' ? 'fa' : 'en'))}>
            {language === 'en' ? 'فا' : 'EN'}
          </button>
        </div>
      </header>
      <section
        className={`workspace ${layersPanelOpen ? 'layers-open' : 'layers-closed'} ${locationSearchOpen ? 'search-open' : ''}`}
      >
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
                <small>
                  {frameFormat.exportWidth} × {frameFormat.exportHeight} · {project.canvas.fps} FPS
                </small>
              </div>
            </div>
            <div className="panel-heading layers-heading">
              <span>{segmentContextLabel}</span>
              <span className="layer-count">{project.layers.length}</span>
            </div>
            <div className="segment-toolbar">
              <button
                type="button"
                className={`segment-eye ${allEyesHidden ? 'off' : ''}`}
                title="Temporarily hide/show all layers on the editing canvas (never affects Preview/Export)"
                onClick={() => setAllEyesHidden((v) => !v)}
              >
                {allEyesHidden ? '◌' : '👁'}
              </button>
              <label
                className={`segment-all ${projectMode ? 'presentation-only' : ''}`}
                title={
                  projectMode
                    ? 'All Project Layers are available in Map Mode. Select a View or Transition to configure playback usage.'
                    : 'Check/uncheck every layer for the selected segment'
                }
              >
                <input
                  type="checkbox"
                  ref={globalMembershipRef}
                  checked={segmentAllChecked}
                  disabled={allocationCheckboxDisabled}
                  onChange={toggleAllMembership}
                />
                All
              </label>
              <span className="segment-hint">
                {projectMode
                  ? 'Map Mode'
                  : editingTransitionIndex !== null
                    ? '☑ layers in this transition'
                    : editingViewIndex >= 0
                      ? '☑ layers in this View'
                      : 'select a View or Transition'}
              </span>
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
                  <div
                    key={layer.id}
                    className={`layer-row ${selectedId === layer.id ? 'selected' : ''}`}
                    onClick={() => focusLayerFromRow(layer)}
                  >
                    <button
                      type="button"
                      className={`layer-eye ${eyeHidden[layer.id] || allEyesHidden ? 'off' : ''}`}
                      title={
                        eyeHidden[layer.id] || allEyesHidden
                          ? 'Show on editing canvas'
                          : 'Hide on editing canvas'
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        setEyeHidden((h) => ({ ...h, [layer.id]: !h[layer.id] }));
                      }}
                    >
                      {eyeHidden[layer.id] || allEyesHidden ? '◌' : '👁'}
                    </button>
                    <input
                      type="checkbox"
                      className="layer-member"
                      checked={projectMode || segmentVisibleIds.has(layer.id)}
                      disabled={allocationCheckboxDisabled}
                      title={
                        projectMode
                          ? 'All Project Layers are available in Map Mode. Select a View or Transition to configure playback usage.'
                          : editingTransitionIndex !== null
                            ? 'Layer exists in this transition'
                            : editingViewIndex >= 0
                              ? 'Layer is shown in this View'
                              : 'Select a View or Transition'
                      }
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setSegmentMembership(layer.id, event.target.checked)}
                    />
                    <span className="layer-icon">{icons[layer.type]}</span>
                    <span className="layer-row-name">
                      <strong>{layer.name}</strong>
                      <small>{layerLabel[layer.type].toUpperCase()}</small>
                    </span>
                    <button
                      type="button"
                      className="layer-delete"
                      aria-label={`Delete ${layer.name}`}
                      title={`Delete ${layer.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void removeLayerById(layer.id);
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3.5 4.5h9M6 4.5V3h4v1.5m-5.5 0 .6 9h5.8l.6-9M6.8 7v4m2.4-4v4" />
                      </svg>
                    </button>
                    <span className="row-status">{layer.locked ? '▣' : '◉'}</span>
                  </div>
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
                aria-label="Experimental basemap renderer"
                value={project.mapSettings.basemapRenderer}
                onChange={(event) => {
                  const renderer = event.target.value as 'legacy' | 'online';
                  updateProject((current) => ({
                    ...current,
                    mapSettings: { ...current.mapSettings, basemapRenderer: renderer },
                  }));
                  setNotice(
                    renderer === 'online' ? 'Experimental OpenFreeMap renderer' : 'Legacy map renderer',
                  );
                }}
              >
                <option value="legacy">Legacy Map</option>
                <option value="online">Online OpenFreeMap</option>
              </select>
              {project.mapSettings.basemapRenderer === 'online' && (
                <select
                  aria-label="OpenFreeMap style"
                  value={project.mapSettings.onlineStyleId}
                  onChange={(event) => {
                    const onlineStyle = event.target.value as OnlineBasemapStyleId;
                    updateProject((current) => ({
                      ...current,
                      mapSettings: { ...current.mapSettings, onlineStyleId: onlineStyle },
                    }));
                    if (onlineStyle === '3d') setCamera(OPENFREEMAP_3D_CAMERA);
                  }}
                >
                  {OPENFREEMAP_STYLES.map((onlineStyle) => (
                    <option key={onlineStyle.id} value={onlineStyle.id}>
                      {onlineStyle.label}
                    </option>
                  ))}
                </select>
              )}
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
                <option value="en">English</option>
                <option value="fa">Persian</option>
                <option value="both">Persian + English</option>
                <option value="none">None</option>
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
                disabled={frameFormatLocked}
                title={
                  frameFormatLocked ? 'Frame size is locked after the first View is created.' : 'Frame size'
                }
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
                disabled={lockedMapMode === 'globe'}
                title={
                  lockedMapMode === 'globe'
                    ? 'View sequence is locked to Globe mode. Delete all Views to choose another map mode.'
                    : 'Use Flat map mode'
                }
                onClick={() => {
                  if (lockedMapMode === 'globe') return;
                  setMapMode('flat');
                  setNotice('Flat map mode');
                }}
              >
                Flat
              </button>
              <button
                className={mapMode === 'globe' ? 'active' : ''}
                disabled={lockedMapMode === 'flat'}
                title={
                  lockedMapMode === 'flat'
                    ? 'View sequence is locked to Flat mode. Delete all Views to choose another map mode.'
                    : 'Use Globe map mode'
                }
                onClick={() => {
                  if (lockedMapMode === 'flat') return;
                  setMapMode('globe');
                  setCamera((current) => roundCamera(cameraWithGlobeFocus(current)));
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
          <div className={`map-frame ${placing ? 'placing' : ''}`}>
            {project.mapSettings.basemapRenderer === 'online' ? (
              mapMode === 'flat' ? (
                <OnlinePreviewMap
                  clock={previewClock}
                  playbackState={playbackState}
                  project={project}
                  editingLayers={
                    allEyesHidden
                      ? []
                      : editingScene.layers
                          .filter((layer) => !eyeHidden[layer.id])
                          .map((layer) => ({ ...layer, visible: true }))
                  }
                  editingCamera={
                    searchNavigation
                      ? camera
                      : selectedTimelineEntity?.kind === 'view'
                        ? camera
                        : editingScene.camera
                  }
                  onCameraChange={handleCameraChange}
                  styleId={project.mapSettings.onlineStyleId}
                  labelLanguage={project.mapSettings.labelLanguage}
                  selectedId={selectedId}
                  onSelect={selectLayer}
                  onMovePin={(id, x, y) => updateLayer(id, { x, y })}
                  onBackgroundClick={(point) => {
                    if (placing === 'pin') placeLayerAt('pin', point);
                    else clearSelection();
                  }}
                  onRegionPoint={
                    placing === 'region' ? (point) => setRegionDraft((draft) => [...draft, point]) : undefined
                  }
                  onRegionFinish={
                    placing === 'region'
                      ? () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
                      : undefined
                  }
                  regionDraft={regionDraft}
                  assetUrls={assetUrls}
                  navigationRequest={searchNavigation}
                />
              ) : (
                <div className="online-map-unavailable" role="status">
                  Online OpenFreeMap is currently Flat-only. Select Legacy Map for Globe rendering.
                </div>
              )
            ) : (
              <FittedProjectFrame viewport={projectRenderViewport(project)}>
                <PreviewMap
                  clock={previewClock}
                  playbackState={playbackState}
                  project={project}
                  editingLayers={
                    allEyesHidden
                      ? []
                      : editingScene.layers
                          .filter((l) => !eyeHidden[l.id])
                          .map((l) => ({ ...l, visible: true }))
                  }
                  editingCamera={selectedTimelineEntity?.kind === 'view' ? camera : editingScene.camera}
                  mapProps={{
                    style,
                    mapMode,
                    onCameraChange: handleCameraChange,
                    labelLanguage: project.mapSettings.labelLanguage,
                    selectedId,
                    onSelect: selectLayer,
                    onMoveLayer: (id, x, y) => updateLayer(id, { x, y }),
                    onDeleteSelected: projectMode ? remove : undefined,
                    onBackgroundClick: (point) => {
                      if (placing && point) placeLayerAt(placing, point);
                      else clearSelection();
                    },
                    safeArea: project.canvas.safeArea,
                    showSafeArea: project.canvas.showSafeArea,
                    assetUrls,
                    editorMode: true,
                    viewBox: projectSceneViewBox(projectRenderViewport(project)),
                  }}
                />
              </FittedProjectFrame>
            )}
            <div className="add-toolbar">
              {layerTypes.map((type) => (
                <button
                  key={type}
                  className={placing === type ? 'active-tool' : ''}
                  onClick={() => void addLayer(type)}
                  title={type === 'pin' ? 'Add Pin — click the map to place it' : `Add ${layerLabel[type]}`}
                >
                  <b>{icons[type]}</b>
                  {layerLabel[type]}
                </button>
              ))}
            </div>
            {regionToolOpen && (
              <div className="region-tool-popover">
                <strong>Create Region</strong>
                <button
                  type="button"
                  onClick={() => {
                    setRegionToolOpen(false);
                    setRegionDraft([]);
                    setPlacing('region');
                    setNotice(
                      'Draw Custom Region: click vertices, Enter to finish, Backspace to undo, Esc to cancel',
                    );
                  }}
                >
                  Draw Custom Region
                </button>
                <input
                  aria-label="Search countries, provinces, and states"
                  placeholder="Search countries, provinces, states…"
                  value={regionSearch}
                  onChange={(event) => setRegionSearch(event.target.value)}
                />
                <div className="region-picker-results">
                  {searchAdministrativeRegions(regionSearch).map((region) => (
                    <button
                      key={`${region.kind}:${region.id}`}
                      type="button"
                      onClick={() => {
                        const key = `${region.kind}:${region.id}`;
                        const existing = findAdministrativeRegion(project.layers, key);
                        if (existing) {
                          selectLayer(existing.id);
                          setNotice(`${existing.name} is already a Region layer`);
                        } else {
                          const layer = createGeographicRegionLayer(region);
                          updateProject((current) => addProjectLayer(current, layer));
                          selectLayer(layer.id);
                          setNotice(`${layer.name} added as a geographic Region`);
                        }
                        setRegionToolOpen(false);
                        setRegionSearch('');
                      }}
                    >
                      <span>{region.name}</span>
                      <small>{region.kind === 'country' ? 'Country' : region.countryCode}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {placing && (
              <div className="placement-hint">
                {placing === 'region'
                  ? `Draw Region: ${regionDraft.length} vertices — Enter finishes, Backspace undoes, Esc cancels`
                  : `Click the map to place the ${layerLabel[placing]} — Esc to cancel`}
              </div>
            )}
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
                {exportState.elapsedMs !== undefined && (
                  <small>
                    Elapsed {formatExportDuration(exportState.elapsedMs)}
                    {exportState.etaSeconds !== undefined &&
                      ` · ~${formatExportDuration(exportState.etaSeconds * 1000)} remaining`}
                  </small>
                )}
                {exportState.message && <small>{exportState.message}</small>}
              </div>
              <progress max="100" value={exportState.percentage} />
              {exportIsActive && <button onClick={cancelExport}>Cancel</button>}
            </div>
          )}
        </section>
        {locationSearchOpen && (
          <SearchPanel
            focusRequest={locationSearchFocusRequest}
            recents={recentLocations}
            onClose={() => setLocationSearchOpen(false)}
            onGo={goToSearchResult}
            onAddPin={addPinFromSearch}
            onAddRegion={addRegionFromSearch}
          />
        )}
        <aside
          className={`panel right-panel ${playbackState !== 'stopped' ? 'preview-locked' : ''}`}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="panel-heading">
            <span>{words.properties}</span>
          </div>
          {playbackState !== 'stopped' && (
            <p className="preview-edit-lock">Stop Preview to edit View or Transition settings.</p>
          )}
          <CameraInspector
            camera={camera}
            mapMode={mapMode}
            renderer={project.mapSettings.basemapRenderer}
            disabled={playbackState !== 'stopped'}
            onChange={(patch) => setCamera((current) => roundCamera({ ...current, ...patch }))}
          />
          {!projectMode && selectedTransition && (
            <TransitionInspector
              transition={selectedTransition}
              fromName={project.views.find((view) => view.id === selectedTransition.fromViewId)?.name ?? ''}
              toName={project.views.find((view) => view.id === selectedTransition.toViewId)?.name ?? ''}
              onChange={(patch) => playbackState === 'stopped' && updateSelectedTransition(patch)}
            />
          )}
          {!projectMode && !selectedTransition && activeView && (
            <ViewInspector
              view={activeView}
              onChange={(patch) => playbackState === 'stopped' && updateTransition(patch)}
            />
          )}
          {selected ? (
            <Inspector
              layer={selected}
              onChange={(patch) => updateLayer(selected.id, patch)}
              onDuplicate={duplicate}
              onRemove={remove}
              canRemove={projectMode}
              onMove={move}
              assetUrls={assetUrls}
              onAddAsset={(asset) =>
                updateProject((p) => ({
                  ...p,
                  assets: p.assets.some((a) => a.id === asset.id) ? p.assets : [...p.assets, asset],
                }))
              }
              transitionContext={
                !projectMode && editingTransitionIndex !== null && project.transitions[editingTransitionIndex]
                  ? (() => {
                      const transition = project.transitions[editingTransitionIndex];
                      const sourceView = project.views.find((view) => view.id === transition.fromViewId)!;
                      const destView = project.views.find((view) => view.id === transition.toViewId)!;
                      const compiledIndex = sequence.segments.findIndex(
                        (segment) => segment.kind === 'transition' && segment.id === transition.id,
                      );
                      const memberIds = (segment: (typeof sequence.segments)[number] | undefined) =>
                        segment?.kind === 'view'
                          ? viewMemberIds(segment.view)
                          : segment?.kind === 'transition'
                            ? transitionMemberIds(segment.transition)
                            : new Set<string>();
                      const sourceMembers = memberIds(sequence.segments[compiledIndex - 1]);
                      const destMembers = memberIds(sequence.segments[compiledIndex + 1]);
                      return {
                        transitionIndex: editingTransitionIndex,
                        fromName: sourceView.name,
                        toName: destView?.name ?? '',
                        inTransition: segmentVisibleIds.has(selected.id),
                        continuouslyVisible: sourceMembers.has(selected.id),
                        anim: transitionAnimOf(transition, selected.id),
                        warnings: validateTransitionLayer({
                          sourceMemberIds: sourceMembers,
                          transitionIncluded: segmentVisibleIds.has(selected.id),
                          destMemberIds: destMembers,
                          layerId: selected.id,
                          anim: transitionAnimOf(transition, selected.id),
                          transitionDuration: transition.duration,
                        }),
                        onSetMembership: (inTransition) => setSegmentMembership(selected.id, inTransition),
                        onPatchAnim: (patch) => patchTransitionAnim(selected.id, patch),
                      };
                    })()
                  : undefined
              }
              viewContext={
                !projectMode &&
                editingTransitionIndex === null &&
                editingViewIndex >= 0 &&
                project.views[editingViewIndex]
                  ? (() => {
                      const activeView = project.views[editingViewIndex];
                      return {
                        viewIndex: editingViewIndex,
                        viewName: activeView.name,
                        holdDuration: activeView.holdDuration,
                        inView: segmentVisibleIds.has(selected.id),
                        anim: viewAnimOf(activeView, selected.id),
                        warnings: validateViewLayer({
                          viewIncluded: segmentVisibleIds.has(selected.id),
                          anim: viewAnimOf(activeView, selected.id),
                          holdDuration: activeView.holdDuration,
                        }),
                        onSetMembership: (inView) => setSegmentMembership(selected.id, inView),
                        onPatchAnim: (patch) => patchViewAnim(selected.id, patch),
                      };
                    })()
                  : undefined
              }
            />
          ) : projectMode ? (
            <div className="inspector">
              <span className="inspector-icon">◌</span>
              <strong>MAP MODE</strong>
              <p>Select a Project Layer to edit its global properties.</p>
            </div>
          ) : null}
        </aside>
      </section>
      <TimelinePanel>
        <PreviewTimelineRuntime
          clock={previewClock}
          playbackState={playbackState}
          project={project}
          timelineZoom={timelineZoom}
          scrollerRef={timelineScrollRef}
        />
        <TimelineToolbar>
          <label
            className="project-mode-toggle"
            title="Edit Project Layers without editing a View or Transition."
          >
            <input
              type="checkbox"
              checked={projectMode}
              disabled={playbackState !== 'stopped'}
              onChange={(event) => toggleProjectMode(event.target.checked)}
            />
            Map Mode
          </label>
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
              onClick={stopPlayback}
              disabled={project.views.length < 1}
              aria-label="Stop preview"
              title="Stop"
            >
              ⏹
            </button>
          </div>
          <button type="button" onClick={() => setLayersPanelOpen((open) => !open)}>
            Layers
          </button>
          <select
            aria-label="Canvas format"
            value={project.canvas.layoutId}
            disabled={frameFormatLocked}
            title={frameFormatLocked ? 'Frame size is locked after the first View is created.' : 'Frame size'}
            onChange={(e) => setCanvasLayout(e.target.value as Project['canvas']['layoutId'])}
          >
            {CANVAS_LAYOUTS.map((layout) => (
              <option key={layout.id} value={layout.id}>
                {layout.name}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
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
          <span className="timeline-preview-state">
            {playbackState !== 'stopped'
              ? `${formatTimelineTime(previewClock.getSnapshot())} / ${formatTimelineTime(sequence.duration)} · ${
                  activePreviewTransitionIndex(project, previewClock.getSnapshot()) !== null
                    ? `Transition ${activePreviewTransitionIndex(project, previewClock.getSnapshot())! + 1} → ${activePreviewTransitionIndex(project, previewClock.getSnapshot())! + 2}`
                    : `View ${evaluateProjectAtTime(project, previewClock.getSnapshot()).activeViewIndex + 1}`
                } · ${playbackState}`
              : projectMode
                ? 'Map Mode · Project Layers'
                : selectedTransition
                  ? `Editing Transition ${project.views.findIndex((view) => view.id === selectedTransition.fromViewId) + 1} → ${project.views.findIndex((view) => view.id === selectedTransition.toViewId) + 1}`
                  : activeView
                    ? `Editing ${activeView.name}`
                    : 'Create a View to preview'}
          </span>
        </TimelineToolbar>
        <TimelineViewport>
          <div ref={timelineScrollRef} className="timeline-scroll">
            <div
              className="timeline-scrub-track"
              style={{ width: timelineLayout.width }}
              role="slider"
              aria-label="Preview scrub track"
              aria-valuemin={0}
              aria-valuemax={sequence.duration}
              aria-valuenow={previewClock.getSnapshot()}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                scrubTimeline(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubTimeline(event);
              }}
            >
              {playbackState !== 'stopped' && (
                <span
                  className="scrub-playhead"
                  style={{ left: timelinePosition(project, previewClock.getSnapshot(), timelineZoom) }}
                />
              )}
            </div>
            <div className="timeline-track" style={{ width: timelineLayout.width }}>
              {project.views.length > 0 && playbackState !== 'stopped' && (
                <div
                  className="timeline-playhead"
                  style={{ left: timelinePosition(project, previewClock.getSnapshot(), timelineZoom) }}
                  aria-label={`Playhead at ${formatTimelineTime(previewClock.getSnapshot())}`}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    scrubTimeline(event);
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubTimeline(event);
                  }}
                >
                  <span />
                </div>
              )}
              {project.views.map((view, index) => {
                const transition = project.transitions.find(
                  (candidate) =>
                    candidate.fromViewId === view.id && candidate.toViewId === project.views[index + 1]?.id,
                );
                const cardWidth = timelineLayout.items.find((item) => item.id === view.id)?.width ?? 0;
                const isLast = index === project.views.length - 1;
                const transitionLayerIds = transition ? transitionMemberIds(transition) : new Set<string>();
                const animatedTransitionLayers = transition
                  ? Object.entries(transitionLayerConfigsOf(transition)).filter(
                      ([layerId, config]) =>
                        config.included && config.animation && transitionLayerIds.has(layerId),
                    ).length
                  : 0;
                return (
                  <Fragment key={view.id}>
                    <div
                      data-view-id={view.id}
                      className={`view-card ${activeViewId === view.id ? 'active' : ''}`}
                      style={{ flex: `0 0 ${cardWidth}px` }}
                      draggable
                      tabIndex={0}
                      onClick={() => {
                        if (playbackState !== 'stopped') return;
                        activateView(view.id);
                      }}
                      onKeyDown={(event) => {
                        if (playbackState !== 'stopped') return;
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
                      <span
                        className="view-thumb"
                        style={{ background: view.thumbnailColor, aspectRatio: frameFormat.aspectRatio }}
                      >
                        {viewThumbnails[view.id] && (
                          <img
                            src={viewThumbnails[view.id]}
                            alt={`${view.name} thumbnail`}
                            draggable={false}
                          />
                        )}
                        <span className="view-thumb-index">{String(index + 1).padStart(2, '0')}</span>
                        {activeViewId === view.id && activeViewStale && (
                          <span
                            className="view-stale-badge"
                            title="The camera differs from this View. Choose Update View to save the current camera position."
                          >
                            ●
                          </span>
                        )}
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
                        <span className="view-duration-exact">
                          Hold{' '}
                          <input
                            className="timeline-duration-input"
                            type="number"
                            min="0"
                            max="60"
                            step="0.5"
                            value={view.holdDuration}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const value = Math.max(0, Number(e.target.value));
                              updateProject((p) => ({
                                ...p,
                                views: p.views.map((v) =>
                                  v.id === view.id ? { ...v, holdDuration: value } : v,
                                ),
                              }));
                            }}
                          />{' '}
                          s
                        </span>
                        {isLast && 'final View'}
                      </small>
                      {openViewMenuId === view.id && (
                        <div
                          className="view-card-menu"
                          role="menu"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              updateView();
                              setOpenViewMenuId(null);
                            }}
                            role="menuitem"
                            title="Saves the current camera position to this View. Layer properties are project-global and need no capture."
                          >
                            Update View
                          </button>
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
                    {!isLast && transition && (
                      <div
                        role="button"
                        tabIndex={0}
                        className={`view-transition ${selectedTransitionId === transition.id ? 'selected' : ''}`}
                        style={{
                          flex: `0 0 ${timelineLayout.items.find((item) => item.id === transition.id)?.width ?? 0}px`,
                        }}
                        data-transition-index={index}
                        title={`Transition ${view.name} → ${project.views[index + 1].name}: ${transition.duration.toFixed(1)}s ${transitionTypeLabel(transition.type)} — click to edit`}
                        onClick={() => {
                          if (playbackState !== 'stopped') return;
                          selectTransition(transition.id);
                        }}
                        onKeyDown={(event) => {
                          if (playbackState !== 'stopped') return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            selectTransition(transition.id);
                          }
                        }}
                      >
                        <strong>{transition.duration.toFixed(1)}s</strong>
                        <small>{transitionTypeLabel(transition.type)}</small>
                        {animatedTransitionLayers > 0 && (
                          <small
                            className="transition-anim-count"
                            title={`${animatedTransitionLayers} animated layer(s) in this transition`}
                          >
                            ● {animatedTransitionLayers}
                          </small>
                        )}
                      </div>
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
      </TimelinePanel>
      {playbackState === 'stopped' &&
        !projectMode &&
        transitionPopoverId === selectedTransitionId &&
        selectedTransitionIndex !== null &&
        project.transitions[selectedTransitionIndex] && (
          <TransitionPopover
            index={selectedTransitionIndex}
            transition={project.transitions[selectedTransitionIndex]}
            fromName={
              project.views.find(
                (view) => view.id === project.transitions[selectedTransitionIndex].fromViewId,
              )?.name ?? ''
            }
            toName={
              project.views.find((view) => view.id === project.transitions[selectedTransitionIndex].toViewId)
                ?.name ?? ''
            }
            onChange={(patch) => updateSelectedTransition(patch)}
            onClose={() => setTransitionPopoverId(null)}
          />
        )}
      {customFrameDraft &&
        createPortal(
          <div className="frame-format-dialog-backdrop" role="presentation">
            <form
              className="frame-format-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="custom-frame-title"
              onSubmit={(event) => {
                event.preventDefault();
                applyCustomFrame();
              }}
            >
              <h2 id="custom-frame-title">Custom Frame Size</h2>
              <p>Use even dimensions between 240 and 2160 pixels for H.264 export.</p>
              <div className="frame-format-fields">
                <label>
                  Width
                  <input
                    autoFocus
                    type="number"
                    min="240"
                    max="2160"
                    step="2"
                    value={customFrameDraft.width}
                    onChange={(event) =>
                      setCustomFrameDraft((current) =>
                        current ? { ...current, width: event.target.value } : current,
                      )
                    }
                  />
                </label>
                <span>×</span>
                <label>
                  Height
                  <input
                    type="number"
                    min="240"
                    max="2160"
                    step="2"
                    value={customFrameDraft.height}
                    onChange={(event) =>
                      setCustomFrameDraft((current) =>
                        current ? { ...current, height: event.target.value } : current,
                      )
                    }
                  />
                </label>
              </div>
              <small>
                Aspect ratio:{' '}
                {Number(customFrameDraft.width) > 0 && Number(customFrameDraft.height) > 0
                  ? (Number(customFrameDraft.width) / Number(customFrameDraft.height)).toFixed(3)
                  : '—'}
              </small>
              <div className="frame-format-dialog-actions">
                <button type="button" onClick={() => setCustomFrameDraft(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Apply Frame Size
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </main>
  );
}

function usePreviewClockTime(clock: PreviewClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}

function FittedProjectFrame({ viewport, children }: { viewport: LogicalViewport; children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [display, setDisplay] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const next = fitProjectViewport(viewport, stage.clientWidth, stage.clientHeight);
      setDisplay((current) =>
        Math.abs(current.width - next.displayWidth) < 0.01 &&
        Math.abs(current.height - next.displayHeight) < 0.01
          ? current
          : { width: next.displayWidth, height: next.displayHeight },
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [viewport.aspectRatio, viewport.height, viewport.width]);
  return (
    <div ref={stageRef} className="project-frame-stage">
      <div className="project-frame-display" style={{ width: display.width, height: display.height }}>
        {children}
      </div>
    </div>
  );
}

function activePreviewTransitionIndex(project: Project, time: number) {
  const resolved = resolveTimelineAtTime(buildTimelineLayout(project), time);
  if (!resolved || resolved.item.kind !== 'transition') return null;
  const index = project.transitions.findIndex((transition) => transition.id === resolved.item.id);
  return index >= 0 ? index : null;
}

function PreviewMap({
  clock,
  playbackState,
  project,
  editingLayers,
  editingCamera,
  mapProps,
}: {
  clock: PreviewClock;
  playbackState: PlaybackState;
  project: Project;
  editingLayers: Layer[];
  editingCamera: CameraState;
  mapProps: Omit<React.ComponentProps<typeof OfflineMap>, 'layers' | 'camera' | 'interactionEnabled'>;
}) {
  const time = usePreviewClockTime(clock);
  const previewState = playbackState === 'stopped' ? null : evaluateProjectAtTime(project, Math.max(0, time));
  return (
    <OfflineMap
      {...mapProps}
      mapMode={previewState?.mapMode ?? mapProps.mapMode}
      layers={previewState?.layers ?? editingLayers}
      camera={previewState?.camera ?? editingCamera}
      interactionEnabled={playbackState === 'stopped'}
    />
  );
}

function OnlinePreviewMap({
  clock,
  playbackState,
  project,
  editingLayers,
  editingCamera,
  onCameraChange,
  styleId,
  labelLanguage,
  selectedId,
  onSelect,
  onMovePin,
  onBackgroundClick,
  onRegionPoint,
  onRegionFinish,
  regionDraft,
  assetUrls,
  navigationRequest,
}: {
  clock: PreviewClock;
  playbackState: PlaybackState;
  project: Project;
  editingLayers: Layer[];
  editingCamera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  styleId: OnlineBasemapStyleId;
  labelLanguage: Project['mapSettings']['labelLanguage'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMovePin: (id: string, x: number, y: number) => void;
  onBackgroundClick: (point: { x: number; y: number }) => void;
  onRegionPoint?: (point: [number, number]) => void;
  onRegionFinish?: () => void;
  regionDraft?: [number, number][];
  assetUrls: Readonly<Record<string, string>>;
  navigationRequest?: { id: number; camera: CameraState } | null;
}) {
  const time = usePreviewClockTime(clock);
  const previewState = playbackState === 'stopped' ? null : evaluateProjectAtTime(project, Math.max(0, time));
  return (
    <OnlineOpenFreeMap
      camera={previewState?.camera ?? editingCamera}
      onCameraChange={onCameraChange}
      styleId={styleId}
      labelLanguage={labelLanguage}
      interactionEnabled={playbackState === 'stopped'}
      viewport={projectRenderViewport(project)}
      layers={previewState?.layers ?? editingLayers}
      selectedId={playbackState === 'stopped' ? selectedId : null}
      onSelect={onSelect}
      onMovePin={onMovePin}
      onBackgroundClick={onBackgroundClick}
      onRegionPoint={onRegionPoint}
      onRegionFinish={onRegionFinish}
      regionDraft={regionDraft}
      assetUrls={assetUrls}
      navigationRequest={navigationRequest}
    />
  );
}

/** Keeps display-rate timeline work local and uses direct scrolling so rAF ticks
 * never stack browser smooth-scroll animations. */
function PreviewTimelineRuntime({
  clock,
  playbackState,
  project,
  timelineZoom,
  scrollerRef,
}: {
  clock: PreviewClock;
  playbackState: PlaybackState;
  project: Project;
  timelineZoom: number;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const time = usePreviewClockTime(clock);
  const sequence = useMemo(() => compileTimeline(project), [project]);
  useLayoutEffect(() => {
    if (playbackState === 'stopped') return;
    const position = timelinePosition(project, time, timelineZoom);
    document.querySelectorAll<HTMLElement>('.scrub-playhead, .timeline-playhead').forEach((element) => {
      element.style.left = `${position}px`;
    });
    const activeTransition = activePreviewTransitionIndex(project, time);
    document.querySelectorAll<HTMLElement>('.view-transition.active').forEach((element) => {
      element.classList.remove('active');
    });
    if (activeTransition !== null)
      document
        .querySelector<HTMLElement>(`[data-transition-index="${activeTransition}"]`)
        ?.classList.add('active');
    const preview = evaluateProjectAtTime(project, time);
    const status = document.querySelector<HTMLElement>('.timeline-preview-state');
    if (status)
      status.textContent = `${formatTimelineTime(time)} / ${formatTimelineTime(sequence.duration)} · ${
        activeTransition === null
          ? `View ${preview.activeViewIndex + 1}`
          : `Transition ${activeTransition + 1} → ${activeTransition + 2}`
      } · ${playbackState}`;
    const scroller = scrollerRef.current;
    if (!scroller || playbackState !== 'playing') return;
    const edgePadding = 56;
    if (position < scroller.scrollLeft + edgePadding)
      scroller.scrollLeft = Math.max(0, position - edgePadding);
    else if (position > scroller.scrollLeft + scroller.clientWidth - edgePadding)
      scroller.scrollLeft = position - scroller.clientWidth + edgePadding;
  }, [playbackState, project, scrollerRef, sequence, time, timelineZoom]);
  return null;
}

function TimelinePanel({ children }: { children: React.ReactNode }) {
  return (
    <footer className="timeline-panel" aria-label="Timeline">
      {children}
    </footer>
  );
}

const TRANSITION_POPOVER_WIDTH = 188;
const TRANSITION_POPOVER_MARGIN = 8;

function TransitionSpeedInput({
  transition,
  onChange,
}: {
  transition: Transition;
  onChange: (patch: Partial<Pick<Transition, 'duration' | 'speed' | 'preset' | 'type'>>) => void;
}) {
  const speed = transitionDisplaySpeed(transition);
  const range = transitionSpeedRange(transition.referenceDuration);
  const formatted = speed === null ? '' : speed.toFixed(3);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const commit = (value = draft) => {
    const parsed = Number(value);
    if (value.trim() && Number.isFinite(parsed)) onChange({ speed: parsed });
    else setDraft(formatted);
  };
  return (
    <label>
      Speed
      <span>
        <input
          className="transition-speed-input"
          type="number"
          min={range.min}
          max={range.max}
          step={TRANSITION_SPEED_STEP}
          value={draft}
          disabled={speed === null}
          placeholder={'\u2014'}
          title="Relative transition speed. Changing Speed updates Duration automatically."
          onChange={(event) => {
            setDraft(event.target.value);
            if (!(event.nativeEvent as InputEvent).inputType) commit(event.target.value);
          }}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
          }}
          onWheel={(event) => event.stopPropagation()}
        />
        {'\u00d7'}
      </span>
    </label>
  );
}

function TransitionDurationInput({
  transition,
  onChange,
  timeline = false,
}: {
  transition: Transition;
  onChange: (patch: Partial<Pick<Transition, 'duration' | 'speed' | 'preset' | 'type'>>) => void;
  timeline?: boolean;
}) {
  const formatted = transition.duration.toFixed(3);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const commit = (value = draft) => {
    const parsed = Number(value);
    if (value.trim() && Number.isFinite(parsed)) onChange({ duration: parsed });
    else setDraft(formatted);
  };
  return (
    <input
      className={timeline ? 'timeline-duration-input' : undefined}
      type="number"
      min={MIN_TRANSITION_DURATION}
      max={MAX_TRANSITION_DURATION}
      step="0.001"
      value={draft}
      title="Changing Duration updates Speed automatically."
      onChange={(event) => {
        setDraft(event.target.value);
        if (!(event.nativeEvent as InputEvent).inputType) commit(event.target.value);
      }}
      onBlur={() => commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value);
      }}
    />
  );
}

/**
 * Transition settings popover rendered through a portal into the document
 * body, so it is never clipped by the timeline's overflow container.
 * Positioned from the anchor segment's bounding rect; opens downward when
 * there is room, otherwise upward. Closes on outside click and Esc, and
 * repositions on window resize and container scroll.
 */
function TransitionPopover({
  index,
  transition,
  fromName,
  toName,
  onChange,
  onClose,
}: {
  index: number;
  transition: Transition;
  fromName: string;
  toName: string;
  onChange: (patch: Partial<Pick<Transition, 'duration' | 'speed' | 'preset' | 'type'>>) => void;
  onClose: () => void;
}) {
  const [position, setPosition] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const updatePosition = useCallback(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-transition-index="${index}"]`);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = bodyRef.current?.offsetHeight ?? 148;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < height + TRANSITION_POPOVER_MARGIN * 2;
    const top = openUp
      ? Math.max(TRANSITION_POPOVER_MARGIN, rect.top - height - TRANSITION_POPOVER_MARGIN)
      : rect.bottom + TRANSITION_POPOVER_MARGIN;
    const left = Math.min(
      Math.max(TRANSITION_POPOVER_MARGIN, rect.left + rect.width / 2 - TRANSITION_POPOVER_WIDTH / 2),
      window.innerWidth - TRANSITION_POPOVER_WIDTH - TRANSITION_POPOVER_MARGIN,
    );
    setPosition({ top, left, openUp });
  }, [index]);
  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    const scroller = document.querySelector<HTMLElement>('.timeline-scroll');
    scroller?.addEventListener('scroll', updatePosition, { passive: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (bodyRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-transition-index]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      scroller?.removeEventListener('scroll', updatePosition);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    };
  }, [updatePosition, onClose]);
  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, transition.duration, transition.speed, transition.preset, transition.type]);
  if (!position) return null;
  return createPortal(
    <div
      ref={bodyRef}
      className={`view-transition-popover ${position.openUp ? 'open-up' : ''}`}
      role="dialog"
      aria-label={`Transition ${fromName} → ${toName}`}
      style={{ top: position.top, left: position.left }}
    >
      <strong className="transition-popover-title">
        {fromName} → {toName}
      </strong>
      <label>
        Duration
        <span>
          <TransitionDurationInput transition={transition} onChange={onChange} timeline />s
        </span>
      </label>
      <TransitionSpeedInput transition={transition} onChange={onChange} />
      <label>
        Type
        <select
          value={transition.type}
          onChange={(e) => onChange({ type: e.target.value as Transition['type'] })}
        >
          <option value="smooth">Smooth</option>
          <option value="pan">Pan</option>
          <option value="zoom">Zoom</option>
          <option value="fly-to">Fly To</option>
        </select>
      </label>
      <label>
        Easing
        <select
          value={transition.preset}
          onChange={(e) => onChange({ preset: e.target.value as Transition['preset'] })}
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
    </div>,
    document.body,
  );
}

function TimelineToolbar({ children }: { children: React.ReactNode }) {
  return <div className="timeline-toolbar">{children}</div>;
}

function TimelineViewport({ children }: { children: React.ReactNode }) {
  return <div className="timeline-viewport">{children}</div>;
}

function transitionTypeLabel(type: Transition['type']) {
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

function safeProjectName(name: string) {
  return name.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'MapMotion project';
}

function conciseRuntimeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim();
  return firstLine && firstLine !== '[object Object]' ? firstLine : fallback;
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

function CameraInspector({
  camera,
  mapMode,
  renderer,
  disabled,
  onChange,
}: {
  camera: CameraState;
  mapMode: MapMode;
  renderer: BasemapRenderer;
  disabled: boolean;
  onChange: (patch: Partial<CameraState>) => void;
}) {
  const bearing = camera.bearing ?? 0;
  const pitch = camera.pitch ?? 0;
  const inspectorPitch = Math.min(MAX_CAMERA_PITCH, Math.max(0, pitch));
  const zoomRange = getCameraZoomRange(renderer);
  const inspectorZoom = Math.min(zoomRange.max, Math.max(zoomRange.min, camera.zoom));
  const pendingPatch = useRef<Partial<CameraState> | null>(null);
  const pendingFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    },
    [],
  );
  const scheduleChange = (patch: Partial<CameraState>) => {
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    if (pendingFrame.current !== null) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      const latest = pendingPatch.current;
      pendingPatch.current = null;
      if (latest) onChange(latest);
    });
  };
  const schedulePitchChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    scheduleChange({ pitch: Math.min(MAX_CAMERA_PITCH, Math.max(0, value)) });
  };
  const scheduleZoomChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    scheduleChange(cameraAtZoomForRenderer(camera, value, renderer));
  };
  return (
    <div className="layer-inspector camera-inspector">
      <span className="type-chip">Camera</span>
      <label>
        Zoom
        <input
          type="range"
          min={Math.log2(zoomRange.min)}
          max={Math.log2(zoomRange.max)}
          step="0.01"
          value={Math.log2(inspectorZoom)}
          disabled={disabled}
          onChange={(event) => scheduleZoomChange(Math.pow(2, Number(event.target.value)))}
        />
        <input
          type="number"
          min={zoomRange.min}
          max={zoomRange.max}
          step="0.1"
          value={Number(inspectorZoom.toPrecision(8))}
          disabled={disabled}
          onChange={(event) => scheduleZoomChange(Number(event.target.value))}
        />
      </label>
      {mapMode === 'flat' ? (
        <>
          <label>
            Bearing
            <input
              type="number"
              step="1"
              value={bearing}
              disabled={disabled}
              onChange={(event) => scheduleChange({ bearing: Number(event.target.value) })}
            />
          </label>
          <button
            type="button"
            disabled={disabled || bearing === 0}
            onClick={() => scheduleChange({ bearing: 0 })}
          >
            Reset Bearing
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            scheduleChange({
              globeOrientation: { x: 0, y: 0, z: 0, w: 1 },
              globeFocus: { x: 1, y: 0, z: 0 },
            })
          }
        >
          Reset Globe Orientation
        </button>
      )}
      <label>
        Pitch
        <input
          type="range"
          min={0}
          max={MAX_CAMERA_PITCH}
          step="1"
          value={inspectorPitch}
          disabled={disabled}
          onChange={(event) => schedulePitchChange(Number(event.target.value))}
        />
        <input
          type="number"
          min={0}
          max={MAX_CAMERA_PITCH}
          step="1"
          value={inspectorPitch}
          disabled={disabled}
          onChange={(event) => schedulePitchChange(Number(event.target.value))}
        />
      </label>
      <button type="button" disabled={disabled || pitch === 0} onClick={() => scheduleChange({ pitch: 0 })}>
        Reset Pitch
      </button>
      <p className="transition-hint">
        {mapMode === 'flat'
          ? '0° is north-up; positive values rotate clockwise.'
          : 'Pitch moves the observer. Dragging rotates the physical Globe independently.'}
      </p>
    </div>
  );
}

function ViewInspector({
  view,
  onChange,
}: {
  view: View;
  onChange: (patch: Partial<Pick<View, 'holdDuration'>>) => void;
}) {
  return (
    <div className="layer-inspector view-inspector">
      <span className="type-chip">View</span>
      <strong>{view.name}</strong>
      <label>
        Hold (s)
        <input
          type="number"
          min="0"
          max="60"
          step="0.5"
          value={view.holdDuration}
          onChange={(event) => onChange({ holdDuration: Math.max(0, Number(event.target.value)) })}
        />
      </label>
      <p className="transition-hint">Update View saves the current camera position only.</p>
    </div>
  );
}

function TransitionInspector({
  transition,
  fromName,
  toName,
  onChange,
}: {
  transition: Transition;
  fromName: string;
  toName: string;
  onChange: (patch: Partial<Pick<Transition, 'duration' | 'speed' | 'preset' | 'type'>>) => void;
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
        Duration (s)
        <TransitionDurationInput transition={transition} onChange={onChange} />
      </label>
      <TransitionSpeedInput transition={transition} onChange={onChange} />
      <label>
        Type
        <select
          value={transition.type}
          onChange={(e) => onChange({ type: e.target.value as Transition['type'] })}
        >
          <option value="smooth">Smooth</option>
          <option value="pan">Pan</option>
          <option value="zoom">Zoom</option>
          <option value="fly-to">Fly To</option>
        </select>
      </label>
      <label>
        Easing
        <select
          value={transition.preset}
          onChange={(e) => onChange({ preset: e.target.value as Transition['preset'] })}
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
      <p className="transition-hint">
        Applies to the camera motion leaving {fromName}. Select a layer in the Layers panel to configure its
        Appear / Hold / Wipe Out animation within this transition.
      </p>
    </div>
  );
}

interface TransitionLayerContext {
  transitionIndex: number;
  fromName: string;
  toName: string;
  inTransition: boolean;
  continuouslyVisible: boolean;
  anim: import('../core/project').SegmentLayerAnimation | undefined;
  warnings: SegmentWarning[];
  onSetMembership: (inTransition: boolean) => void;
  onPatchAnim: (patch: Partial<import('../core/project').SegmentLayerAnimation>) => void;
}

interface ViewLayerContext {
  viewIndex: number;
  viewName: string;
  holdDuration: number;
  inView: boolean;
  anim: import('../core/project').SegmentLayerAnimation | undefined;
  warnings: SegmentWarning[];
  onSetMembership: (inView: boolean) => void;
  onPatchAnim: (patch: Partial<import('../core/project').SegmentLayerAnimation>) => void;
}

function HexColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const canonical = normalizeHexColor(value) ?? '#FFFFFF';
  return (
    <span className="hex-color-control">
      <input
        type="color"
        value={canonical}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <input
        key={canonical}
        type="text"
        aria-label="HEX color"
        defaultValue={canonical}
        maxLength={7}
        spellCheck={false}
        onChange={(event) => {
          const next = normalizeHexColor(event.target.value);
          if (next) onChange(next);
        }}
        onBlur={(event) => {
          const next = normalizeHexColor(event.target.value);
          if (next) onChange(next);
          else event.currentTarget.value = canonical;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </span>
  );
}

function RegionTimelineControls({
  layer,
  transitionContext,
  viewContext,
}: {
  layer: Layer;
  transitionContext?: TransitionLayerContext;
  viewContext?: ViewLayerContext;
}) {
  const context = transitionContext ?? viewContext;
  if (!context) return null;
  const included = transitionContext ? transitionContext.inTransition : viewContext!.inView;
  const canAnimate = transitionContext != null || (viewContext?.holdDuration ?? 0) > 0;
  const anim = context.anim;
  const patch = context.onPatchAnim;
  return (
    <div className="pin-section transition-layer-section" data-region-timeline-settings>
      <span className="pin-section-title">
        {transitionContext ? 'Transition Layer Settings' : 'Timeline Settings'}
      </span>
      <label className="toggle">
        <span>Included</span>
        <input
          type="checkbox"
          checked={included}
          onChange={(event) => context.onSetMembership(event.target.checked)}
        />
      </label>
      {included && canAnimate && (
        <>
          <label className="toggle">
            <span>Enable Appear</span>
            <input
              type="checkbox"
              checked={Boolean(anim?.appearEnabled)}
              onChange={(event) => patch({ appearEnabled: event.target.checked })}
            />
          </label>
          {anim?.appearEnabled && (
            <>
              <label>
                Region Effect
                <select
                  value={anim.regionEffect ?? 'fade'}
                  onChange={(event) =>
                    patch({ regionEffect: event.target.value as NonNullable<typeof anim>['regionEffect'] })
                  }
                >
                  <option value="fade">Fade</option>
                  <option value="draw-border">Draw Border</option>
                  <option value="pulse">Pulse</option>
                </select>
              </label>
              {anim.regionEffect === 'draw-border' && (
                <>
                  {layer.regionStrokeExists !== false && (
                    <>
                      <label>
                        Order
                        <select
                          value={anim.regionDrawOrder ?? 'before-fill'}
                          onChange={(event) =>
                            patch({ regionDrawOrder: event.target.value as 'before-fill' | 'after-fill' })
                          }
                        >
                          <option value="before-fill">Before Fill</option>
                          <option value="after-fill">After Fill</option>
                        </select>
                      </label>
                      <div className="two-col">
                        <RegionTimingField
                          label="Drawing Delay"
                          value={anim.regionDrawingDelay ?? 0}
                          onChange={(value) => patch({ regionDrawingDelay: value })}
                        />
                        <RegionTimingField
                          label="Drawing Duration"
                          value={anim.regionDrawingDuration ?? 1.5}
                          onChange={(value) => patch({ regionDrawingDuration: value })}
                        />
                      </div>
                    </>
                  )}
                  {layer.regionFillMode !== 'none' && (
                    <div className="two-col">
                      <RegionTimingField
                        label="Filling Delay"
                        value={anim.regionFillingDelay ?? 0}
                        onChange={(value) => patch({ regionFillingDelay: value })}
                      />
                      <RegionTimingField
                        label="Filling Duration"
                        value={anim.regionFillingDuration ?? 1.5}
                        onChange={(value) => patch({ regionFillingDuration: value })}
                      />
                    </div>
                  )}
                </>
              )}
              {anim.regionEffect !== 'draw-border' && (
                <div className="two-col">
                  <label>
                    Delay (s)
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={anim.appearDelay ?? 0}
                      onChange={(event) => patch({ appearDelay: Math.max(0, Number(event.target.value)) })}
                    />
                  </label>
                  <label>
                    Duration (s)
                    <input
                      type="number"
                      min="0.05"
                      step="0.1"
                      value={anim.appearDuration ?? 0.6}
                      onChange={(event) =>
                        patch({ appearDuration: Math.max(0.05, Number(event.target.value)) })
                      }
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <label className="toggle">
            <span>Enable Wipe Out</span>
            <input
              type="checkbox"
              checked={Boolean(anim?.wipeEnabled)}
              onChange={(event) => patch({ wipeEnabled: event.target.checked })}
            />
          </label>
          {anim?.wipeEnabled && (
            <div className="two-col">
              <RegionTimingField
                label="Wipe Out Delay"
                value={anim.wipeDelay ?? 0}
                onChange={(value) => patch({ wipeDelay: value })}
              />
              <RegionTimingField
                label="Wipe Out Duration"
                value={anim.wipeDuration ?? 1.5}
                onChange={(value) => patch({ wipeDuration: value })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RegionTimingField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(value));
  }, [value]);
  const commit = (raw: string) => {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) ? Math.max(0, Math.min(30, parsed)) : value;
    setDraft(String(next));
    onChange(next);
  };
  return (
    <label>
      {label} (s)
      <input
        ref={inputRef}
        type="number"
        min="0"
        max="30"
        step="0.1"
        value={draft}
        onWheel={(event) => event.stopPropagation()}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw !== '' && Number.isFinite(Number(raw))) onChange(Math.max(0, Math.min(30, Number(raw))));
        }}
        onBlur={(event) => commit(event.target.value)}
      />
    </label>
  );
}

function Inspector({
  layer,
  onChange,
  onDuplicate,
  onRemove,
  canRemove,
  onMove,
  assetUrls = {},
  onAddAsset,
  transitionContext,
  viewContext,
}: {
  layer: Layer;
  onChange: (patch: Partial<Layer>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canRemove: boolean;
  onMove: (d: -1 | 1) => void;
  assetUrls?: Record<string, string>;
  onAddAsset?: (asset: import('../core/project').ProjectAsset) => void;
  transitionContext?: TransitionLayerContext;
  viewContext?: ViewLayerContext;
}) {
  const isText = layer.type === 'text';
  const [myStyles, setMyStyles] = useState<PinStyleEntry[]>(() => getPinStyles());
  const [savingStyle, setSavingStyle] = useState(false);
  const isCustom = (layer.pinStyle ?? 'dot') === 'custom';
  const hasCustomImage =
    isCustom && layer.pinCustomAssetId != null && assetUrls[layer.pinCustomAssetId] != null;
  /** Open the native picker, ingest into project assets, apply to the Pin. */
  const chooseCustomImage = async (title: string) => {
    try {
      const sourcePath = await openFile({
        title,
        multiple: false,
        directory: false,
        filters: [{ name: 'PNG or JPEG image', extensions: ['png', 'jpg', 'jpeg'] }],
      });
      if (typeof sourcePath !== 'string') return;
      const asset = await ingestProjectImage(sourcePath);
      onAddAsset?.(asset);
      onChange({
        pinStyle: 'custom',
        pinCustomAssetId: asset.id,
        color: '#ffffff',
        pinBorderColor: '#ffffff',
        pinBorderWidth: 0,
      });
    } catch (err) {
      console.error(`${title} failed:`, err);
    }
  };
  const chooseRegionImage = async () => {
    try {
      const sourcePath = await openFile({
        title: 'Choose Region Image / Pattern',
        multiple: false,
        directory: false,
        filters: [{ name: 'PNG or JPEG image', extensions: ['png', 'jpg', 'jpeg'] }],
      });
      if (typeof sourcePath !== 'string') return;
      const asset = await ingestProjectImage(sourcePath);
      onAddAsset?.(asset);
      onChange({ regionFillMode: 'image', regionImageAssetId: asset.id });
    } catch (error) {
      console.error('Choose Region image failed:', error);
    }
  };
  /** Copy a reusable style's image into the project-owned asset store, then apply it. */
  const applyMyStyle = async (entry: PinStyleEntry) => {
    if (!onAddAsset) return;
    try {
      const dataUrl = entry.imageDataUrl;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const asset = await ingestProjectImageBytes(Array.from(bytes), entry.filename || 'pin-style-icon.png');
      onAddAsset(asset);
      onChange({
        pinStyle: 'custom',
        pinCustomAssetId: asset.id,
        pinCustomAnchor: entry.anchor,
        pinSize: entry.defaultSize,
      });
    } catch (err) {
      console.error('Apply pin style failed:', err);
    }
  };
  /** Save the Pin's current custom image into the app-level My Styles library. */
  const saveCurrentToMyStyles = async () => {
    if (!hasCustomImage || savingStyle) return;
    setSavingStyle(true);
    try {
      const name = window.prompt('Style name', layer.name || 'My Style');
      if (!name) return;
      savePinStyle(
        name.trim(),
        assetUrls[layer.pinCustomAssetId!],
        layer.name || 'custom-icon.png',
        layer.pinCustomAnchor ?? 'bottom-center',
        layer.pinSize ?? 15,
      );
      setMyStyles(getPinStyles());
    } finally {
      setSavingStyle(false);
    }
  };
  const handleRenameStyle = (entry: PinStyleEntry) => {
    const name = window.prompt('Rename style', entry.name);
    if (!name || !name.trim()) return;
    renamePinStyle(entry.id, name.trim());
    setMyStyles(getPinStyles());
  };
  const handleDeleteStyle = (entry: PinStyleEntry) => {
    if (
      !window.confirm(
        `Delete "${entry.name}" from My Styles? Pins already using it in projects are unaffected.`,
      )
    )
      return;
    deletePinStyle(entry.id);
    setMyStyles(getPinStyles());
  };
  return (
    <div className="layer-inspector">
      <span className="pin-section-title">Project Layer — {layer.name}</span>
      <span className="type-chip">
        {icons[layer.type]} {layerLabel[layer.type]}
      </span>
      <label>
        Name
        <input value={layer.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      {layer.type === 'pin' && (
        <>
          <div className="pin-section">
            <span className="pin-section-title">Style</span>
            <div className="pin-style-grid">
              {BUILTIN_PIN_STYLES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`pin-style-tile ${(layer.pinStyle ?? 'dot') === entry.id ? 'active' : ''}`}
                  title={entry.label}
                  onClick={() => onChange({ pinStyle: entry.id })}
                >
                  <PinStyleGlyph id={entry.id} color={layer.color} />
                  <span>{entry.label}</span>
                </button>
              ))}
              {myStyles.map((entry) => {
                const active =
                  isCustom &&
                  layer.pinCustomAssetId != null &&
                  assetUrls[layer.pinCustomAssetId] === entry.imageDataUrl;
                return (
                  <div key={entry.id} className={`pin-style-tile my-style-tile ${active ? 'active' : ''}`}>
                    <button
                      type="button"
                      className="pin-style-main"
                      title={`Apply ${entry.name}`}
                      onClick={() => void applyMyStyle(entry)}
                    >
                      <img src={entry.imageDataUrl} alt={entry.name} draggable={false} />
                      <span>{entry.name}</span>
                    </button>
                    <div className="pin-style-tile-actions">
                      <button
                        type="button"
                        className="pin-style-action"
                        title="Rename style"
                        onClick={() => handleRenameStyle(entry)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="pin-style-action danger"
                        title="Delete from My Styles"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteStyle(entry);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="pin-style-tile add"
                title="Add a custom image to this Pin (then save it to My Styles)"
                onClick={() => void chooseCustomImage('Choose Custom Icon')}
              >
                <span className="pin-style-add-icon">＋</span>
                <span>Add</span>
              </button>
            </div>
            <div className="two-col">
              <label>
                Size
                <span className="pin-number-with-unit">
                  <input
                    aria-label="Pin size value"
                    type="number"
                    min="4"
                    max="200"
                    step="0.1"
                    value={layer.pinSize ?? 15}
                    onWheel={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      onChange({ pinSize: Math.max(4, Math.min(200, Number(event.target.value))) })
                    }
                  />
                  <span>px</span>
                </span>
              </label>
              <label>
                Opacity
                <span className="pin-number-with-unit">
                  <input
                    aria-label="Pin opacity percentage"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(layer.opacity * 1000) / 10}
                    onWheel={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value))
                        onChange({ opacity: Math.max(0, Math.min(1, value / 100)) });
                    }}
                  />
                  <span>%</span>
                </span>
              </label>
            </div>
            {isCustom ? (
              <>
                <div className="pin-section">
                  <span className="pin-section-title">Custom Icon</span>
                  {hasCustomImage ? (
                    <>
                      <div className="custom-icon-preview">
                        <img
                          src={assetUrls[layer.pinCustomAssetId!]}
                          alt="Custom icon"
                          style={{
                            width: 48,
                            height: 48,
                            objectFit: 'contain',
                            borderRadius: 3,
                            border: '1px solid #3b5063',
                          }}
                        />
                      </div>
                      <div className="two-col">
                        <button
                          className="quiet"
                          onClick={() => void chooseCustomImage('Replace Custom Icon')}
                        >
                          Replace
                        </button>
                        <button className="quiet" onClick={() => onChange({ pinCustomAssetId: undefined })}>
                          Remove
                        </button>
                      </div>
                      <div className="two-col">
                        <label>
                          Anchor
                          <select
                            value={layer.pinCustomAnchor ?? 'bottom-center'}
                            onChange={(e) =>
                              onChange({ pinCustomAnchor: e.target.value as Layer['pinCustomAnchor'] })
                            }
                          >
                            <option value="bottom-center">Bottom Center</option>
                            <option value="center">Center</option>
                          </select>
                        </label>
                        <button
                          className="quiet"
                          style={{ alignSelf: 'flex-end' }}
                          disabled={savingStyle}
                          onClick={() => void saveCurrentToMyStyles()}
                        >
                          {savingStyle ? 'Saving…' : 'Save to My Styles'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p style={{ fontSize: 10, color: '#7a8fa0', margin: '4px 0' }}>No image selected.</p>
                      <button className="quiet" onClick={() => void chooseCustomImage('Choose Custom Icon')}>
                        Choose Image…
                      </button>
                      <p style={{ fontSize: 9, color: '#5a6a78', margin: '3px 0 0' }}>
                        PNG or JPEG · Square images work best
                      </p>
                    </>
                  )}
                </div>
                <div className="two-col">
                  <label className="toggle">
                    <span>Tint</span>
                    <input
                      type="checkbox"
                      checked={layer.pinTintEnabled ?? false}
                      onChange={(e) => onChange({ pinTintEnabled: e.target.checked })}
                    />
                  </label>
                  <label>
                    Tint color
                    <HexColorField
                      value={layer.pinTintColor ?? '#e8533e'}
                      onChange={(value) => onChange({ pinTintColor: value })}
                    />
                  </label>
                </div>
                <div className="two-col">
                  <label>
                    Border
                    <HexColorField
                      value={layer.pinBorderColor ?? '#ffffff'}
                      onChange={(value) => onChange({ pinBorderColor: value })}
                    />
                  </label>
                  <label>
                    Border width
                    <input
                      type="number"
                      min="0"
                      max="12"
                      step="0.5"
                      value={layer.pinBorderWidth ?? 0}
                      onWheel={(event) => event.stopPropagation()}
                      onChange={(e) => onChange({ pinBorderWidth: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
                <div className="two-col">
                  <label>
                    Fill
                    <HexColorField value={layer.color} onChange={(value) => onChange({ color: value })} />
                  </label>
                  <label>
                    Border
                    <HexColorField
                      value={layer.pinBorderColor ?? '#ffffff'}
                      onChange={(value) => onChange({ pinBorderColor: value })}
                    />
                  </label>
                </div>
                <div className="two-col">
                  <label>
                    Border width
                    <input
                      type="number"
                      min="0"
                      max="12"
                      step="0.5"
                      value={layer.pinBorderWidth ?? 3}
                      onWheel={(event) => event.stopPropagation()}
                      onChange={(e) => onChange({ pinBorderWidth: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </>
            )}
          </div>
          {/* Labels section */}
          <div className="pin-section">
            <span className="pin-section-title">Label</span>
            <label className="toggle">
              <span>Show label</span>
              <input
                type="checkbox"
                checked={layer.pinLabelVisible ?? true}
                onChange={(e) => onChange({ pinLabelVisible: e.target.checked })}
              />
            </label>
            <label>
              Label text
              <textarea
                dir={layer.textDirection === 'rtl' ? 'rtl' : 'auto'}
                value={layer.text ?? ''}
                onChange={(e) => onChange({ text: e.target.value })}
              />
            </label>
            <div className="two-col">
              <label>
                Label size
                <input
                  aria-label="Pin label size value"
                  type="number"
                  min="9"
                  max="26"
                  step="0.1"
                  value={layer.pinLabelSize ?? 11}
                  onWheel={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) onChange({ pinLabelSize: Math.max(9, Math.min(26, value)) });
                  }}
                />
              </label>
              <label>
                Label opacity
                <span className="pin-number-with-unit">
                  <input
                    aria-label="Pin label opacity percentage"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round((layer.pinLabelOpacity ?? 1) * 1000) / 10}
                    onWheel={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value))
                        onChange({ pinLabelOpacity: Math.max(0, Math.min(1, value / 100)) });
                    }}
                  />
                  <span>%</span>
                </span>
              </label>
            </div>
            <div className="two-col">
              <label>
                Text color
                <HexColorField
                  value={layer.pinLabelColor ?? '#ffffff'}
                  onChange={(value) => onChange({ pinLabelColor: value })}
                />
              </label>
              <label>
                Border color
                <HexColorField
                  value={layer.pinLabelBorderColor ?? '#ffffff'}
                  onChange={(value) => onChange({ pinLabelBorderColor: value })}
                />
              </label>
            </div>
            <div className="two-col">
              <label>
                Border width
                <input
                  aria-label="Pin label border width"
                  type="number"
                  min="0"
                  max="12"
                  step="0.1"
                  value={layer.pinLabelBorderWidth ?? 1}
                  onWheel={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      onChange({ pinLabelBorderWidth: Math.max(0, Math.min(12, value)) });
                  }}
                />
              </label>
              <label>
                Label gap
                <input
                  type="number"
                  min="-50"
                  max="40"
                  step="0.5"
                  value={layer.pinLabelGap ?? 5}
                  onWheel={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) onChange({ pinLabelGap: Math.max(-50, Math.min(40, value)) });
                  }}
                />
              </label>
            </div>
            <label>
              Label angle
              <span className="pin-number-with-unit">
                <input
                  aria-label="Pin label angle"
                  type="number"
                  min="0"
                  max="360"
                  step="1"
                  value={layer.pinLabelAngle ?? 0}
                  onWheel={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      const normalized = ((value % 360) + 360) % 360;
                      onChange({ pinLabelAngle: normalized });
                    }
                  }}
                />
                <span>°</span>
              </span>
            </label>
          </div>
          <p className="global-layer-note">
            Layer properties apply everywhere this Layer is used. Animate it per View / Transition in the
            segment section below.
          </p>
        </>
      )}
      {transitionContext && layer.type !== 'region' && (
        <div className="pin-section transition-layer-section">
          <span className="pin-section-title">
            Transition Layer{' '}
            <em className="transition-section-context">
              {transitionContext.fromName} → {transitionContext.toName}
            </em>
          </span>
          <label className="toggle">
            <span>Layer exists in this transition</span>
            <input
              type="checkbox"
              checked={transitionContext.inTransition}
              onChange={(e) => transitionContext.onSetMembership(e.target.checked)}
            />
          </label>
          {!transitionContext.inTransition ? (
            <p className="transition-hint">Enable this layer for the transition to configure animation.</p>
          ) : (
            <>
              <span className="pin-section-sub">Appear</span>
              <label className="toggle">
                <span>Enable Appear</span>
                <input
                  type="checkbox"
                  checked={Boolean(transitionContext.anim?.appearEnabled)}
                  onChange={(e) => transitionContext.onPatchAnim({ appearEnabled: e.target.checked })}
                />
              </label>
              {transitionContext.anim?.appearEnabled && (
                <>
                  <label>
                    Type
                    <select
                      value={transitionContext.anim.appearType ?? 'fade'}
                      onChange={(e) =>
                        transitionContext.onPatchAnim({
                          appearType: e.target.value as import('../core/project').PinAppearType,
                        })
                      }
                    >
                      <option value="fade">Fade</option>
                      <option value="pop">Pop</option>
                      <option value="drop">Drop</option>
                    </select>
                  </label>
                  <div className="two-col">
                    <label>
                      Delay (s)
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        value={transitionContext.anim.appearDelay ?? 0}
                        onChange={(e) =>
                          transitionContext.onPatchAnim({
                            appearDelay: Math.max(0, Number(e.target.value)),
                          })
                        }
                      />
                    </label>
                    <label>
                      Duration (s)
                      <input
                        type="number"
                        min="0.05"
                        max="10"
                        step="0.1"
                        value={transitionContext.anim.appearDuration ?? 0.6}
                        onChange={(e) =>
                          transitionContext.onPatchAnim({
                            appearDuration: Math.max(0.05, Number(e.target.value)),
                          })
                        }
                      />
                    </label>
                  </div>
                </>
              )}
              <span className="pin-section-sub">Layer Hold</span>
              <label>
                Hold (s)
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={transitionContext.anim?.layerHoldDuration ?? 0}
                  onChange={(e) =>
                    transitionContext.onPatchAnim({
                      layerHoldDuration: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
              </label>
              <span className="pin-section-sub">Wipe Out</span>
              <label className="toggle">
                <span>Enable Wipe Out</span>
                <input
                  type="checkbox"
                  checked={Boolean(transitionContext.anim?.wipeEnabled)}
                  onChange={(e) => transitionContext.onPatchAnim({ wipeEnabled: e.target.checked })}
                />
              </label>
              {transitionContext.anim?.wipeEnabled && (
                <div className="two-col">
                  <RegionTimingField
                    label="Wipe Out Delay"
                    value={transitionContext.anim.wipeDelay ?? 0}
                    onChange={(value) => transitionContext.onPatchAnim({ wipeDelay: value })}
                  />
                  <RegionTimingField
                    label="Wipe Out Duration"
                    value={transitionContext.anim.wipeDuration ?? 0.5}
                    onChange={(value) => transitionContext.onPatchAnim({ wipeDuration: value })}
                  />
                </div>
              )}
            </>
          )}
          {transitionContext.warnings.map((warning, index) => (
            <p key={index} className={`segment-warning ${warning.level}`}>
              ⚠ {warning.message}
            </p>
          ))}
        </div>
      )}
      {viewContext && layer.type !== 'region' && (
        <div className="pin-section transition-layer-section">
          <span className="pin-section-title">
            View Animation <em className="transition-section-context">{viewContext.viewName}</em>
          </span>
          <label className="toggle">
            <span>Layer exists in this View</span>
            <input
              type="checkbox"
              checked={viewContext.inView}
              onChange={(e) => viewContext.onSetMembership(e.target.checked)}
            />
          </label>
          {viewContext.holdDuration === 0 && (
            <p className="segment-warning info">
              View Hold is 0s. This View has no playback interval. Its Layer configuration and animations are
              preserved but do not affect playback until Hold is increased.
            </p>
          )}
          {!viewContext.inView ? (
            <p className="transition-hint">Enable this layer for the View to configure animation.</p>
          ) : (
            <>
              <span className="pin-section-sub">Appear</span>
              <label className="toggle">
                <span>Enable Appear</span>
                <input
                  type="checkbox"
                  checked={Boolean(viewContext.anim?.appearEnabled)}
                  onChange={(e) => viewContext.onPatchAnim({ appearEnabled: e.target.checked })}
                />
              </label>
              {viewContext.anim?.appearEnabled && (
                <>
                  <label>
                    Type
                    <select
                      value={viewContext.anim.appearType ?? 'fade'}
                      onChange={(e) =>
                        viewContext.onPatchAnim({
                          appearType: e.target.value as import('../core/project').PinAppearType,
                        })
                      }
                    >
                      <option value="fade">Fade</option>
                      <option value="pop">Pop</option>
                      <option value="drop">Drop</option>
                    </select>
                  </label>
                  <div className="two-col">
                    <label>
                      Delay (s)
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        value={viewContext.anim.appearDelay ?? 0}
                        onChange={(e) =>
                          viewContext.onPatchAnim({ appearDelay: Math.max(0, Number(e.target.value)) })
                        }
                      />
                    </label>
                    <label>
                      Duration (s)
                      <input
                        type="number"
                        min="0.05"
                        max="10"
                        step="0.1"
                        value={viewContext.anim.appearDuration ?? 0.6}
                        onChange={(e) =>
                          viewContext.onPatchAnim({
                            appearDuration: Math.max(0.05, Number(e.target.value)),
                          })
                        }
                      />
                    </label>
                  </div>
                </>
              )}
              <span className="pin-section-sub">Layer Hold</span>
              <label>
                Hold (s)
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={viewContext.anim?.layerHoldDuration ?? 0}
                  onChange={(e) =>
                    viewContext.onPatchAnim({ layerHoldDuration: Math.max(0, Number(e.target.value)) })
                  }
                />
              </label>
              <span className="pin-section-sub">Wipe Out</span>
              <label className="toggle">
                <span>Enable Wipe Out</span>
                <input
                  type="checkbox"
                  checked={Boolean(viewContext.anim?.wipeEnabled)}
                  onChange={(e) => viewContext.onPatchAnim({ wipeEnabled: e.target.checked })}
                />
              </label>
              {viewContext.anim?.wipeEnabled && (
                <div className="two-col">
                  <RegionTimingField
                    label="Wipe Out Delay"
                    value={viewContext.anim.wipeDelay ?? 0}
                    onChange={(value) => viewContext.onPatchAnim({ wipeDelay: value })}
                  />
                  <RegionTimingField
                    label="Wipe Out Duration"
                    value={viewContext.anim.wipeDuration ?? 0.5}
                    onChange={(value) => viewContext.onPatchAnim({ wipeDuration: value })}
                  />
                </div>
              )}
            </>
          )}
          {viewContext.warnings.map((warning, index) => (
            <p key={index} className={`segment-warning ${warning.level}`}>
              ⚠ {warning.message}
            </p>
          ))}
        </div>
      )}
      {isText && (
        <label>
          Content
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
      {layer.type === 'region' && (
        <>
          <div className="pin-section">
            <span className="pin-section-title">Source</span>
            <p>
              {layer.regionSource === 'administrative'
                ? `Administrative · ${layer.regionKind ?? 'country'}`
                : 'Custom geographic polygon'}
            </p>
          </div>
          <div className="pin-section">
            <span className="pin-section-title">Fill</span>
            <label>
              Mode
              <select
                value={layer.regionFillMode ?? 'solid'}
                onChange={(e) => onChange({ regionFillMode: e.target.value as Layer['regionFillMode'] })}
              >
                <option value="none">None</option>
                <option value="solid">Solid</option>
                {layer.regionKind === 'country' && <option value="flag">Country Flag</option>}
                <option value="image">Image / Pattern</option>
              </select>
            </label>
            {(layer.regionFillMode ?? 'solid') === 'solid' && (
              <label>
                Fill Color
                <HexColorField
                  value={layer.regionFillColor ?? layer.color}
                  onChange={(value) => onChange({ regionFillColor: value, color: value })}
                />
              </label>
            )}
            {layer.regionFillMode === 'image' && (
              <button className="quiet" onClick={() => void chooseRegionImage()}>
                Choose Image / Pattern
              </button>
            )}
            {layer.regionFillMode !== 'solid' && layer.regionFillMode !== 'none' && (
              <label>
                Mapping
                <select
                  value={layer.regionImageMode ?? 'cover'}
                  onChange={(e) => onChange({ regionImageMode: e.target.value as Layer['regionImageMode'] })}
                >
                  <option value="cover">Cover</option>
                  <option value="fit">Fit</option>
                  <option value="tile">Tile</option>
                </select>
              </label>
            )}
            {(layer.regionImageMode ?? 'cover') === 'tile' &&
              (layer.regionFillMode === 'flag' || layer.regionFillMode === 'image') && (
                <label>
                  Tile Count
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={layer.regionTileCount ?? 4}
                    onWheel={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      onChange({
                        regionTileCount: Math.max(
                          1,
                          Math.min(20, Math.round(Number(event.target.value) || 1)),
                        ),
                      })
                    }
                  />
                </label>
              )}
            {layer.regionFillMode !== 'none' && (
              <label>
                Fill Opacity{' '}
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.round((layer.regionFillOpacity ?? 0.35) * 100)}
                  onWheel={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onChange({ regionFillOpacity: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })
                  }
                />
              </label>
            )}
          </div>
          <div className="pin-section">
            <span className="pin-section-title">Stroke</span>
            <label className="toggle">
              <span>Exists</span>
              <input
                type="checkbox"
                checked={layer.regionStrokeExists !== false}
                onChange={(event) => onChange({ regionStrokeExists: event.target.checked })}
              />
            </label>
            {layer.regionStrokeExists !== false && (
              <>
                <label>
                  Color
                  <HexColorField
                    value={layer.regionStrokeColor ?? '#66b5ff'}
                    onChange={(value) => onChange({ regionStrokeColor: value })}
                  />
                </label>
                <div className="two-col">
                  <label>
                    Opacity
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={Math.round((layer.regionStrokeOpacity ?? 0.9) * 100)}
                      onChange={(e) =>
                        onChange({
                          regionStrokeOpacity: Math.max(0, Math.min(1, Number(e.target.value) / 100)),
                        })
                      }
                    />
                  </label>
                  <label>
                    Width
                    <input
                      type="number"
                      min="0"
                      max="20"
                      step="0.1"
                      value={layer.regionStrokeWidth ?? 2}
                      onChange={(e) =>
                        onChange({ regionStrokeWidth: Math.max(0, Math.min(20, Number(e.target.value))) })
                      }
                    />
                  </label>
                </div>
              </>
            )}
          </div>
          <RegionTimelineControls
            layer={layer}
            transitionContext={transitionContext}
            viewContext={viewContext}
          />
          {layer.regionSource === 'custom' && (
            <div className="pin-section">
              <span className="pin-section-title">Geometry</span>
              <button className="quiet" disabled>
                Edit Boundary (next refinement)
              </button>
            </div>
          )}
        </>
      )}
      {layer.type !== 'pin' && layer.type !== 'region' && (
        <div className="two-col">
          <label>
            Color
            <HexColorField value={layer.color} onChange={(value) => onChange({ color: value })} />
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
      )}
      <label
        className="toggle"
        title="Prevents moving this layer directly on the map. The layer stays editable in Properties and is still captured in Views."
      >
        <span>Lock on canvas</span>
        <input
          type="checkbox"
          checked={layer.locked}
          onChange={(e) => onChange({ locked: e.target.checked })}
        />
      </label>
      <div className="order-actions">
        <button title="Moves this layer one level below overlapping layers" onClick={() => onMove(-1)}>
          ↓ Send Backward
        </button>
        <button title="Moves this layer one level above overlapping layers" onClick={() => onMove(1)}>
          ↑ Bring Forward
        </button>
      </div>
      <details>
        <summary>Advanced</summary>
        <p>Per-View properties and animation controls are introduced in later phases.</p>
      </details>
      <button className="duplicate" onClick={onDuplicate}>
        Duplicate Layer
      </button>
      {canRemove && (
        <button className="delete-layer" onClick={onRemove}>
          Delete Layer
        </button>
      )}
    </div>
  );
}
