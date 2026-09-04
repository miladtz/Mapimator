export const dirname = (value: string) => value.slice(0, Math.max(0, value.lastIndexOf('/')));
export const join = (...parts: string[]) => parts.join('/');
