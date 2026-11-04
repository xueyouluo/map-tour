import express from 'express';
import { requireUser } from './authRoutes';
import { QuotaExceededError, sameOriginMutation } from './httpSecurity';
import { serverAttempt } from './analytics';
import { ItineraryStore } from './storage';
import type { Itinerary } from '../src/shared/itinerary';
export function itineraryRouter(store: ItineraryStore) {
  const router = express.Router();
  const access = (req: express.Request) => ({
    userId: req.currentUser!.id,
    admin: req.currentUser!.role === 'admin'
  });
  router.post('/', requireUser, sameOriginMutation, async (req, res, next) => {
    const attempt = serverAttempt({ operation: req.query.action === 'share' ? 'share.publish' : 'itinerary.save',
      userId: req.currentUser!.id, userAgent: req.get('user-agent') });
    try {
      const itinerary = req.body as Itinerary;
      if (
        !itinerary?.days ||
        !Array.isArray(itinerary.days) ||
        typeof itinerary.id !== 'string' ||
        itinerary.id.length > 120 ||
        (req.query.action === 'share' && itinerary.shareStatus !== 'shared')
      ) {
        attempt.finish('failed', new Error('行程数据不正确'));
        res.status(400).json({ error: '行程数据不正确。' });
        return;
      }
      const record = await store.save(itinerary, access(req));
      attempt.finish('succeeded', undefined, { itineraryId: record.id });
      res.json({ itinerary: record, shareUrl: '/s/' + record.id });
    } catch (error) {
      attempt.finish(error instanceof QuotaExceededError ? 'blocked' : 'failed', error instanceof QuotaExceededError ? undefined : error);
      next(error);
    }
  });
  router.get('/', requireUser, async (req, res, next) => {
    try {
      res.json({
        items: await store.listSummaries(
          Number(req.query.limit) || 100,
          access(req),
          req.query.trashed === 'true'
        )
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete<{ id: string }>('/:id', requireUser, sameOriginMutation, async (req, res, next) => {
    try {
      await store.setTrashed(req.params.id, true, access(req));
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.post<{ id: string }>('/:id/restore', requireUser, sameOriginMutation, async (req, res, next) => {
    try {
      await store.setTrashed(req.params.id, false, access(req));
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.get('/:id', async (req, res, next) => {
    const attempt = req.query.view === 'share' && req.method === 'GET' ? serverAttempt({ operation: 'share.open',
      userId: req.currentUser?.id, userAgent: req.get('user-agent'),
      details: { audience: req.currentUser ? 'signed_in' : 'anonymous' } }) : undefined;
    try {
      const record = await store.getAccessible(
        req.params.id,
        req.currentUser ? access(req) : undefined
      );
      if (!record) {
        attempt?.finish('failed', new Error('分享行程不存在或无权访问'));
        res.status(404).json({ error: '没有找到这个行程，或你没有查看权限。' });
        return;
      }
      attempt?.finish('succeeded', undefined, { itineraryId: record.itinerary.id });
      res.json(record);
    } catch (error) {
      attempt?.finish('failed', new Error('分享行程读取失败'));
      next(error);
    }
  });
  return router;
}
