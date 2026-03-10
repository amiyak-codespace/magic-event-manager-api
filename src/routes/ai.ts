import { Router } from 'express';
import { aiChat, aiGenerateEvent, aiGenerateInviteCreative } from '../controllers/aiController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/chat', authenticate, aiChat);
router.post('/generate-event', authenticate, aiGenerateEvent);
router.post('/generate-invite-creative', authenticate, aiGenerateInviteCreative);

export default router;
