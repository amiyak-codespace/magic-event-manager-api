import { Router } from 'express';
import { register, login, getMe, updateProfile, oauthStart, oauthCallback, acceptConsent } from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/oauth/:provider/start', oauthStart);
router.get('/oauth/:provider/callback', oauthCallback);
router.get('/me', authenticate, getMe);
router.put('/me', authenticate, updateProfile);
router.post('/consent', authenticate, acceptConsent);

export default router;
