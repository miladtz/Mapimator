export type OnlineMapPurpose = 'interactive' | 'thumbnail' | 'export';

export interface OnlineMapLifecycleSnapshot {
  active: number;
  interactive: number;
  thumbnail: number;
  export: number;
  created: number;
  disposed: number;
}

const activeByPurpose: Record<OnlineMapPurpose, number> = {
  interactive: 0,
  thumbnail: 0,
  export: 0,
};
let created = 0;
let disposed = 0;

export const onlineMapLifecycleSnapshot = (): OnlineMapLifecycleSnapshot => ({
  active: activeByPurpose.interactive + activeByPurpose.thumbnail + activeByPurpose.export,
  ...activeByPurpose,
  created,
  disposed,
});

/** DEV-observable accounting around each heavyweight MapLibre/WebGL owner. */
export const registerOnlineMapInstance = (purpose: OnlineMapPurpose) => {
  created += 1;
  activeByPurpose[purpose] += 1;
  if (import.meta.env.DEV)
    console.info('[OpenFreeMap Lifecycle] created', purpose, onlineMapLifecycleSnapshot());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    disposed += 1;
    activeByPurpose[purpose] = Math.max(0, activeByPurpose[purpose] - 1);
    if (import.meta.env.DEV)
      console.info('[OpenFreeMap Lifecycle] disposed', purpose, onlineMapLifecycleSnapshot());
  };
};

if (import.meta.env.DEV) Object.assign(window, { __MAPMOTION_ONLINE_MAPS__: onlineMapLifecycleSnapshot });
