const express = require('express');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

// =========================================================
// MODULAR FIREBASE-ADMIN IMPORTS
// =========================================================
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('src')); // Serves static UI files from src

// Serve login page
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'login.html'));
});

// Serve main app dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const STUB = process.env.TOKENWISE_STUB === '1';

// Daily Token Caps (Adjust defaults as needed)
const DAILY_USER_TOKEN_CAP = parseInt(process.env.DAILY_USER_TOKEN_CAP || '50000', 10);
const DAILY_GLOBAL_TOKEN_CAP = parseInt(process.env.DAILY_GLOBAL_TOKEN_CAP || '1000000', 10);

// =========================================================
// FIREBASE & BIGQUERY INITIALIZATION (MODULAR)
// =========================================================

if (!getApps().length) {
  initializeApp({
    projectId: PROJECT_ID
  });
}

const db = getFirestore();
const bigquery = new BigQuery({ projectId: PROJECT_ID });

const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

// =========================================================
// STEP 4: AUTH MIDDLEWARE & USER HASH DERIVATION
// =========================================================

function deriveUserHash(uid) {
  const salt = process.env.HASH_SALT || 'tokenwise-secret-salt-key';
  return crypto.createHash('sha256').update(uid + salt).digest('hex');
}

async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    req.user = decodedToken;
    req.user_hash = deriveUserHash(decodedToken.uid);
    next();
  } catch (error) {
    console.error('Token verification error:', error.message);
    return res.status(403).json({ error: 'Unauthorized: Invalid token' });
  }
}

// =========================================================
// STEP 5: FIRESTORE TOKEN CAPS HELPERS
// =========================================================

function getTodayString() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

async function checkCaps(uid) {
  const today = getTodayString();

  // 1. Check Global Daily Cap
  const globalRef = db.collection('global_usage').doc(today);
  const globalDoc = await globalRef.get();
  const globalTokens = globalDoc.exists ? (globalDoc.data().tokens || 0) : 0;

  if (globalTokens >= DAILY_GLOBAL_TOKEN_CAP) {
    throw new Error('Daily global system token limit reached. Please try again tomorrow.');
  }

  // 2. Check Per-User Daily Cap
  const userUsageRef = db.collection('users').doc(uid).collection('daily_usage').doc(today);
  const userDoc = await userUsageRef.get();
  const userTokens = userDoc.exists ? (userDoc.data().tokens || 0) : 0;

  if (userTokens >= DAILY_USER_TOKEN_CAP) {
    throw new Error('You have reached your daily token usage limit.');
  }
}

async function incrementCaps(uid, tokensUsed) {
  if (!tokensUsed || tokensUsed <= 0) return;

  const today = getTodayString();
  const batch = db.batch();

  // Increment Global Counter
  const globalRef = db.collection('global_usage').doc(today);
  batch.set(globalRef, { tokens: FieldValue.increment(tokensUsed) }, { merge: true });

  // Increment User Counter
  const userUsageRef = db.collection('users').doc(uid).collection('daily_usage').doc(today);
  batch.set(userUsageRef, { tokens: FieldValue.increment(tokensUsed) }, { merge: true });

  await batch.commit();
}

// =========================================================
// VERTEX AI & MODEL HELPERS
// =========================================================

const EXCLUDE_RE = /embedding|image|tts|audio|transcribe|veo|imagen|lyria|robotics|computer-use|banana|guard|live|native-audio|omni/i;
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

// =========================================================
// ROUTES
// =========================================================

// Public Endpoint: Fetch Available Models
app.get('/models', async (req, res) => {
  try {
    res.json(await fetchModels());
  } catch (e) {
    console.error('Model list error:', e.message);
    res.json([
      { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
      { name: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' }
    ]);
  }
});

// Protected Endpoint: Chat Generation
app.post('/chat', verifyFirebaseToken, async (req, res) => {
  const { prompt, model, history } = req.body;

  try {
    await checkCaps(req.user.uid);

    if (STUB) {
      const inTok = Math.ceil((prompt || '').length / 4.25);
      const histTok = (history || []).reduce(
        (n, h) => n + Math.ceil((h.parts?.[0]?.text || '').length / 4.25), 0);
      const isLite = /lite/i.test(model || '');
      const outTok = isLite ? 12 : Math.round(inTok * 6 + 40);
      const think = isLite ? 0 : Math.round(300 + Math.random() * 250);
      const totalTokens = inTok + histTok + outTok + think;

      await incrementCaps(req.user.uid, totalTokens);

      return res.json({
        reply: `[stub reply for: ${(prompt || '').slice(0, 60)}]`,
        newPromptTokens: inTok,
        usage: {
          promptTokenCount: inTok + histTok,
          candidatesTokenCount: outTok,
          thoughtsTokenCount: think,
          totalTokenCount: totalTokens
        },
        user_hash: req.user_hash
      });
    }

    if (!PROJECT_ID) throw new Error('GCP_PROJECT_ID is not set');

    const url =
      `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/locations/global/publishers/google/models/${model}:generateContent`;

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

    const totalTokensUsed = d.usageMetadata?.totalTokenCount || 0;

    await incrementCaps(req.user.uid, totalTokensUsed);

    res.json({
      reply: d.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no reply)',
      usage: d.usageMetadata ?? null,
      newPromptTokens,
      user_hash: req.user_hash
    });
  } catch (e) {
    console.error('Chat error:', e.message || e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Flush Telemetry Endpoint to BigQuery
app.post('/telemetry', verifyFirebaseToken, async (req, res) => {
  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'No telemetry events provided' });
  }

  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const deptId = userData.dept_id || 'engineering';
    const orgId = userData.org_id || 'acme';

    const rowsToInsert = events.map(evt => ({
      message_id: evt.message_id || null,
      chat_id: evt.chat_id || null,
      turn_index: evt.turn_index ?? null,
      started_at: evt.started_at || null,
      sent_at: evt.sent_at || new Date().toISOString(),
      org_id: evt.org_id || orgId,
      dept_id: deptId,
      user_hash: req.user_hash,
      model_requested: evt.model_requested || null,
      model_used: evt.model_used || null,
      route_reason: evt.route_reason || null,
      initial_score: evt.initial_score ?? null,
      final_score: evt.final_score ?? null,
      was_optimised: evt.was_optimised ?? false,

      // FIX FOR REPEATED STRING FIELD (Must be an Array of strings, or empty array)
      issues_at_send: Array.isArray(evt.issues_at_send)
        ? evt.issues_at_send
        : (typeof evt.issues_at_send === 'string' ? [evt.issues_at_send] : []),

      constraint_present: evt.constraint_present ?? false,
      prompt_chars: evt.prompt_chars ?? null,
      tokens_new: evt.tokens_new ?? null,
      tokens_history: evt.tokens_history ?? null,
      tokens_in: evt.tokens_in ?? null,
      tokens_out: evt.tokens_out ?? null,
      tokens_thinking: evt.tokens_thinking ?? null,
      tokens_total: evt.tokens_total ?? null,
      is_synthetic: evt.is_synthetic ?? false,
      factor_version: evt.factor_version || null,
      initial_tokens: evt.initial_tokens ?? null,
      final_tokens: evt.final_tokens ?? null,

      // FIX FOR REPEATED STRING FIELD (Must be an Array of strings, or empty array)
      initial_issues: Array.isArray(evt.initial_issues)
        ? evt.initial_issues
        : (typeof evt.initial_issues === 'string' ? [evt.initial_issues] : [])
    }));

    const datasetId = process.env.BQ_DATASET || 'tokenwise';
    const tableId = process.env.BQ_TABLE || 'raw_events';

    await bigquery.dataset(datasetId).table(tableId).insert(rowsToInsert);

    res.json({ success: true, count: rowsToInsert.length });
  } catch (e) {
    console.error('BigQuery Stream Error:', e.message || e);
    // Print detailed BigQuery row insertion errors if present
    if (e.errors) {
      console.error('BigQuery Detailed Errors:', JSON.stringify(e.errors, null, 2));
    }
    res.status(500).json({ error: 'Failed to record telemetry' });
  }
});

// Lookup endpoint to fetch existing user profile fields for the login UI
app.get('/get-profile', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Find Firebase Auth user by email to get their UID
    const userRecord = await getAuth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(userRecord.uid).get();

    if (userDoc.exists) {
      const data = userDoc.data();
      return res.json({
        exists: true,
        org_id: data.org_id || null,
        dept_id: data.dept_id || null
      });
    }

    res.json({ exists: false });
  } catch (e) {
    // User doesn't exist in Firebase Auth yet (brand new registration)
    res.json({ exists: false });
  }
});

// Profile Update Endpoint to save Username, Organization, and Department
app.post('/update-profile', verifyFirebaseToken, async (req, res) => {
  const { username, org_id, dept_id, checkOnly } = req.body;

  try {
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();

    // Check if user already exists and has set up a profile
    if (checkOnly) {
      return res.json({ exists: userDoc.exists && !!userDoc.data().username });
    }

    // If user already exists, return their existing profile (locked)
    if (userDoc.exists && userDoc.data().username) {
      return res.json({
        success: true,
        isNew: false,
        username: userDoc.data().username,
        org_id: userDoc.data().org_id,
        dept_id: userDoc.data().dept_id
      });
    }

    // Validate that a username was provided for first-time setup
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required for first-time setup.' });
    }

    const finalOrg = (org_id && org_id.trim() !== '') ? org_id.trim() : 'acme';
    const finalDept = dept_id || 'engineering';

    // Save username, org_id, and dept_id permanently for the new user
    await userRef.set({
      username: username.trim(),
      org_id: finalOrg,
      dept_id: finalDept,
      created_at: new Date().toISOString()
    }, { merge: true });

    return res.json({
      success: true,
      isNew: true,
      username: username.trim(),
      org_id: finalOrg,
      dept_id: finalDept
    });
  } catch (e) {
    console.error('Update profile error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to process user profile' });
  }
});

// Endpoint to fetch current user's profile details for the dashboard
app.get('/get-current-user', verifyFirebaseToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    const data = userDoc.data();
    res.json({
      username: data.username || 'User',
      org_id: data.org_id || 'acme',
      dept_id: data.dept_id || 'engineering'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
