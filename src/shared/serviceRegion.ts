export const SUPPORTED_SERVICE_REGION = 'CN_MAINLAND' as const;
export const MAINLAND_ONLY_MESSAGE =
  '目前仅支持中国大陆行程，暂不支持港澳台及海外地点。';
export type ServiceRegion = 'CN_MAINLAND' | 'UNSUPPORTED' | 'UNKNOWN';
