import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getFeedback, submitFeedback, deleteFeedback } from '../controllers/feedbackController';

const router = Router({ mergeParams: true });
router.get('/', getFeedback);
router.post('/', authenticate, submitFeedback);
router.delete('/:feedbackId', authenticate, deleteFeedback);
export default router;
