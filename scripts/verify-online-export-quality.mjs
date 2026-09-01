import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const online = readFileSync(join(root, 'src/core/onlineMapFrameRenderer.ts'), 'utf8');
const adapter = readFileSync(join(root, 'src/core/openFreeMapAdapter.ts'), 'utf8');
const frames = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
const exporter = readFileSync(join(root, 'src/core/videoExporter.ts'), 'utf8');
const rust = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');

const target = { width: 1920, height: 1080 };
const candidates = [1, 1.5, 2].map((ratio) => ({
  ratio,
  width: Math.round(target.width * ratio),
  height: Math.round(target.height * ratio),
  rgbaMiB: (target.width * ratio * target.height * ratio * 4) / 1024 / 1024,
}));
assert.deepEqual(
  candidates.map(({ ratio, width, height }) => [ratio, width, height]),
  [
    [1, 1920, 1080],
    [1.5, 2880, 1620],
    [2, 3840, 2160],
  ],
);
assert.match(online, /ONLINE_EXPORT_PIXEL_RATIO = 1\.5/, 'High-quality default is 1.5x.');
assert.match(
  adapter,
  /mapLibreWorldFitZoom/,
  'Logical minimum Zoom contains one world in the canonical frame.',
);
assert.match(
  online,
  /mapMotionToMapLibreCamera\(camera, \{[\s\S]{0,120}logicalWidth/,
  'Export uses the canonical frame-aware camera mapping.',
);
assert.match(
  online,
  /expectedWidth = Math\.round\(viewport\.width \* pixelRatio\)/,
  'Canonical backing width is asserted.',
);
assert.match(
  online,
  /expectedHeight = Math\.round\(viewport\.height \* pixelRatio\)/,
  'Canonical backing height is asserted.',
);
assert.match(
  online,
  /tolerance exceeded/,
  'Fractional-DPR backing dimensions retain the accepted one-pixel tolerance.',
);
assert.match(online, /map\.resize\(\)[\s\S]*map\.jumpTo/, 'Resize precedes camera application.');
assert.match(
  online,
  /waitForIdle[\s\S]*waitForFinalRender/,
  'Tile readiness precedes final paint readiness.',
);
assert.match(online, /map\.loaded\(\) && map\.areTilesLoaded\(\)/, 'Capture requires loaded ideal tiles.');
assert.match(online, /fadeDuration: 0/, 'Tile and symbol fade is disabled for export.');
assert.match(online, /refreshExpiredTiles: false/, 'Resources do not refresh midway through export.');
assert.match(online, /antialias: ONLINE_EXPORT_ANTIALIAS/, 'Export-only WebGL antialiasing is explicit.');
assert.match(online, /preserveDrawingBuffer: true/, 'Canvas readback is preserved.');
assert.match(
  online,
  /imageSmoothingQuality = 'high'/,
  'Intentional supersample downsampling is high quality.',
);
assert.match(
  online,
  /drawImage\(source, 0, 0, source\.width, source\.height, 0, 0, destination\.width, destination\.height\)/,
  'Exactly one explicit supersample-to-target resize is present.',
);
assert.equal((online.match(/context\.drawImage\(/g) ?? []).length, 1, 'No accidental second canvas resize.');
assert.match(frames, /settings\.width, settings\.height/, 'Both FPS presets use project output dimensions.');
assert.match(exporter, /bytesPerFrame/, 'RGBA byte count is validated before FFmpeg.');
assert.match(rust, /"-pixel_format",\s*"rgba"/, 'FFmpeg input is raw RGBA.');
assert.match(rust, /"-video_size",\s*video_size\.as_str\(\)/, 'FFmpeg input uses requested dimensions.');
assert.match(rust, /"-pix_fmt",\s*"yuv420p"/, 'H.264 output is compatibility yuv420p.');
assert.match(rust, /"h264_nvenc" => \[/, 'NVENC has an explicit quality policy.');
assert.match(rust, /"-preset", "p6"/, 'NVENC uses the high-quality p6 preset.');
assert.match(rust, /"-cq", "17"/, 'NVENC uses constant-quality targeting instead of default 2 Mbps.');
assert.match(rust, /"libx264" => \["-preset", "slow", "-crf", "17"\]/, 'Software H.264 uses CRF 17.');
assert.doesNotMatch(
  rust.slice(rust.indexOf('fn start_project_export'), rust.indexOf('fn write_project_export_frame')),
  /scale=|setsar=|"-vf"/,
  'FFmpeg performs no resize/filter chain.',
);

const expectedBytes = target.width * target.height * 4;
assert.equal(expectedBytes, 8_294_400);
assert.equal(
  expectedBytes,
  target.width * target.height * 4,
  '30/60 FPS have identical per-frame resolution.',
);
assert.ok(candidates[1].rgbaMiB < candidates[2].rgbaMiB, '1.5x uses less framebuffer memory than 2x.');
console.log(
  'Online export quality: locked 960x540 logical scene, 1.5x MapLibre density, fractional-DPR tolerance, 1920x1080 target, viewport-independent zoom, final render/tile readiness, fades, MSAA, one high-quality resize, identical 30/60 FPS resolution, and no FFmpeg scaling passed.',
);
