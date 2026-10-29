// Design targets for the published AMap style, not a JSAPI style JSON.
export const journeyMapPalette = {
  land: '#f3f1eb',
  water: '#a4cbe0',
  road: '#ffffff',
  minorRoad: '#f8fafc',
  mountain: '#d8e4c5',
  greenSpace: '#c6dbb5',
  buildingRoof: '#d3d7da',
  buildingWall: '#b6bec5'
} as const;

// Semantic design targets. Industrial, office and residential areas require
// classified boundary data; they are not inferred from a building's appearance.
export const journeyLandUsePalette = {
  forest: '#b9d0a4',
  park: journeyMapPalette.greenSpace,
  scenic: journeyMapPalette.mountain,
  industrial: '#e5d8ae',
  warehouse: '#d4d7d9',
  office: '#d6deef',
  commercial: '#e3d9ed',
  residential: '#ece1d2',
  education: '#eee2c7',
  culture: '#eee2c7',
  healthcare: '#f0dfdc',
  transport: '#dfe5eb',
  unclassifiedBuilding: journeyMapPalette.buildingRoof
} as const;

export function resolveJourneyMapStyle(value?: string): string {
  const id = value?.trim().replace(/^amap:\/\/styles\//, '');
  return id && /^[a-f0-9]{32}$/i.test(id)
    ? `amap://styles/${id}`
    : 'amap://styles/whitesmoke';
}
