import express from 'express';
import { createSession } from '../sessionStore.js';
const router = express.Router();

router.post('/start', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const sessionId = createSession(userId);
  res.json({ sessionId });
});

export default router;
