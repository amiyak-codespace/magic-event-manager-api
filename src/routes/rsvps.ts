import { Router } from 'express';
import { getMyRSVPs } from '../controllers/rsvpController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/mine', authenticate, getMyRSVPs);

export default router;
