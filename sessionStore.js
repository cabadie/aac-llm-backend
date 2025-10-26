// A simple in-memory store. For production use a database.
const sessions = new Map();  // sessionId → { userId, context: [] }

export function createSession(userId) {
  const sessionId = Math.random().toString(36).substring(2);
  sessions.set(sessionId, { userId, context: [] });
  return sessionId;
}

export function getContext(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  return s.context;
}

export function appendTurn(sessionId, newTurn) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  s.context.push(newTurn);
}
