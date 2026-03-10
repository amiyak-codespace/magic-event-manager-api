import { Router } from 'express';
import { getNotifications, markRead } from '../controllers/notificationsController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, getNotifications);
router.patch('/all/read', authenticate, markRead);
router.patch('/:id/read', authenticate, markRead);

export default router;
