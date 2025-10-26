import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cors from 'cors';
import { callLLM } from './llmProvider.js';
import OpenAI from 'openai';

import sessionRoutes from './routes/session.js';
import abbrevRoutes from './routes/abbrev.js';

dotenv.config();

const app = express();
// Allow any localhost origin during development (e.g., 4200, 52381)
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());

// Routes
app.use('/api/session', sessionRoutes);
app.use('/api/abbrev', abbrevRoutes);

// On startup: log available models for OpenAI accounts (if configured)
(async () => {
  try {
    if (process.env.PROVIDER === 'openai' && process.env.OPENAI_API_KEY) {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const models = await client.models.list();
      const ids = (models?.data || []).map(m => m.id);
      console.log('[Startup] OpenAI models available to this key:', ids.length);
      ids.forEach(id => console.log('  -', id));
    } else {
      console.log('[Startup] Model listing skipped (provider not openai or missing OPENAI_API_KEY).');
    }
  } catch (err) {
    console.warn('[Startup] Failed to list OpenAI models:', err?.message || String(err));
  }
})();

// Compatibility endpoint for Angular webui when endpoint ends with :call
app.post('/api:call', async (req, res) => {
  try {
    const parsed = typeof req.body?.json === 'string' ? JSON.parse(req.body.json) : req.body?.json || {};
    const mode = parsed.mode;
    if (mode === 'ping') {
      return res.json({ json: { ping_response: 'ok' } });
    }
    if (mode === 'text_continuation') {
      // Return no contextual phrases for now and a few placeholder outputs
      return res.json({ json: { outputs: ['okay', 'sure', 'thank you'], contextualPhrases: [] } });
    }
    if (mode === 'abbreviation_expansion') {
      const acronym = (parsed.acronym || '').toString().trim();
      const speechContent = (parsed.speechContent || '').toString();
      const precedingText = (parsed.precedingText || '').toString();
      let exactMatches = [];
      const provider = process.env.PROVIDER;
      const model = process.env.MODEL;
      let modelUsed = (provider && model) ? `${provider}:${model}` : 'heuristic';
      let source = 'heuristic';
      let llmError = null;
      try {
        if (process.env.PROVIDER && process.env.MODEL && process.env.OPENAI_API_KEY && acronym) {
            console.log('[AE] LLM attempt:', {
              provider: process.env.PROVIDER,
              model: process.env.MODEL,
              hasApiKey: !!process.env.OPENAI_API_KEY,
              acronym,
              precedingText,
              speechContentLength: speechContent.length,
            });
            const prompt = [
                'You expand AAC abbreviations to natural English phrases.',
                'Rule: each letter maps to the first letter of each word.',
                'Prefer common AAC patterns, e.g., ifX → "I feel <adjective starting with X>".',
                'Return 6 distinct, concise options, one per line, no numbering or quotes. Sort the list according to how likely the phrases are to be commonly used" by a person that is an AAC device user.',
                'Examples:',
                '  ifg → I feel good',
                '  ifb → I feel better',
                '  ifs → I feel strong',
                `Abbreviation: "${acronym}"`,
                precedingText ? `Preceding text: "${precedingText}"` : '',
                speechContent ? `Context: "${speechContent}"` : '',
              ].filter(Boolean).join('\n');
            const llmText = await callLLM({ prompt, messages: [] });
          exactMatches = (llmText || '')
              .split('\n')
              .map(s => s.trim())
              .filter(s => !!s)
              .slice(0, 6);
          if (exactMatches.length > 0) {
            modelUsed = `${process.env.PROVIDER}:${process.env.MODEL}`;
            source = 'llm';
          }
        } else {
          if (!process.env.PROVIDER || !process.env.MODEL || !process.env.OPENAI_API_KEY) {
            console.warn('[AE] LLM config missing; falling back to heuristic', {
              hasProvider: !!process.env.PROVIDER,
              hasModel: !!process.env.MODEL,
              hasApiKey: !!process.env.OPENAI_API_KEY,
            });
          }
        }
      } catch (e) {
        // fall through to heuristic
        try {
          const status = e?.status || e?.response?.status;
          const message = e?.message || e?.response?.data?.error?.message || String(e);
          llmError = status ? `${status}: ${message}` : message;
        } catch (_ignored) {
          llmError = String(e);
        }
        console.error('[AE] LLM error; using heuristic:', llmError);
      }
      if (exactMatches.length === 0 && acronym) {
        // Heuristic fallback for common pattern like "ifg" → "I feel good"
        const lower = acronym.toLowerCase();
        if (lower === 'ifg') {
          exactMatches = ['I feel good', 'I feel great', 'I feel grateful'];
        } else if (/^[a-z]{1,8}$/i.test(lower)) {
          // Build an acrostic phrase: strictly one word per letter
          const lex = {
            a: ['a', 'and', 'able'], b: ['be', 'bring', 'buy'], c: ['can', 'call', 'come'],
            d: ['do', 'done', 'deliver'], e: ['eat', 'enjoy', 'extra'], f: ['for', 'find', 'feel'],
            g: ['get', 'give', 'good'], h: ['have', 'help', 'hold'], i: ['I', 'I', 'I'],
            j: ['just', 'join', 'juice'], k: ['keep', 'know', 'kit'], l: ['like', 'love', 'lift'],
            m: ['me', 'more', 'make'], n: ['need', 'now', 'near'], o: ['on', 'or', 'one'],
            p: ['please', 'put', 'pack'], q: ['quick', 'quiet', 'queue'], r: ['read', 'ready', 'reach'],
            s: ['see', 'some', 'send'], t: ['to', 'take', 'try'], u: ['us', 'use', 'under'],
            v: ['very', 'visit', 'value'], w: ['want', 'with', 'will'], x: ['x-ray', 'xtra', 'xpress'],
            y: ['you', 'your', 'yes'], z: ['zip', 'zone', 'zero']
          };
          const buildWithOffset = (offset) => lower.split('').map((ch, i) => {
            const list = lex[ch];
            if (!list || list.length === 0) return ch;
            return list[(i + offset) % list.length];
          }).join(' ');
          exactMatches = [buildWithOffset(0), buildWithOffset(1), buildWithOffset(2)];
        } else {
          // Last-resort: echo letters spaced out
          exactMatches = [acronym.split('').join(' ')];
        }
      }
       return res.json({ json: { exactMatches, modelUsed, source, llmError } });
    }
    if (mode === 'retrieve_context') {
      return res.json({ json: { result: 'SUCCESS', contextSignals: [] } });
    }
    if (mode === 'get_lexicon') {
      return res.json({ json: { words: [] } });
    }
    return res.json({ json: {} });
  } catch (e) {
    return res.status(500).json({ error: 'internal' });
  }
});

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
