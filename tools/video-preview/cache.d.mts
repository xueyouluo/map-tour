import type { MapCachePolicy, MapCacheCleanup, MapCacheReport } from '../../src/shared/mapCache';
export type { MapCachePolicy, MapCacheCleanup, MapCacheReport } from '../../src/shared/mapCache';
export function mapCachePolicy(env?: Record<string, string | undefined>): MapCachePolicy;
export function acquireMapCacheLease(root: string): () => void;
export function withMapCacheLease<T>(root: string, work: () => Promise<T>, policy?: MapCachePolicy): Promise<T>;
export function pruneMapCache(root: string, policy?: MapCachePolicy, now?: number): MapCacheCleanup;
export function recordMapCacheCleanup(root: string, result: MapCacheCleanup, now?: number): void;
export function mapCacheReport(root: string, policy?: MapCachePolicy, now?: number): MapCacheReport;
