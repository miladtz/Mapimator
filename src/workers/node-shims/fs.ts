export const readFileSync = (): never => {
  throw new Error('Filesystem access is unavailable in the maritime Web Worker.');
};
