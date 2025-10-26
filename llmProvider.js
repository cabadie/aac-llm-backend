import OpenAI from 'openai';
import fetch from 'node-fetch';
// import GeminiSDK from 'gemini-sdk'; // placeholder for other provider

export async function callLLM({ prompt, messages }) {
  const provider = process.env.PROVIDER;
  const model = process.env.MODEL;
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing OPENAI_API_KEY');
    }
    const openai = new OpenAI({ apiKey });
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are an abbreviation‐expansion assistant.' },
          ...messages,
          { role: 'user', content: prompt }
        ]
      });
      return resp.choices[0].message.content;
    } catch (err) {
      // Some models (e.g., newer ones) require the Responses API instead of Chat Completions
      const hint = (err && err.message) ? err.message : String(err);
      console.warn('[LLM] chat.completions failed; trying responses API:', hint);
      const resp = await openai.responses.create({
        model,
        instructions: 'You are an abbreviation‐expansion assistant.',
        input: prompt,
      });
      // SDK exposes a convenience string in output_text for text responses
      const text = (resp && resp.output_text) ? resp.output_text : '';
      return text;
    }
  } else if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY');
    }
    // Build contents from messages + prompt
    let systemText = '';
    const contents = [];
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (!m || !m.role || !m.content) continue;
        if (m.role === 'system') {
          systemText += (systemText ? '\n' : '') + String(m.content);
          continue;
        }
        const role = m.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: String(m.content) }] });
      }
    }
    contents.push({ role: 'user', parts: [{ text: String(prompt || '') }] });
    const body = { contents };
    if (systemText) {
      body.systemInstruction = { role: 'system', parts: [{ text: systemText }] };
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gemini HTTP ${resp.status}: ${text}`);
    }
    const json = await resp.json();
    const candidate = json && json.candidates && json.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts || [];
    const out = parts.map(p => p && p.text ? p.text : '').filter(Boolean).join('\n');
    return out;
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}
