import { Router } from 'express';
import { createInvitation, getInvitation } from '../controllers/invitationController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/', authenticate, createInvitation);
router.get('/:token', getInvitation);

export default router;
