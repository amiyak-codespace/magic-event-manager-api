import { Router } from 'express';
import { trackView, getEventAnalytics, getOrganizerAnalytics } from '../controllers/analyticsController';
import { authenticate } from '../middleware/auth';

const router = Router();
router.post('/events/:id/view', trackView);
router.get('/events/:id', authenticate, getEventAnalytics);
router.get('/organizer', authenticate, getOrganizerAnalytics);
export default router;
