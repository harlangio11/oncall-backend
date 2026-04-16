/**
 * OnCall Backend — Multi-user, App Store ready
 *
 * Architecture:
 *  - PostgreSQL for persistent user data
 *  - Apple Sign-In verification → JWT session tokens
 *  - Per-user Twilio number provisioning
 *  - Per-user VIP contact lists + device tokens
 *  - Twilio webhook: caller → lookup user → fire PushKit/APNs push
 *  - Gmail OAuth + polling: new email from VIP → fire push
 *
 * Environment variables (set in Railway):
 *   DATABASE_URL        — Railway Postgres connection string (auto-set when you add Postgres plugin)
 *   JWT_SECRET          — random secret for signing session tokens (generate one)
 *   APNS_KEY            — .p8 key file content
 *   APNS_KEY_ID         — 10-char key ID (5WQ9ZD4Z7M)
 *   APNS_TEAM_ID        — 10-char Team ID (UH32FAHQGX)
 *   APNS_BUNDLE_ID      — com.harlangiordano.oncall
 *   APNS_PRODUCTION     — "true" for App Store builds
 *   TWILIO_ACCOUNT_SID  — Twilio account SID
 *   TWILIO_AUTH_TOKEN   — Twilio auth token
 *   TWILIO_AREA_CODE    — area code to use when provisioning numbers (e.g. "415")
 *   APP_URL             — your Railway public URL (https://scintillating-ambition-production-e638.up.railway.app)
 *   GOOGLE_CLIENT_ID    — from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET— from Google Cloud Console
 */

require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const appleSignin = require('apple-signin-auth');
const apn        = require('@parse/node-apn');
const twilio     = require('twilio');
const cron       = require('node-cron');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      apple_user_id TEXT UNIQUE NOT NULL,
      email         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
      token     TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id)
    );

    CREATE TABLE IF NOT EXISTS vip_contacts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      phone_number TEXT,
      email        TEXT
    );

    CREATE TABLE IF NOT EXISTS twilio_numbers (
      user_id      UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
      phone_number TEXT NOT NULL,
      twilio_sid   TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_integrations (
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
      provider      TEXT NOT NULL,
      access_token  TEXT,
      refresh_token TEXT,
      email_address TEXT,
      expires_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS alarm_events (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
      contact_name   TEXT,
      contact_value  TEXT,
      type           TEXT,
      triggered_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Schema ready');
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '365d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid auth token' });
  }
}

// ─── APNs provider ────────────────────────────────────────────────────────────

let _apnProvider = null;
function getApnProvider() {
  if (_apnProvider) return _apnProvider;
  const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
  if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) {
    console.warn('[APNs] Missing credentials');
    return null;
  }
  _apnProvider = new apn.Provider({
    token: { key: APNS_KEY, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID },
    production: process.env.APNS_PRODUCTION === 'true',
  });
  console.log('[APNs] Provider ready (production:', process.env.APNS_PRODUCTION === 'true', ')');
  return _apnProvider;
}

async function sendPush(deviceToken, { title, body, callerName, callerNumber, type }) {
  const provider = getApnProvider();
  if (!provider || !deviceToken) return;

  const bundleId = process.env.APNS_BUNDLE_ID || 'com.harlangiordano.oncall';

  // VoIP pushes for calls (PushKit) — rings through silent mode via CallKit
  // Regular critical alert for emails
  const isCall  = type === 'call';
  const topic   = isCall ? `${bundleId}.voip` : bundleId;

  const note = new apn.Notification();
  note.topic  = topic;
  note.expiry = Math.floor(Date.now() / 1000) + 3600;

  if (isCall) {
    // VoIP push — app receives this via PushKit, presents CallKit UI
    note.payload = {
      type:         'vip_call',
      callerName:   callerName || callerNumber,
      callerNumber: callerNumber,
      aps:          {},
    };
  } else {
    // Email alert — critical alert notification
    note.alert = { title, body };
    note.sound = { critical: 1, name: 'alarm.wav', volume: 1.0 };
    note.contentAvailable = true;
    note.interruptionLevel = 'critical';
    note.payload = {
      type:        'vip_email',
      callerName:  callerName,
      contactInfo: callerNumber,
    };
  }

  try {
    const result = await provider.send(note, deviceToken);
    if (result.failed?.length > 0) {
      console.error('[APNs] Push failed:', JSON.stringify(result.failed));
    } else {
      console.log(`[APNs] ✅ Push sent (${type})`);
    }
  } catch (err) {
    console.error('[APNs] Error:', err.message);
  }
}

// ─── Twilio ───────────────────────────────────────────────────────────────────

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/** Buy a new Twilio number and configure its webhook to point to this server */
async function provisionTwilioNumber(userId) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');

  const appUrl    = process.env.APP_URL || '';
  const areaCode  = process.env.TWILIO_AREA_CODE || '415';

  // Search for an available local number
  const available = await client.availablePhoneNumbers('US').local.list({
    areaCode,
    voiceEnabled: true,
    limit: 1,
  });

  if (!available.length) throw new Error('No numbers available in area code ' + areaCode);

  // Purchase it
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl:    `${appUrl}/twilio/incoming-call`,
    voiceMethod: 'POST',
  });

  // Store in DB
  await db.query(
    `INSERT INTO twilio_numbers (user_id, phone_number, twilio_sid)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET phone_number = $2, twilio_sid = $3`,
    [userId, purchased.phoneNumber, purchased.sid]
  );

  console.log(`[Twilio] Provisioned ${purchased.phoneNumber} for user ${userId}`);
  return purchased.phoneNumber;
}

// ─── Phone number normalization ───────────────────────────────────────────────

function normalizePhone(n) {
  if (!n) return '';
  return n.replace(/\D/g, '').slice(-10);
}

// ─── Routes: Health ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.json({ status: 'OnCall backend running' }));

// ─── Routes: Auth ─────────────────────────────────────────────────────────────

/**
 * POST /auth/apple
 * Body: { identityToken, email? }
 * Verifies Apple Sign-In token, creates/finds user, returns JWT session token.
 */
app.post('/auth/apple', async (req, res) => {
  const { identityToken, email } = req.body;
  if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

  try {
    const { sub: appleUserId } = await appleSignin.verifyIdToken(identityToken, {
      audience:        process.env.APNS_BUNDLE_ID || 'com.harlangiordano.oncall',
      ignoreExpiration: false,
    });

    // Upsert user
    const result = await db.query(
      `INSERT INTO users (apple_user_id, email)
       VALUES ($1, $2)
       ON CONFLICT (apple_user_id) DO UPDATE SET email = COALESCE($2, users.email)
       RETURNING id, apple_user_id, email, created_at`,
      [appleUserId, email || null]
    );

    const user        = result.rows[0];
    const sessionToken = signToken(user.id);

    // Check if they have a Twilio number already
    const numRow = await db.query(
      'SELECT phone_number FROM twilio_numbers WHERE user_id = $1',
      [user.id]
    );

    console.log(`[Auth] User ${user.id} signed in`);
    res.json({
      token:         sessionToken,
      userId:        user.id,
      twilioNumber:  numRow.rows[0]?.phone_number || null,
      isNewUser:     !numRow.rows[0],
    });
  } catch (err) {
    console.error('[Auth] Apple token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid Apple identity token' });
  }
});

// ─── Routes: Device registration ──────────────────────────────────────────────

/**
 * POST /user/register
 * Body: { deviceToken }
 * Saves/updates the APNs device token for this user.
 */
app.post('/user/register', requireAuth, async (req, res) => {
  const { deviceToken } = req.body;
  if (!deviceToken) return res.status(400).json({ error: 'deviceToken required' });

  await db.query(
    `INSERT INTO device_tokens (user_id, token, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET token = $2, updated_at = NOW()`,
    [req.user.userId, deviceToken]
  );

  console.log(`[Register] Device token updated for user ${req.user.userId}`);
  res.json({ success: true });
});

/**
 * PUT /user/vips
 * Body: { contacts: [{ name, phoneNumber?, email? }] }
 * Replaces the user's VIP contact list.
 */
app.put('/user/vips', requireAuth, async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });

  const userId = req.user.userId;

  // Replace all VIPs atomically
  await db.query('DELETE FROM vip_contacts WHERE user_id = $1', [userId]);

  if (contacts.length > 0) {
    const values = contacts.map((c, i) => {
      const base = i * 4;
      return `($${base+1}, $${base+2}, $${base+3}, $${base+4})`;
    }).join(', ');

    const params = contacts.flatMap(c => [userId, c.name, c.phoneNumber || null, c.email || null]);
    await db.query(
      `INSERT INTO vip_contacts (user_id, name, phone_number, email) VALUES ${values}`,
      params
    );
  }

  console.log(`[VIPs] Updated: ${contacts.length} contacts for user ${userId}`);
  res.json({ success: true, count: contacts.length });
});

/**
 * GET /user/profile
 * Returns user profile, Twilio number, and VIP count.
 */
app.get('/user/profile', requireAuth, async (req, res) => {
  const userId = req.user.userId;

  const [userRow, numRow, vipRow, emailRow] = await Promise.all([
    db.query('SELECT id, email, created_at FROM users WHERE id = $1', [userId]),
    db.query('SELECT phone_number FROM twilio_numbers WHERE user_id = $1', [userId]),
    db.query('SELECT COUNT(*) FROM vip_contacts WHERE user_id = $1', [userId]),
    db.query('SELECT provider, email_address FROM email_integrations WHERE user_id = $1', [userId]),
  ]);

  res.json({
    userId,
    email:         userRow.rows[0]?.email,
    twilioNumber:  numRow.rows[0]?.phone_number || null,
    vipCount:      parseInt(vipRow.rows[0].count),
    emailAccounts: emailRow.rows,
  });
});

// ─── Routes: Twilio number provisioning ───────────────────────────────────────

/**
 * POST /user/provision-number
 * Buys a Twilio number for this user and returns it.
 * Called once during onboarding after sign-in.
 */
app.post('/user/provision-number', requireAuth, async (req, res) => {
  const userId = req.user.userId;

  // Check if user already has a number
  const existing = await db.query(
    'SELECT phone_number FROM twilio_numbers WHERE user_id = $1',
    [userId]
  );
  if (existing.rows.length > 0) {
    return res.json({ phoneNumber: existing.rows[0].phone_number, existing: true });
  }

  try {
    const phoneNumber = await provisionTwilioNumber(userId);
    res.json({ phoneNumber, existing: false });
  } catch (err) {
    console.error('[Provision] Failed:', err.message);
    res.status(500).json({ error: 'Could not provision phone number: ' + err.message });
  }
});

// ─── Routes: Twilio webhook ───────────────────────────────────────────────────

/**
 * POST /twilio/incoming-call
 * Twilio fires this when someone calls any of our provisioned numbers.
 * The `To` field tells us which user's number was called.
 */
app.post('/twilio/incoming-call', async (req, res) => {
  const calledNumber = req.body.To    || '';
  const callerNumber = req.body.From  || '';
  const callerName   = req.body.CallerName || '';

  console.log(`[Twilio] Call to ${calledNumber} from ${callerNumber}`);

  // Find which user owns the called number
  const numRow = await db.query(
    'SELECT user_id FROM twilio_numbers WHERE phone_number = $1',
    [calledNumber]
  );

  if (!numRow.rows.length) {
    console.warn('[Twilio] No user found for number:', calledNumber);
    return sendTwimlHangup(res);
  }

  const userId = numRow.rows[0].user_id;

  // Load user's VIP list and device token in parallel
  const [vipRows, tokenRow] = await Promise.all([
    db.query('SELECT name, phone_number FROM vip_contacts WHERE user_id = $1 AND phone_number IS NOT NULL', [userId]),
    db.query('SELECT token FROM device_tokens WHERE user_id = $1', [userId]),
  ]);

  if (!tokenRow.rows.length) {
    console.warn('[Twilio] No device token for user:', userId);
    return sendTwimlHangup(res);
  }

  // Check if caller is a VIP
  const callerNorm = normalizePhone(callerNumber);
  const vip = vipRows.rows.find(v => normalizePhone(v.phone_number) === callerNorm);

  if (!vip) {
    console.log(`[Twilio] ${callerNumber} is not a VIP for user ${userId}`);
    return sendTwimlHangup(res);
  }

  const displayName = vip.name || callerName || callerNumber;
  console.log(`[Twilio] VIP call from "${displayName}" → firing push for user ${userId}`);

  // Log alarm event
  db.query(
    'INSERT INTO alarm_events (user_id, contact_name, contact_value, type) VALUES ($1, $2, $3, $4)',
    [userId, displayName, callerNumber, 'call']
  );

  // Fire push
  await sendPush(tokenRow.rows[0].token, {
    title:        `${displayName} is calling`,
    body:         'Your VIP is trying to reach you',
    callerName:   displayName,
    callerNumber: callerNumber,
    type:         'call',
  });

  sendTwimlHangup(res);
});

function sendTwimlHangup(res) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
}

// ─── Routes: Gmail OAuth ──────────────────────────────────────────────────────

function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/email/google/callback`
  );
}

/**
 * GET /email/google/auth?token=<session_token>
 * Starts Gmail OAuth flow. We pass the session token as a query param
 * so we can recover it in the callback.
 */
app.get('/email/google/auth', (req, res) => {
  const sessionToken = req.query.token;
  if (!sessionToken) return res.status(400).send('Missing token');

  const oauth2Client = getGoogleOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: sessionToken, // pass session token through OAuth flow
    prompt: 'consent',
  });
  res.redirect(url);
});

/**
 * GET /email/google/callback
 * Google redirects here after user grants access.
 */
app.get('/email/google/callback', async (req, res) => {
  const { code, state: sessionToken } = req.query;
  if (!code || !sessionToken) return res.status(400).send('Missing code or state');

  try {
    // Verify session token
    const payload = jwt.verify(sessionToken, JWT_SECRET);
    const userId  = payload.userId;

    const oauth2Client = getGoogleOAuthClient();
    const { tokens }   = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get email address
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress;

    // Store tokens
    await db.query(
      `INSERT INTO email_integrations (user_id, provider, access_token, refresh_token, email_address, expires_at)
       VALUES ($1, 'gmail', $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET access_token = $2, refresh_token = COALESCE($3, email_integrations.refresh_token),
             email_address = $4, expires_at = $5`,
      [userId, tokens.access_token, tokens.refresh_token || null, emailAddress,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null]
    );

    console.log(`[Gmail] Connected ${emailAddress} for user ${userId}`);

    // Return a page that posts back to the app via deep link
    res.send(`
      <html><body>
        <script>
          window.location.href = 'oncall://email-connected?provider=gmail&email=${encodeURIComponent(emailAddress)}';
        </script>
        <p>Connected! You can close this window.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[Gmail] OAuth callback error:', err.message);
    res.status(500).send('Connection failed: ' + err.message);
  }
});

/**
 * DELETE /email/disconnect
 * Removes email integration for this user.
 */
app.delete('/email/disconnect', requireAuth, async (req, res) => {
  await db.query('DELETE FROM email_integrations WHERE user_id = $1', [req.user.userId]);
  res.json({ success: true });
});

// ─── Email polling ────────────────────────────────────────────────────────────

/**
 * Runs every 60 seconds. For each user with Gmail connected,
 * checks for new unread emails from VIP addresses.
 */
async function pollEmails() {
  try {
    const rows = await db.query(
      `SELECT ei.user_id, ei.access_token, ei.refresh_token, ei.expires_at,
              dt.token AS device_token
       FROM email_integrations ei
       JOIN device_tokens dt ON dt.user_id = ei.user_id
       WHERE ei.provider = 'gmail'`
    );

    for (const row of rows.rows) {
      await checkGmailForUser(row);
    }
  } catch (err) {
    console.error('[Email Poll] Error:', err.message);
  }
}

async function checkGmailForUser(row) {
  try {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({
      access_token:  row.access_token,
      refresh_token: row.refresh_token,
      expiry_date:   row.expires_at ? new Date(row.expires_at).getTime() : undefined,
    });

    // Auto-refresh token if needed
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        await db.query(
          `UPDATE email_integrations SET access_token = $1, expires_at = $2 WHERE user_id = $3`,
          [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, row.user_id]
        );
      }
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get VIP email addresses for this user
    const vipRows = await db.query(
      'SELECT name, email FROM vip_contacts WHERE user_id = $1 AND email IS NOT NULL',
      [row.user_id]
    );

    if (!vipRows.rows.length) return;

    // Search for unread emails in the last 2 minutes from VIP addresses
    const twoMinsAgo = Math.floor((Date.now() - 2 * 60 * 1000) / 1000);
    const fromQuery  = vipRows.rows.map(v => `from:${v.email}`).join(' OR ');
    const query      = `is:unread after:${twoMinsAgo} (${fromQuery})`;

    const msgs = await gmail.users.messages.list({
      userId: 'me',
      q:      query,
      maxResults: 5,
    });

    if (!msgs.data.messages?.length) return;

    // Get the first match
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id:     msgs.data.messages[0].id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });

    const headers    = msg.data.payload.headers;
    const fromHeader = headers.find(h => h.name === 'From')?.value || '';
    const subject    = headers.find(h => h.name === 'Subject')?.value || '(no subject)';

    // Match sender to a VIP
    const matchedVip = vipRows.rows.find(v => fromHeader.includes(v.email));
    if (!matchedVip) return;

    console.log(`[Gmail] New email from VIP "${matchedVip.name}" for user ${row.user_id}`);

    // Log and push
    await db.query(
      'INSERT INTO alarm_events (user_id, contact_name, contact_value, type) VALUES ($1, $2, $3, $4)',
      [row.user_id, matchedVip.name, matchedVip.email, 'email']
    );

    await sendPush(row.device_token, {
      title:        `📧 ${matchedVip.name} emailed you`,
      body:         subject,
      callerName:   matchedVip.name,
      callerNumber: matchedVip.email,
      type:         'email',
    });

  } catch (err) {
    console.error(`[Gmail] Error for user ${row.user_id}:`, err.message);
  }
}

// Poll emails every 60 seconds
cron.schedule('* * * * *', pollEmails);

// ─── Routes: Alarm history ────────────────────────────────────────────────────

app.get('/user/history', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT id, contact_name, contact_value, type, triggered_at
     FROM alarm_events
     WHERE user_id = $1
     ORDER BY triggered_at DESC
     LIMIT 50`,
    [req.user.userId]
  );
  res.json({ events: rows.rows });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ OnCall backend listening on port ${PORT}`);
      console.log(`   APNs ready:    ${!!process.env.APNS_KEY}`);
      console.log(`   Twilio ready:  ${!!process.env.TWILIO_ACCOUNT_SID}`);
      console.log(`   Gmail ready:   ${!!process.env.GOOGLE_CLIENT_ID}`);
      console.log(`   DB ready:      ${!!process.env.DATABASE_URL}`);
    });
  } catch (err) {
    console.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
}

start();
