import { Router } from 'express';
import { getComments, addComment, deleteComment, pinComment } from '../controllers/commentsController';
import { authenticate } from '../middleware/auth';

const router = Router({ mergeParams: true });

router.get('/', getComments);
router.post('/', authenticate, addComment);
router.delete('/:commentId', authenticate, deleteComment);
router.patch('/:commentId/pin', authenticate, pinComment);

export default router;
