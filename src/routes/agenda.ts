import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getAgenda, createAgendaItem, updateAgendaItem, deleteAgendaItem } from '../controllers/agendaController';

const router = Router({ mergeParams: true });
router.get('/', getAgenda);
router.post('/', authenticate, createAgendaItem);
router.put('/:itemId', authenticate, updateAgendaItem);
router.delete('/:itemId', authenticate, deleteAgendaItem);
export default router;
