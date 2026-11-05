export interface MapCachePolicy { maxBytes: number; ttlMs: number }
export interface MapCacheCleanup extends MapCachePolicy {
  status: 'empty' | 'skipped' | 'completed' | 'deferred' | 'failed';
  reason?: string;
  deletedEntries: number;
  freedBytes: number;
  remainingBytes?: number;
  protectedEntries?: number;
  ignoredFiles?: number;
}
export interface MapCacheReport extends MapCachePolicy {
  checkedAt: string;
  usedBytes: number;
  managedBytes: number;
  otherBytes: number;
  coordinationBytes: number;
  entries: number;
  activeReaders: number;
  writeLocks: number;
  namespaces: { name: string; bytes: number; entries: number }[];
  history: (MapCacheCleanup & { at: string })[];
}
