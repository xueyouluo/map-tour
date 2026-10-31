export function musicGainAt(time: number, duration: number) {
  return 10 ** (-2 / 20) * Math.max(0, Math.min(1, time / 0.03, duration - time));
}
