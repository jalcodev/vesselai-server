// vesselai-server/server.js
// Proxy server — uses Google Gemini (free tier) for AI responses.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Validate env ─────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set.');
  console.error('Add it in your Render dashboard under Environment Variables.');
  process.exit(1);
}

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a few minutes before trying again.',
    code: 'RATE_LIMITED',
  },
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Daily message limit reached. Resets at midnight.',
    code: 'DAILY_LIMIT',
  },
});

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are VesselAI, an expert marine assistant built into the Vessel Check app. You have deep expertise in:

- Sailing and seamanship (all levels, from beginner to offshore)
- Motor yacht operation and handling
- Marine safety, COLREGS, and regulations
- Boat maintenance, troubleshooting, and repairs
- Weather interpretation for mariners (reading forecasts, wind, tides)
- Navigation and passage planning
- Marine equipment and electronics
- Provisioning and trip preparation
- Emergency procedures at sea

You are practical, safety-conscious, and give clear, actionable advice. When safety is involved, always emphasize professional guidance where appropriate. Keep responses concise but thorough. Use nautical terminology naturally but explain technical terms when relevant.`;

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'VesselAI Server', version: '1.1.0', ai: 'Gemini' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/chat', dailyLimiter, chatLimiter, async (req, res) => {
  const { messages, vesselName, vesselType, contextTitle, contextData } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Conversation too long. Please start a new chat.' });
  }

  // Build contextual system prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (vesselName && vesselType) {
    systemPrompt += `\n\nThe user's vessel: "${vesselName}" (${vesselType === 'sailboat' ? 'Sailing yacht' : 'Motor yacht'}).`;
  }
  if (contextTitle && contextData) {
    systemPrompt += `\n\nThe user is viewing their ${contextTitle} screen. Current data for context:\n${JSON.stringify(contextData, null, 2).slice(0, 3000)}`;
  }

  // Convert messages to Gemini format
  // Gemini uses 'user' and 'model' roles (not 'assistant')
  // System prompt is passed as first user turn + model acknowledgement
  const geminiContents = [
    { role: 'user',  parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Understood. I am VesselAI, ready to assist.' }] },
    ...messages
      .filter(m => m.content && m.content.trim())
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(m.content).slice(0, 2000) }],
      })),
  ];

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: geminiContents,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        ],
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(502).json({
        error: data.error?.message || 'AI service error. Please try again.',
        code: 'GEMINI_ERROR',
      });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) {
      return res.json({ reply });
    }

    // Handle safety blocks
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      return res.json({ reply: "I can't help with that specific request. Please ask me anything about your vessel, seamanship, or marine safety." });
    }

    return res.status(502).json({ error: 'Unexpected response from AI service.' });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({
      error: 'Server error. Please try again in a moment.',
      code: 'SERVER_ERROR',
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`VesselAI server running on port ${PORT}`);
  console.log(`AI: Google Gemini 2.0 Flash (free tier)`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
