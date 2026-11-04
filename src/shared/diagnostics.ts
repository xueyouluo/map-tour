export const diagnosticOperations = [
  'itinerary.parse', 'video.scene', 'video.export', 'video.preview', 'video.request',
  'video.background', 'video.fallback', 'video.download', 'video.storage', 'runtime.error', 'runtime.rejection', 'server.error',
  'auth.register', 'auth.login', 'share.publish', 'share.open', 'share.copy', 'itinerary.save', 'quota.blocked'
] as const;
export type DiagnosticOperation = typeof diagnosticOperations[number];
export const diagnosticStatuses = ['started', 'heartbeat', 'succeeded', 'failed', 'cancelled', 'interrupted', 'clicked', 'blocked'] as const;
export type DiagnosticStatus = typeof diagnosticStatuses[number];

export interface DiagnosticError {
  name: string;
  message: string;
  stack?: string;
  cause?: DiagnosticError;
}

export interface DiagnosticContext {
  operation: DiagnosticOperation;
  stage?: string;
  sceneId?: string;
  itineraryId?: string;
  attemptId?: string;
  elapsedMs?: number;
  progress?: number;
  scene?: Record<string, number | boolean>;
  details?: { bytes?: number; durationSeconds?: number; width?: number; height?: number;
    music?: string; inputKind?: string; storage?: string; action?: string; reason?: string; audience?: string };
}

export interface ClientDiagnostic extends DiagnosticContext {
  eventId: string;
  clientAt: string;
  buildId: string;
  error?: DiagnosticError;
  status?: DiagnosticStatus;
  page: string;
  visibility: string;
  online: boolean;
  viewport: { width: number; height: number };
}

export type AttemptStatus = Exclude<DiagnosticStatus, 'heartbeat' | 'started'> | 'in_progress' | 'unconfirmed';
export interface ReportMetric {
  operation: string; attempts: number; succeeded: number; failed: number; cancelled: number;
  interrupted: number; blocked: number; inProgress: number; unconfirmed: number; missingStarts: number;
  successRate: number | null; medianMs: number | null; p95Ms: number | null;
}
export interface AnalyticsReport {
  since: string; until: string; trackingSince: string; timeZone: string; days: number;
  activeUsers: number; totalEvents: number; downloads: number;
  operations: ReportMetric[];
  daily: { date: string; exports: number; succeeded: number; failed: number }[];
  browsers: { browser: string; exports: number; succeeded: number; failed: number; successRate: number | null }[];
  failures: { operation: string; stage: string; message: string; count: number }[];
  recent: { eventId: string; at: string; userId: string; source: string; browser: string;
    status: AttemptStatus; operation: string; attemptId: string; sceneId: string; itineraryId: string;
    elapsedMs: number | null; buildId: string; stage: string; error?: DiagnosticError; details?: DiagnosticContext['details'];
    context?: Pick<ClientDiagnostic, 'clientAt' | 'viewport' | 'visibility' | 'online' | 'progress' | 'scene'> & { userAgent?: string } }[];
  page: number; totalAttempts: number;
}

// Keep paths and stack locations useful without storing URL credentials, queries,
// cookies or common credential assignments embedded in provider exceptions.
export function diagnosticText(value: string, limit: number): string {
  return value
    .replace(/https?:\/\/[^\s<>"')]+/gi, (raw) => {
      try { const url = new URL(raw); return url.origin + url.pathname; }
      catch { return '[url]'; }
    })
    .replace(/\b(Bearer)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/\b((?:[a-z_]*(?:api[_-]?key|token|secret|password)|jscode|key|cookie|authorization))\b["']?\s*[:=]\s*["']?[^\s,;&"']+/gi, '$1=[redacted]')
    .slice(0, limit);
}

export function diagnosticError(reason: unknown, depth = 0, seen = new Set<unknown>()): DiagnosticError {
  const object = reason && typeof reason === 'object' ? reason as Record<string, unknown> : {};
  const error: DiagnosticError = {
    name: diagnosticText(typeof object.name === 'string' ? object.name : 'Error', 80),
    message: diagnosticText(typeof object.message === 'string' ? object.message
      : typeof reason === 'string' ? reason : '未知错误', 1000)
  };
  if (typeof object.stack === 'string') error.stack = diagnosticText(object.stack, 2000);
  seen.add(reason);
  if (depth < 2 && object.cause !== undefined && !seen.has(object.cause))
    error.cause = diagnosticError(object.cause, depth + 1, seen);
  return error;
}
