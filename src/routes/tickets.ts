import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getTicketTypes, createTicketType, updateTicketType, deleteTicketType } from '../controllers/ticketController';

const router = Router({ mergeParams: true });
router.get('/', getTicketTypes);
router.post('/', authenticate, createTicketType);
router.put('/:ticketId', authenticate, updateTicketType);
router.delete('/:ticketId', authenticate, deleteTicketType);
export default router;
