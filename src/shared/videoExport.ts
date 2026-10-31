export type VideoJobState =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type VideoMusicKind = 'upbeat' | 'library' | 'none' | 'upload';

export interface VideoMusicTrack {
  id: string;
  title: string;
  version: string;
  mood: string;
  duration: number;
  previewUrl: string;
}

export interface VideoExportOptions {
  durationSeconds?: number;
  music: VideoMusicKind;
  uploadId?: string;
  trackId?: string;
  localMusic?: { name: string; duration: number };
}

export interface VideoJob {
  journeySignature?: string;
  kind?: 'scene';
  browserAssets?: boolean;
  sceneUrl?: string;
  id: string;
  itineraryId: string;
  title: string;
  state: VideoJobState;
  progress: number;
  stage: string;
  queuePosition: number;
  createdAt: string;
  finishedAt?: string;
  expiresAt?: string;
  duration: number;
  days: number;
  stops: number;
  options: VideoExportOptions;
  musicName: string;
  warnings: string[];
  error?: string;
  bytes?: number;
  videoUrl?: string;
  downloadUrl?: string;
  coverUrl?: string;
}

export interface VideoCapabilities {
  available: boolean;
  backgroundAvailable?: boolean;
  reason?: string;
  maxUploadBytes: number;
  retentionDays: number;
}

export interface VideoMusicUpload {
  id: string;
  name: string;
  duration: number;
  bytes: number;
}

export function isVideoJobActive(job: Pick<VideoJob, 'state'>): boolean {
  return ['queued', 'running', 'cancelling'].includes(job.state);
}
