export const diagnosticOperations = [
  'video.export', 'video.preview', 'video.request', 'runtime.error', 'runtime.rejection'
] as const;
export type DiagnosticOperation = typeof diagnosticOperations[number];

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
}

export interface ClientDiagnostic extends DiagnosticContext {
  eventId: string;
  clientAt: string;
  buildId: string;
  error: DiagnosticError;
  page: string;
  visibility: string;
  online: boolean;
  viewport: { width: number; height: number };
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
