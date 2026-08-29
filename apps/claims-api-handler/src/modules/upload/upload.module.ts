import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { authMiddleware } from '../auth/auth.middleware';
import { UploadController } from './upload.controller';

export const uploadRouter = new Hono<AppEnv>();

// All upload routes require a valid JWT
uploadRouter.use('*', authMiddleware);

uploadRouter.post('/presign', UploadController.presign);
