// routes/abbrev.js

import express from 'express';
import { getContext, appendTurn } from '../sessionStore.js';
import { callLLM } from '../llmProvider.js';

const router = express.Router();

// existing expand route
router.post('/expand', async (req, res) => {
  try {
    const { sessionId, abbreviation, keywords } = req.body;
    if (!sessionId || !abbreviation) {
      return res.status(400).json({ error: 'sessionId and abbreviation required' });
    }

    const context = getContext(sessionId);
    const prompt = `Abbreviation: ${abbreviation}\nKeywords: ${keywords || ''}\nGenerate candidate expansions:`;
    const responseText = await callLLM({ 
      prompt, 
      messages: context.map(c => ({ role: c.role, content: c.text }))
    });

    const candidates = responseText.split('\n').map((line, idx) => ({
      phrase: line.trim(),
      score: null
    })).filter(p => p.phrase);

    appendTurn(sessionId, { role:'user', text: abbreviation });

    res.json({ candidates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// new refine route
router.post('/refine', async (req, res) => {
  try {
    const { sessionId, selectedCandidate, newKeywords } = req.body;
    if (!sessionId || !selectedCandidate) {
      return res.status(400).json({ error: 'sessionId and selectedCandidate required' });
    }

    const context = getContext(sessionId);
    // Update context with what user selected / wants to refine
    appendTurn(sessionId, { role:'user', text: `Refine: ${selectedCandidate}` });

    const prompt = `Based on previous context:\n${context.map(c => `${c.role}: ${c.text}`).join('\n')}\n
User selected candidate: "${selectedCandidate}"\n
Additional keywords: ${newKeywords?.join(', ') || ''}\n
Generate improved or alternative candidate phrases:`;

    const responseText = await callLLM({
      prompt,
      messages: context.map(c => ({ role: c.role, content: c.text }))
    });

    const candidates = responseText.split('\n').map((line, idx) => ({
      phrase: line.trim(),
      score: null
    })).filter(p => p.phrase);

    // Append assistant turn to context
    appendTurn(sessionId, { role:'assistant', text: `Refinement suggestions: ${candidates.map(c=>c.phrase).join('; ')}` });

    res.json({ candidates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
