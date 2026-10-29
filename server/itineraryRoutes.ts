import express from 'express';
import { requireUser } from './authRoutes';
import { sameOriginMutation } from './httpSecurity';
import { ItineraryStore } from './storage';
import type { Itinerary } from '../src/shared/itinerary';
export function itineraryRouter(store: ItineraryStore) {
  const router = express.Router();
  const access = (req: express.Request) => ({
    userId: req.currentUser!.id,
    admin: req.currentUser!.role === 'admin'
  });
  router.post('/', requireUser, sameOriginMutation, async (req, res, next) => {
    try {
      const itinerary = req.body as Itinerary;
      if (
        !itinerary?.days ||
        !Array.isArray(itinerary.days) ||
        typeof itinerary.id !== 'string' ||
        itinerary.id.length > 120
      ) {
        res.status(400).json({ error: '行程数据不正确。' });
        return;
      }
      const record = await store.save(itinerary, access(req));
      res.json({ itinerary: record, shareUrl: '/s/' + record.id });
    } catch (error) {
      next(error);
    }
  });
  router.get('/', requireUser, async (req, res, next) => {
    try {
      res.json({
        items: await store.listSummaries(
          Number(req.query.limit) || 100,
          access(req)
        )
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/:id', async (req, res, next) => {
    try {
      const record = await store.getAccessible(
        req.params.id,
        req.currentUser ? access(req) : undefined
      );
      if (!record) {
        res.status(404).json({ error: '没有找到这个行程，或你没有查看权限。' });
        return;
      }
      res.json(record);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
