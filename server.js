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

// Startup model listing removed per request

// Shared handler to support both "/api:call" and "/api/call" shapes
async function handleApiCall(req, res) {
  try {
    const root = req.body || {};
    const parsed = typeof root?.json === 'string' ? JSON.parse(root.json) : (root?.json || root || {});
    const mode = parsed.mode;
    if (mode === 'ping') {
      return res.json({ json: { ping_response: 'ok' } });
    }
    if (mode === 'text_continuation') {
      const prefixText = (parsed.prefixText || parsed.precedingText || parsed.prefix_text || '').toString();
      const speechContent = (parsed.speechContent || parsed.context || parsed.speech_content || '').toString();
      const precedingText = (parsed.precedingText || '').toString();
      let outputs = [];
      const provider = process.env.PROVIDER;
      const model = process.env.MODEL;
      let modelUsed = (provider && model) ? `${provider}:${model}` : 'heuristic';
      let source = 'heuristic';
      let llmError = null;
      try {
        const isLLMConfigured = () => {
          if (!process.env.PROVIDER || !process.env.MODEL) return false;
          if (process.env.PROVIDER === 'openai') return !!process.env.OPENAI_API_KEY;
          if (process.env.PROVIDER === 'gemini') return !!process.env.GEMINI_API_KEY;
          return false;
        };
        const hasAnyInput = !!(prefixText || speechContent || precedingText);
        if (isLLMConfigured() && hasAnyInput) {
          console.log('[TC] LLM attempt:', {
            provider: process.env.PROVIDER,
            model: process.env.MODEL,
            hasOpenAIKey: !!process.env.OPENAI_API_KEY,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            prefixText,
            precedingText,
            speechContentLength: speechContent.length,
          });
          const prompt = [
            'You help continue AAC user text naturally and concisely.',
            'Return 6 distinct short continuations (1-6 words), one per line, no numbering or quotes.',
            'Avoid repeating the prefix. Make each suggestion a complete, sendable phrase.',
            prefixText ? `Prefix: "${prefixText}"` : '',
            precedingText ? `Preceding text: "${precedingText}"` : '',
            speechContent ? `Context: "${speechContent}"` : '',
          ].filter(Boolean).join('\n');
          const llmText = await callLLM({ prompt, messages: [] });
          outputs = (llmText || '')
            .split('\n')
            .map(s => s.trim())
            .filter(s => !!s)
            .slice(0, 6);
          if (outputs.length > 0) {
            modelUsed = `${process.env.PROVIDER}:${process.env.MODEL}`;
            source = 'llm';
          } else {
            console.warn('[TC] LLM returned zero outputs; using heuristic');
          }
        } else {
          if (!isLLMConfigured()) {
            console.warn('[TC] LLM config missing; falling back to heuristic', {
              hasProvider: !!process.env.PROVIDER,
              hasModel: !!process.env.MODEL,
              hasOpenAIKey: !!process.env.OPENAI_API_KEY,
              hasGeminiKey: !!process.env.GEMINI_API_KEY,
            });
          } else if (!hasAnyInput) {
            console.warn('[TC] Insufficient inputs; skipping LLM and using heuristic', {
              hasPrefixText: !!prefixText,
              hasPrecedingText: !!precedingText,
              hasSpeechContent: !!speechContent,
            });
          }
        }
      } catch (e) {
        try {
          const status = e?.status || e?.response?.status;
          const message = e?.message || e?.response?.data?.error?.message || String(e);
          llmError = status ? `${status}: ${message}` : message;
        } catch (_ignored) {
          llmError = String(e);
        }
        console.error('[TC] LLM error; using heuristic:', llmError);
      }
      if (outputs.length === 0) {
        const base = (prefixText || precedingText || '').toString().trim().replace(/\s+/g, ' ');
        if (base) {
          outputs = [`${base} please`, `${base} now`, `${base} thank you`];
        } else {
          outputs = ['okay', 'sure', 'thank you'];
        }
      }
      return res.json({ json: { outputs, modelUsed, source, llmError, result: 'SUCCESS', contextualPhrases: [] } });
    }
    if (mode === 'next_word_prediction') {
      const precedingText = (parsed.precedingText || parsed.preceding_text || '').toString();
      const prefixText = (parsed.prefixText || parsed.prefix || '').toString();
      const speechContent = (parsed.speechContent || parsed.context || parsed.speech_content || '').toString();
      const speechHistory = (parsed.SpeechHistory || parsed.speechHistory || parsed.history || '').toString();

      const buildHeuristicPredictions = (prefix, history, context) => {
        const baseCandidates = [
          'the','to','and','a','you','i','is','it','that','in','of','for','on','with','this','my','we','can','your','me',
          'yes','no','please','thanks'
        ];
        const normalizeWord = (w) => (w || '').toLowerCase().replace(/[^a-z]/g, '');
        const prefixLower = normalizeWord(prefix);
        const scores = new Map();
        const addScore = (word, inc) => {
          const w = normalizeWord(word);
          if (!w) return;
          if (prefixLower && !w.startsWith(prefixLower)) return;
          scores.set(w, (scores.get(w) || 0) + inc);
        };
        for (let i = 0; i < baseCandidates.length; i++) {
          const w = baseCandidates[i];
          const baseWeight = (baseCandidates.length - i) / baseCandidates.length;
          addScore(w, baseWeight);
        }
        const addFromText = (text, weightPerHit) => {
          const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
          for (const w of words) addScore(w, weightPerHit);
        };
        addFromText(history, 1.5);
        addFromText(context, 0.8);
        if (!prefixLower) {
          const tokens = String(precedingText || '').toLowerCase().match(/[a-z]+/g) || [];
          const last = tokens.length ? tokens[tokens.length - 1] : '';
          if (last) {
            const nudge = new Set(['the','to','and','a','in','for','of','with','on','that','it']);
            for (const w of nudge) addScore(w, 0.3);
          }
        }
        const entries = Array.from(scores.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        const total = entries.reduce((sum, [, s]) => sum + s, 0) || 1;
        const predictions = entries.map(([w, s]) => ({ word: w, probability: s / total }));
        return predictions;
      };

      let predictions = [];
      let modelUsed = 'heuristic';
      let source = 'heuristic';
      let llmError = null;

      try {
        const isLLMConfigured = () => {
          if (!process.env.PROVIDER || !process.env.MODEL) return false;
          if (process.env.PROVIDER === 'openai') return !!process.env.OPENAI_API_KEY;
          if (process.env.PROVIDER === 'gemini') return !!process.env.GEMINI_API_KEY;
          return false;
        };
        if (isLLMConfigured()) {
          const prompt = [
            'You are a next-word prediction engine for an AAC typing assistant.',
            'Given the current preceding text, the current prefix for the next word, prior speech history, and additional context,',
            'return the top 10 next-word candidates that complete the next word yielding a phrase that is gramatically correct and ',
            'semantically meaningful (must begin with the prefix if provided).',
            'Respond with a strict JSON array of 10 objects, each with keys "word" (string) and "probability" (number in [0,1]).',
            'Ensure the probabilities sum to 1.',
            'Weight hevily on the speech history if present, since this should be a good predictor of what the user might be about to say. ',
            'Do not include any text before or after the JSON.',
            `precedingText: ${precedingText || ''}`,
            `prefixText: ${prefixText || ''}`,
            `speechHistory: ${speechHistory || ''}`,
            `speechContent: ${speechContent || ''}`
          ].join('\n');
          const llmText = await callLLM({ prompt, messages: [] });
          const start = llmText.indexOf('[');
          const end = llmText.lastIndexOf(']');
          if (start !== -1 && end !== -1 && end > start) {
            const jsonSlice = llmText.slice(start, end + 1);
            const parsedArr = JSON.parse(jsonSlice);
            if (Array.isArray(parsedArr)) {
              predictions = parsedArr
                .filter(x => x && typeof x.word === 'string' && typeof x.probability === 'number')
                .slice(0, 10)
                .map(x => ({ word: String(x.word).toLowerCase(), probability: Math.max(0, Math.min(1, Number(x.probability))) }));
              const sum = predictions.reduce((acc, p) => acc + p.probability, 0) || 1;
              predictions = predictions.map(p => ({ word: p.word, probability: p.probability / sum }));
            }
          }
          if (predictions.length > 0) {
            modelUsed = `${process.env.PROVIDER}:${process.env.MODEL}`;
            source = 'llm';
          } else {
            console.warn('[NWP] LLM returned zero predictions; using heuristic');
          }
        } else {
          console.warn('[NWP] LLM config missing; using heuristic', {
            hasProvider: !!process.env.PROVIDER,
            hasModel: !!process.env.MODEL,
            hasOpenAIKey: !!process.env.OPENAI_API_KEY,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
          });
        }
      } catch (e) {
        try {
          const status = e?.status || e?.response?.status;
          const message = e?.message || e?.response?.data?.error?.message || String(e);
          llmError = status ? `${status}: ${message}` : message;
        } catch (_ignored) {
          llmError = String(e);
        }
        console.error('[NWP] LLM error; using heuristic:', llmError);
      }

      if (predictions.length === 0) {
        predictions = buildHeuristicPredictions(prefixText, speechHistory, speechContent);
      }
      return res.json({ json: { predictions, result: 'SUCCESS', modelUsed, source, llmError, contextualPhrases: [] } });
    }
    if (mode === 'ambig_next_word') {
      const precedingText = (parsed.precedingText || parsed.preceding_text || '').toString();
      const speechContent = (parsed.speechContent || parsed.context || parsed.speech_content || '').toString();
      const speechHistory = (parsed.SpeechHistory || parsed.speechHistory || parsed.history || '').toString();
      const rawAmbig = (parsed.ambiguousPrefix !== undefined) ? parsed.ambiguousPrefix
        : (parsed.ambiguous_prefix !== undefined) ? parsed.ambiguous_prefix
        : (parsed.ambigPrefix !== undefined) ? parsed.ambigPrefix
        : (parsed.prefixAmbiguous !== undefined) ? parsed.prefixAmbiguous
        : undefined;
      const fallbackPrefix = (parsed.prefixText || parsed.prefix || '').toString();

      const toLowerAlpha = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
      const normalizeAmbiguousPrefix = (value) => {
        const sets = [];
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (Array.isArray(entry)) {
              const joined = entry.join('');
              sets.push(new Set(toLowerAlpha(joined).split('')));
            } else if (typeof entry === 'string') {
              sets.push(new Set(toLowerAlpha(entry).split('')));
            }
          }
        } else if (typeof value === 'string') {
          try {
            if (value.trim().startsWith('[')) {
              const parsedJson = JSON.parse(value);
              return normalizeAmbiguousPrefix(parsedJson);
            }
          } catch (_e) { /* ignore */ }
          const tokens = value.split(/\s+|\|/g).filter(Boolean);
          if (tokens.length > 1) {
            for (const t of tokens) sets.push(new Set(toLowerAlpha(t).split('')));
          } else if (tokens.length === 1) {
            // Treat single token as a simple prefix fallback
            if (!fallbackPrefix) {
              // no-op; will rely on fallbackPrefix handling
            }
          }
        }
        return sets;
      };

      const ambigSets = normalizeAmbiguousPrefix(rawAmbig);
      console.log('ambigSets', ambigSets);

      const candidateMatchesAmbiguous = (word) => {
        const w = toLowerAlpha(word);
        if (ambigSets && ambigSets.length > 0) {
          if (w.length < ambigSets.length) return false;
          for (let i = 0; i < ambigSets.length; i++) {
            if (!ambigSets[i].has(w[i])) return false;
          }
          return true;
        }
        const pf = toLowerAlpha(fallbackPrefix);
        return !pf || w.startsWith(pf);
      };

      const buildHeuristicPredictions = (history, context) => {
        const baseCandidates = [
          'the','to','and','a','you','i','is','it','that','in','of','for','on','with','this','my','we','can','your','me',
          'yes','no','please','thanks','today','time','take','try','think','talk','turn','then','there','they'
        ];
        const scores = new Map();
        const addScore = (word, inc) => {
          if (!candidateMatchesAmbiguous(word)) return;
          const w = toLowerAlpha(word);
          if (!w) return;
          scores.set(w, (scores.get(w) || 0) + inc);
        };
        for (let i = 0; i < baseCandidates.length; i++) {
          const w = baseCandidates[i];
          const baseWeight = (baseCandidates.length - i) / baseCandidates.length;
          addScore(w, baseWeight);
        }
        const addFromText = (text, weightPerHit) => {
          const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
          for (const w of words) addScore(w, weightPerHit);
        };
        addFromText(speechHistory, 1.5);
        addFromText(speechContent, 0.8);
        const tokens = String(precedingText || '').toLowerCase().match(/[a-z]+/g) || [];
        const last = tokens.length ? tokens[tokens.length - 1] : '';
        if (last) {
          for (const w of ['the','to','and','a','in','for','of','with','on','that','it']) addScore(w, 0.3);
        }
        const entries = Array.from(scores.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        const total = entries.reduce((sum, [, s]) => sum + s, 0) || 1;
        return entries.map(([w, s]) => ({ word: w, probability: s / total }));
      };

      let predictions = [];
      let modelUsed = 'heuristic';
      let source = 'heuristic';
      let llmError = null;

      try {
        const isLLMConfigured = () => {
          if (!process.env.PROVIDER || !process.env.MODEL) return false;
          if (process.env.PROVIDER === 'openai') return !!process.env.OPENAI_API_KEY;
          if (process.env.PROVIDER === 'gemini') return !!process.env.GEMINI_API_KEY;
          return false;
        };
        if (isLLMConfigured()) {
          // Build combinations by taking one character from each set in order (Cartesian product)
          const buildCombinations = (sets, max = 256) => {
            if (!Array.isArray(sets) || sets.length === 0) return [];
            let results = [''];
            for (const charSet of sets) {
              const chars = Array.from(charSet);
              const next = [];
              for (const base of results) {
                for (const ch of chars) {
                  if (next.length < max) next.push(base + ch);
                }
              }
              results = next;
              if (results.length >= max) break;
            }
            return results.slice(0, max);
          };
          const ambigForPrompt = (ambigSets && ambigSets.length > 0)
            ? JSON.stringify(buildCombinations(ambigSets))
            : '[]';
          console.log('ambigForPrompt', ambigForPrompt);
          const prompt = [
            'You are a next-word prediction engine for an AAC typing assistant.',
            'The user is mid way typing the phrase [precedingText]. ',
            'Previously, the conversation contains: [conversationHistory]. ',
            'You are going to find the list of all the words that start with the following sets of [prefixesAllowed]. ',
            'You are going to sort them by probabilistic of being the word that the user is trying to type in the given precedingPhrase and',
            ' conversationContext. Return only the top 100 next-word candidates, as strict JSON array of objects {"word": string, "probability": number in [0,1]}. ',
            'Ensure probabilities sum to 1. Do not include any text before or after the JSON. ',
            'The words you will return could be words that have those exact characters in [prefixesAllowed] or more characters. ',
            'In other words, the length of the words you return can be equal or longer to the [prefixesAllowed] sets character lengths. ',
            `[prefixesAllowed] ${ambigForPrompt} `,
            `[precedingText] ${precedingText || ''}`,
            `[conversationHistory] ${speechHistory || ''}`,
            `[speechContent] ${speechContent || ''}`
          ].join('\n');
          const llmText = await callLLM({ prompt, messages: [] });
          const start = llmText.indexOf('[');
          const end = llmText.lastIndexOf(']');
          if (start !== -1 && end !== -1 && end > start) {
            const jsonSlice = llmText.slice(start, end + 1);
            const parsedArr = JSON.parse(jsonSlice);
            if (Array.isArray(parsedArr)) {
              predictions = parsedArr
                .filter(x => x && typeof x.word === 'string' && typeof x.probability === 'number')
                .slice(0, 10)
                .map(x => ({ word: String(x.word).toLowerCase(), probability: Math.max(0, Math.min(1, Number(x.probability))) }));
              const sum = predictions.reduce((acc, p) => acc + p.probability, 0) || 1;
              predictions = predictions.map(p => ({ word: p.word, probability: p.probability / sum }));
              // Apply ambiguity filter
              predictions = predictions.filter(p => candidateMatchesAmbiguous(p.word));
            }
          }
          if (predictions.length > 0) {
            modelUsed = `${process.env.PROVIDER}:${process.env.MODEL}`;
            source = 'llm';
          }
        } else {
          console.warn('[ANW] LLM config missing; using heuristic', {
            hasProvider: !!process.env.PROVIDER,
            hasModel: !!process.env.MODEL,
            hasOpenAIKey: !!process.env.OPENAI_API_KEY,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
          });
        }
      } catch (e) {
        try {
          const status = e?.status || e?.response?.status;
          const message = e?.message || e?.response?.data?.error?.message || String(e);
          llmError = status ? `${status}: ${message}` : message;
        } catch (_ignored) {
          llmError = String(e);
        }
        console.error('[ANW] LLM error; using heuristic:', llmError);
      }
      if (predictions.length === 0) {
        predictions = buildHeuristicPredictions(speechHistory, speechContent);
      }

      return res.json({ json: { predictions, result: 'SUCCESS', modelUsed, source, llmError, contextualPhrases: [] } });
    }
    if (mode === 'abbreviation_expansion') {
      const acronym = (parsed.acronym || parsed.abbreviation || parsed.abbrev || '').toString().trim();
      const speechContent = (parsed.speechContent || parsed.context || parsed.speech_content || '').toString();
      const precedingText = (parsed.precedingText || parsed.prefixText || parsed.preceding_text || '').toString();
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
       return res.json({ json: { exactMatches, outputs: exactMatches, modelUsed, source, llmError, result: 'SUCCESS', contextualPhrases: [] } });
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
}

// Compatibility endpoint for Angular webui when endpoint ends with :call
app.post('/api:call', handleApiCall);
// Mirror endpoint without colon for other clients
app.post('/api/call', handleApiCall);

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
