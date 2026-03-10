import { Router } from 'express';
import {
  getEvents, getEvent, getEventByShortCode, createEvent, updateEvent, deleteEvent,
  getMyEvents, likeEvent, getTrendingEvents, getCategories, changeEventStatus, startEvent, stopEvent, cloneEvent, updateRecurrence,
} from '../controllers/eventController';
import { rsvpEvent, getEventAttendees, checkIn, getMyStatus, joinWaitlist, leaveWaitlist, getWaitlistPosition, getPublicAttendees, joinEventWithCode } from '../controllers/rsvpController';
import { authenticate, requireRole } from '../middleware/auth';
import commentsRouter from './comments';
import { sendEventInvites } from '../controllers/emailController';

const router = Router();

router.get('/categories', getCategories);
router.get('/trending', getTrendingEvents);
router.get('/code/:shortCode', getEventByShortCode);
router.get('/', getEvents);
router.get('/mine', authenticate, getMyEvents);
router.get('/:id', getEvent);
router.post('/', authenticate, createEvent);
router.put('/:id', authenticate, updateEvent);
router.delete('/:id', authenticate, deleteEvent);
router.patch('/:id/status', authenticate, changeEventStatus);
router.post('/:id/start', authenticate, startEvent);
router.post('/:id/stop', authenticate, stopEvent);
router.post('/:id/clone', authenticate, cloneEvent);
router.patch('/:id/recurrence', authenticate, updateRecurrence);
router.post('/:id/like', authenticate, likeEvent);
router.post('/:id/rsvp', authenticate, rsvpEvent);
router.post('/:id/join', joinEventWithCode);
router.get('/:id/going', getPublicAttendees);
router.get('/:id/attendees', authenticate, getEventAttendees);
router.post('/:id/checkin', authenticate, checkIn);
router.get('/:id/my-status', authenticate, getMyStatus);
router.post('/:id/waitlist', authenticate, joinWaitlist);
router.delete('/:id/waitlist', authenticate, leaveWaitlist);
router.get('/:id/waitlist/position', authenticate, getWaitlistPosition);
router.post('/:id/invite', authenticate, sendEventInvites);
router.use('/:id/comments', commentsRouter);

export default router;
