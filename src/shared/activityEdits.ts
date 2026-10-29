import type { Itinerary, Stop } from './itinerary';
import { toggleOptionalActivity } from './activities';
import { routeUpdateForEdit } from './routeUpdates';

export interface ActivityEdit {
  dayIndex: number;
  option: Stop;
  include: boolean;
}
export type ActivityEdits = Record<string, ActivityEdit>;

export function stageActivityEdit(
  committed: Itinerary,
  edits: ActivityEdits,
  edit: ActivityEdit
): ActivityEdits {
  const next = { ...edits };
  const key = JSON.stringify([edit.dayIndex, edit.option.id]);
  const included = Boolean(
    committed.days
      .find((day) => day.dayIndex === edit.dayIndex)
      ?.stops.some((stop) => stop.id === edit.option.id)
  );
  if (included === edit.include) delete next[key];
  else next[key] = edit;
  return next;
}
export function applyActivityEdits(
  committed: Itinerary,
  edits: ActivityEdits
): Itinerary {
  if (!Object.keys(edits).length) return committed;
  let next = committed;
  for (const edit of Object.values(edits))
    next = toggleOptionalActivity(
      next,
      edit.dayIndex,
      edit.option,
      edit.include
    );
  return { ...next, ...routeUpdateForEdit(committed, next) };
}
