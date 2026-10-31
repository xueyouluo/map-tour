import { upbeatWav } from './shared/upbeat';
import type { VideoExportOptions } from './shared/videoExport';
import { loadLibraryMusic } from './browserLibraryMusic';
async function musicDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('map-tour-local-music', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveBrowserMusic(id: string, file: File) {
  const db = await musicDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const request = store.openCursor();
      request.onsuccess = () => { const cursor = request.result; if (cursor) { if (Date.now() - cursor.value.createdAt > 7 * 86400000) cursor.delete(); cursor.continue(); } };
      store.put({ id, file, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function readBrowserMusic(id: string): Promise<File> {
  const db = await musicDb();
  try {
    return await new Promise<File>((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get(id);
      request.onsuccess = () => request.result?.file ? resolve(request.result.file) : reject(new Error('本地音乐未找到，请重新选择音乐并生成预览。'));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function browserMusicSource(options: VideoExportOptions, duration: number, sourceUrl?: string, status?: (text: string) => void, signal?: AbortSignal) {
  if (options.localMusic) return readBrowserMusic(options.uploadId!);
  if (options.music === 'upbeat') return upbeatWav(duration + 0.1);
  if (options.music === 'library' && sourceUrl) return loadLibraryMusic(sourceUrl, status, signal);
  return undefined;
}
export async function localMusicDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file), audio = new Audio();
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取音乐时长超时，请换一个音频文件。')), 15000);
      audio.onloadedmetadata = () => { clearTimeout(timer); Number.isFinite(audio.duration) && audio.duration > 0 ? resolve(audio.duration) : reject(new Error('无法读取音乐时长')); };
      audio.onerror = () => { clearTimeout(timer); reject(new Error('浏览器无法读取这个音频文件')); };
      audio.preload = 'metadata'; audio.src = url;
    });
  } finally { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
}
