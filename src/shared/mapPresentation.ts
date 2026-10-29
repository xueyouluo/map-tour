export interface MapLabelCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority?: number;
}
export interface MapLabelPlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
const overlaps = (a: Rectangle, b: Rectangle, gap = 5) =>
  a.x < b.x + b.width + gap &&
  a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap &&
  a.y + a.height + gap > b.y;

// Keep every geographic marker in place; only place names move or hide.
export function placeMapLabels(
  candidates: MapLabelCandidate[],
  viewport: {
    width: number;
    height: number;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  }
): MapLabelPlacement[] {
  const output: MapLabelPlacement[] = [];
  const left = viewport.left ?? 18,
    top = viewport.top ?? 18;
  const right = viewport.width - (viewport.right ?? 18),
    bottom = viewport.height - (viewport.bottom ?? 18);
  const visible = candidates.filter(
    (p) =>
      p.x > left - 14 && p.x < right + 14 && p.y > top - 14 && p.y < bottom + 14
  );
  const pins = visible.map((p) => ({
    id: p.id,
    x: p.x - 11,
    y: p.y - 11,
    width: 22,
    height: 22
  }));
  for (const item of [...visible].sort(
    (a, b) => (b.priority || 0) - (a.priority || 0)
  )) {
    const positions = [
      [item.x + 20, item.y - item.height / 2],
      [item.x - item.width - 20, item.y - item.height / 2],
      [item.x - item.width / 2, item.y - item.height - 20],
      [item.x - item.width / 2, item.y + 20]
    ];
    for (const [x, y] of positions) {
      const box = { id: item.id, x, y, width: item.width, height: item.height };
      if (
        x < left ||
        y < top ||
        x + item.width > right ||
        y + item.height > bottom
      )
        continue;
      if (
        output.some((p) => overlaps(box, p)) ||
        pins.some((p) => overlaps(box, p, 2))
      )
        continue;
      output.push(box);
      break;
    }
  }
  return output;
}

const atlasColors = [
  '#8dbdff',
  '#baa2ff',
  '#63d6b5',
  '#ffba86',
  '#eda2c0',
  '#85d4ed'
];
const lightAtlasColors = [
  '#2563eb',
  '#7c4bd5',
  '#0b827c',
  '#bd651e',
  '#be477b',
  '#167ca0'
];
export function atlasDayColor(dayIndex: number, light = false): string {
  const colors = light ? lightAtlasColors : atlasColors;
  return colors[(Math.max(1, dayIndex) - 1) % colors.length];
}
