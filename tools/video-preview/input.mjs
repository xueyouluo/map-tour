import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Deliberately bypass ItineraryStore: its initializer can migrate and write the database.
export function listLocalItineraries(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare('select id, payload from itineraries order by updated_at desc')
      .all()
      .map((row) => {
        const itinerary = JSON.parse(row.payload);
        const stops = itinerary.days.flatMap((day) => day.stops);
        return {
          id: row.id,
          title: itinerary.title,
          days: itinerary.days.length,
          stops: stops.length,
          matched: stops.filter(
            (stop) =>
              stop.poiMatch?.status === 'matched' && stop.poiMatch.location
          ).length,
          routes: itinerary.routeSegments.length
        };
      });
  } finally {
    db.close();
  }
}

export function readLocalItinerary({ databasePath, id, input }) {
  if (Boolean(id) === Boolean(input))
    throw new Error('请选择 --itinerary ID 或 --input JSON 文件中的一种。');
  if (input) {
    const document = JSON.parse(fs.readFileSync(input, 'utf8'));
    const itinerary = document?.itinerary || document;
    if (!itinerary || typeof itinerary !== 'object' || Array.isArray(itinerary))
      throw new Error('JSON 文件需要包含行程对象。');
    if (typeof itinerary.id === 'string' && itinerary.id.trim())
      return itinerary;
    return {
      ...itinerary,
      id:
        'local-' +
        createHash('sha256')
          .update(JSON.stringify(itinerary))
          .digest('hex')
          .slice(0, 12)
    };
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare('select payload from itineraries where id = ?')
      .get(id);
    if (!row) throw new Error(`本地行程不存在：${id}`);
    return { ...JSON.parse(row.payload), id };
  } finally {
    db.close();
  }
}
