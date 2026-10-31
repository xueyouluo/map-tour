export const projectRoot: string;
export function runFile(
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<void>;
export const browserFiles: string;
export function chromePath(override?: string): string;
