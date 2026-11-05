export interface MapCachePolicy { maxBytes: number; ttlMs: number }
export interface MapCacheCleanup {
  status: 'empty' | 'skipped' | 'completed' | 'deferred';
  reason?: string;
  deletedEntries: number;
  freedBytes: number;
  remainingBytes?: number;
  maxBytes: number;
  ttlMs: number;
  protectedEntries?: number;
  ignoredFiles?: number;
}
export function mapCachePolicy(env?: Record<string, string | undefined>): MapCachePolicy;
export function acquireMapCacheLease(root: string): () => void;
export function withMapCacheLease<T>(root: string, work: () => Promise<T>, policy?: MapCachePolicy): Promise<T>;
export function pruneMapCache(root: string, policy?: MapCachePolicy, now?: number): MapCacheCleanup;
