const express = require('express');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const STUB = process.env.TOKENWISE_STUB === '1';

const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

// The publisher list returns 133 entries including embedding, image, video,
// audio and robotics models. None of those belong in a chat dropdown.
const EXCLUDE_RE = /embedding|image|tts|audio|transcribe|veo|imagen|lyria|robotics|computer-use|banana|guard|live|native-audio/i;

let modelCache = null;

async function token() {
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  return t.token;
}

function prettyName(id) {
  return id
    .replace(/-preview.*$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchModels() {
  if (modelCache) return modelCache;

  // X-Goog-User-Project is required here. ADC user tokens carry no quota
  // project, and without it this endpoint returns 404.
  const r = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/publishers/google/models`,
    {
      headers: {
        'Authorization': `Bearer ${await token()}`,
        'X-Goog-User-Project': PROJECT_ID
      }
    }
  );

  if (!r.ok) throw new Error(`Model list failed: ${r.status}`);
  const d = await r.json();

  modelCache = (d.publisherModels || [])
    .map(m => ({ id: m.name.split('/').pop(), stage: m.launchStage }))
    .filter(m =>
      /gemini/i.test(m.id) &&
      !EXCLUDE_RE.test(m.id) &&
      (m.stage === 'GA' || m.stage === 'PUBLIC_PREVIEW')
    )
    .map(m => ({
      name: m.id,
      displayName: prettyName(m.id),
      preview: m.stage === 'PUBLIC_PREVIEW'
    }))
    .sort((a, b) => b.name.localeCompare(a.name));

  return modelCache;
}

app.get('/models', async (req, res) => {
  try {
    res.json(await fetchModels());
  } catch (e) {
    console.error('Model list error:', e.message);
    res.json([
      { name: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
      { name: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' }
    ]);
  }
});

// usageMetadata reports promptTokenCount as one figure covering history and
// the new prompt together. countTokens on the new prompt alone gives the
// split. The endpoint is free and does not count against inference quota.
async function countNewPrompt(model, prompt) {
  try {
    const url =
      `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/locations/global/publishers/google/models/${model}:countTokens`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await token()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.totalTokens ?? null;
  } catch (e) {
    return null;
  }
}

app.post('/chat', async (req, res) => {
  const { prompt, model, history } = req.body;

  if (STUB) {
    const inTok = Math.ceil((prompt || '').length / 4.25);
    const histTok = (history || []).reduce(
      (n, h) => n + Math.ceil((h.parts?.[0]?.text || '').length / 4.25), 0);
    const isLite = /lite/i.test(model || '');
    const outTok = isLite ? 12 : Math.round(inTok * 6 + 40);
    const think = isLite ? 0 : Math.round(300 + Math.random() * 250);
    return res.json({
      reply: `[stub reply for: ${(prompt || '').slice(0, 60)}]`,
      newPromptTokens: inTok,
      usage: {
        promptTokenCount: inTok + histTok,
        candidatesTokenCount: outTok,
        thoughtsTokenCount: think,
        totalTokenCount: inTok + histTok + outTok + think
      }
    });
  }

  try {
    if (!PROJECT_ID) throw new Error('GCP_PROJECT_ID is not set');

    const url =
      `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/locations/global/publishers/google/models/${model}:generateContent`;

    // Both calls start together. The count returns long before the
    // generation does, so it adds nothing to the wait.
    const [r, newPromptTokens] = await Promise.all([
      fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${await token()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            ...(Array.isArray(history) ? history : []),
            { role: 'user', parts: [{ text: prompt }] }
          ]
        })
      }),
      countNewPrompt(model, prompt)
    ]);

    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    res.json({
      reply: d.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no reply)',
      usage: d.usageMetadata ?? null,
      newPromptTokens
    });
  } catch (e) {
    console.error('Chat error:', e.message || e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(3000, () => console.log('http://localhost:3000'));