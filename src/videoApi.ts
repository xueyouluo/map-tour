import type { Itinerary } from './shared/itinerary';
import type {
  VideoCapabilities,
  VideoExportOptions,
  VideoJob,
  VideoMusicUpload,
  VideoMusicTrack
} from './shared/videoExport';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/video' + url, init);
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event('map-tour:auth-required'));
    throw new Error(body.error || '请求没有成功，请稍后重试。');
  }
  return body;
}
export const videoCapabilities = () =>
  request<VideoCapabilities>('/capabilities');
export const listVideoMusic = () =>
  request<{ tracks: VideoMusicTrack[] }>('/music');
export const listVideoJobs = (id: string) =>
  request<{ jobs: VideoJob[] }>(`/jobs?itineraryId=${encodeURIComponent(id)}`);
export const createVideoJob = (
  itinerary: Itinerary,
  options: VideoExportOptions
) =>
  request<{ job: VideoJob }>('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itinerary, options })
  });
export const createVideoScene = (
  itinerary: Itinerary,
  options: VideoExportOptions
) =>
  request<{ job: VideoJob }>('/scenes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itinerary, options })
  });
export const fallbackVideoJob = (id: string) =>
  request<{ job: VideoJob }>(`/jobs/${encodeURIComponent(id)}/fallback`, {
    method: 'POST'
  });
export const cancelVideoJob = (id: string) =>
  request<{ job: VideoJob }>(`/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST'
  });
export const retryVideoJob = (id: string) =>
  request<{ job: VideoJob }>(`/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST'
  });
export const deleteVideoJob = (id: string) =>
  request<void>(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export function uploadVideoMusic(file: File) {
  const data = new FormData();
  data.set('music', file);
  return request<{ upload: VideoMusicUpload }>('/uploads', {
    method: 'POST',
    body: data
  });
}
