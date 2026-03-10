import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getCheckinDashboard, checkInByCode, bulkExportAttendees } from '../controllers/checkinController';

const router = Router({ mergeParams: true });
router.get('/dashboard', authenticate, getCheckinDashboard);
router.post('/scan', authenticate, checkInByCode);
router.get('/export', authenticate, bulkExportAttendees);
export default router;
