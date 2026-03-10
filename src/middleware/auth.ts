import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      email: string;
      role: string;
    };
    req.user = payload;
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status FROM users WHERE id = ? LIMIT 1',
      [payload.id]
    );
    if (rows[0]?.status === 'blocked') {
      res.status(403).json({ error: 'Account is blocked' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const requireRole = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
