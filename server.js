// vesselai-server/server.js
// Proxy server — sits between the Vessel Check app and Anthropic API.
// Your Anthropic key stays here on the server. Users never see it.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Validate env ─────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('Add it in your Render dashboard under Environment Variables.');
  process.exit(1);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors()); // Allow requests from the mobile app
app.use(express.json({ limit: '10kb' })); // Limit request body size

// ─── Rate limiting ────────────────────────────────────────────────────────────
// 20 messages per IP per 15 minutes — prevents abuse
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a few minutes before trying again.',
    code: 'RATE_LIMITED',
  },
});

// Daily limit — 100 messages per IP per day
const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
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
  res.json({
    status: 'online',
    service: 'VesselAI Server',
    version: '1.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/chat', dailyLimiter, chatLimiter, async (req, res) => {
  const { messages, vesselName, vesselType, contextTitle, contextData } = req.body;

  // Validate input
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Conversation too long. Please start a new chat.' });
  }

  // Sanitise messages — only pass role and content to Anthropic
  const sanitisedMessages = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content).slice(0, 2000), // cap per message
  }));

  // Build contextual system prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (vesselName && vesselType) {
    systemPrompt += `\n\nThe user's vessel: "${vesselName}" (${vesselType === 'sailboat' ? 'Sailing yacht' : 'Motor yacht'}).`;
  }
  if (contextTitle && contextData) {
    systemPrompt += `\n\nThe user is viewing their ${contextTitle} screen. Current data for context:\n${JSON.stringify(contextData, null, 2).slice(0, 3000)}`;
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: sanitisedMessages,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error('Anthropic error:', data);
      return res.status(502).json({
        error: data.error?.message || 'AI service error. Please try again.',
        code: 'ANTHROPIC_ERROR',
      });
    }

    if (data.content && data.content[0]) {
      return res.json({ reply: data.content[0].text });
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
  console.log(`Health check: http://localhost:${PORT}/health`);
});
