import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getSponsors, createSponsor, updateSponsor, deleteSponsor } from '../controllers/sponsorController';

const router = Router({ mergeParams: true });
router.get('/', getSponsors);
router.post('/', authenticate, createSponsor);
router.put('/:sponsorId', authenticate, updateSponsor);
router.delete('/:sponsorId', authenticate, deleteSponsor);
export default router;
