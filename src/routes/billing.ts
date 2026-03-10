import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import {
  getPlans,
  createPlan,
  updatePlan,
  getUsersWithPlans,
  updateUserBilling,
  getSecurityLogins,
  getPublicPlans,
  getMySubscription,
  createCheckoutOrder,
  verifyCheckout,
} from '../controllers/billingController';

const router = Router();

router.get('/plans/public', getPublicPlans);
router.get('/plans/me', authenticate, getMySubscription);
router.post('/checkout/order', authenticate, createCheckoutOrder);
router.post('/checkout/verify', authenticate, verifyCheckout);

router.get('/plans', authenticate, requireRole('admin'), getPlans);
router.post('/plans', authenticate, requireRole('admin'), createPlan);
router.patch('/plans/:id', authenticate, requireRole('admin'), updatePlan);
router.get('/users', authenticate, requireRole('admin'), getUsersWithPlans);
router.patch('/users/:id', authenticate, requireRole('admin'), updateUserBilling);
router.get('/security/logins', authenticate, requireRole('admin'), getSecurityLogins);

export default router;
