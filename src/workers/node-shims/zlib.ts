import { gunzipSync as inflateGzip } from 'fflate';

export const gunzipSync = (value: Uint8Array) => inflateGzip(value);
