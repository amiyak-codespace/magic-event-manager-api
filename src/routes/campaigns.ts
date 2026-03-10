import { Router } from 'express';
import {
  getCampaigns,
  createCampaign,
  sendCampaign,
  getCampaignStats,
  deleteCampaign,
  generateCampaignTemplate,
  parseRecipientsWithAI,
  sendCampaignTest,
  getCampaignComplianceCheck,
  getCampaignAuditLogs,
  getCampaignServiceState,
  setCampaignServiceState,
  campaignEmailUnsubscribe,
} from '../controllers/campaignController';
import { authenticate } from '../middleware/auth';

const router = Router();
router.get('/unsubscribe', campaignEmailUnsubscribe);
router.get('/', authenticate, getCampaigns);
router.get('/service-state', authenticate, getCampaignServiceState);
router.patch('/service-state', authenticate, setCampaignServiceState);
router.post('/', authenticate, createCampaign);
router.post('/recipients/parse', authenticate, parseRecipientsWithAI);
router.post('/ai-template', authenticate, generateCampaignTemplate);
router.get('/audit', authenticate, getCampaignAuditLogs);
router.get('/:id/compliance-check', authenticate, getCampaignComplianceCheck);
router.post('/:id/send', authenticate, sendCampaign);
router.post('/:id/test-send', authenticate, sendCampaignTest);
router.get('/:id/stats', authenticate, getCampaignStats);
router.delete('/:id', authenticate, deleteCampaign);
export default router;
