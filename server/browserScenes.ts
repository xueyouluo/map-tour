import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../tools/video-preview/runtime.mjs';
import type { VideoPlan } from '../src/shared/videoPlan';

// Browser scenes contain geometry and runtime only. No Chrome, DEM download or imagery capture.
export function writeBrowserScene(directory: string, plan: VideoPlan) {
  fs.mkdirSync(directory);
  for (const name of ['film.html', 'vehicles.js', 'attribution.png'])
    fs.copyFileSync(path.join(projectRoot, 'tools/video-preview/browser', name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ status: 'prepared', assets: 'browser-direct-v1' }));
}

export function browserSceneRuntimeUrl() {
  if (process.env.NODE_ENV !== 'production') return '/src/browserScene.ts';
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'dist/.vite/manifest.json'), 'utf8'));
  const file = manifest['src/browserScene.ts']?.file;
  if (typeof file !== 'string' || !/^assets\/[\w.-]+\.js$/.test(file)) throw new Error('浏览器地图模块尚未构建');
  return '/' + file;
}
