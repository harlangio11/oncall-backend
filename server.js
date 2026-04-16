/**
 * OnCall Backend Server
 *
 * Two responsibilities:
 * 1. Device registration — stores APNs device tokens + VIP contact lists from the app
 * 2. Twilio voice webhook — when a forwarded call comes in, checks if the caller
 *    is a VIP and fires a critical-alert push notification to wake the alarm
 *
 * Environment variables (set in Railway dashboard):
 *   PORT                — assigned by Railway automatically
 *   APNS_KEY            — contents of your .p8 key file (copy/paste the whole file)
 *   APNS_KEY_ID         — 10-char key ID shown in Apple Developer (e.g. ABC1234567)
 *   APNS_TEAM_ID        — 10-char Team ID from Apple Developer membership (e.g. ABCDE12345)
 *   APNS_BUNDLE_ID      — com.harlangiordano.oncall
 *   APNS_PRODUCTION     — "true" for App Store builds, leave empty for dev builds
 *   TWILIO_AUTH_TOKEN   — from Twilio console (used to validate webhook signatures)
 */

require('dotenv').config();
const express = require('express');
const apn     = require('@parse/node-apn');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── In-memory user store ─────────────────────────────────────────────────────
// For a single-user personal app this is perfectly fine.
// Format: { deviceToken: string, vipContacts: [{ name, phoneNumber }] }
let registeredUser = null;

// ─── APNs provider (lazy-init) ────────────────────────────────────────────────
let _apnProvider = null;

function getApnProvider() {
  if (_apnProvider) return _apnProvider;

  const keyContent = process.env.APNS_KEY;
  const keyId      = process.env.APNS_KEY_ID;
  const teamId     = process.env.APNS_TEAM_ID;

  if (!keyContent || !keyId || !teamId) {
    console.warn('[APNs] Missing credentials — push notifications will not work');
    return null;
  }

  _apnProvider = new apn.Provider({
    token: {
      key:    keyContent,   // full .p8 file content
      keyId:  keyId,
      teamId: teamId,
    },
    production: process.env.APNS_PRODUCTION === 'true',
  });

  console.log('[APNs] Provider initialized (production:', process.env.APNS_PRODUCTION === 'true', ')');
  return _apnProvider;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a phone number to digits only (last 10 digits for US numbers) */
function normalizePhone(number) {
  if (!number) return '';
  const digits = number.replace(/\D/g, '');
  return digits.slice(-10); // last 10 digits handles +1 prefix
}

/** Check whether callerNumber matches any VIP in the contact list */
function isVip(callerNumber, vipContacts) {
  if (!vipContacts || vipContacts.length === 0) return false;
  const callerNorm = normalizePhone(callerNumber);
  return vipContacts.some(c => normalizePhone(c.phoneNumber) === callerNorm);
}

/** Find the VIP contact object that matches a caller number */
function findVip(callerNumber, vipContacts) {
  const callerNorm = normalizePhone(callerNumber);
  return (vipContacts || []).find(c => normalizePhone(c.phoneNumber) === callerNorm) || null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Health check */
app.get('/', (req, res) => {
  res.json({
    status: 'OnCall backend running',
    deviceRegistered: !!registeredUser,
    vipCount: registeredUser ? registeredUser.vipContacts.length : 0,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * POST /register
 * Called by the app when monitoring is turned on.
 * Body: { deviceToken: string, vipContacts: [{ name, phoneNumber }] }
 */
app.post('/register', (req, res) => {
  const { deviceToken, vipContacts } = req.body;

  if (!deviceToken) {
    return res.status(400).json({ error: 'deviceToken is required' });
  }

  registeredUser = {
    deviceToken,
    vipContacts: Array.isArray(vipContacts) ? vipContacts : [],
  };

  console.log(`[Register] Device registered. VIP contacts: ${registeredUser.vipContacts.length}`);
  registeredUser.vipContacts.forEach(c =>
    console.log(`  • ${c.name} (${c.phoneNumber})`)
  );

  res.json({ success: true });
});

/**
 * POST /twilio/incoming-call
 * Twilio fires this when a call arrives at your Twilio number.
 * Since call forwarding is active on the user's iPhone (missed calls forward to
 * this Twilio number), by the time this fires the user already didn't answer.
 *
 * We check if the caller is a VIP → fire critical alert → tell Twilio to hang up.
 */
app.post('/twilio/incoming-call', async (req, res) => {
  const callerNumber = req.body.From  || '';
  const callerName   = req.body.CallerName || '';

  console.log(`[Twilio] Incoming call from ${callerNumber} (${callerName || 'unknown name'})`);

  if (!registeredUser) {
    console.warn('[Twilio] No device registered — cannot send alarm');
  } else if (isVip(callerNumber, registeredUser.vipContacts)) {
    const vip = findVip(callerNumber, registeredUser.vipContacts);
    const displayName = vip ? vip.name : (callerName || callerNumber);
    console.log(`[Twilio] ${displayName} is a VIP — firing alarm`);
    sendCriticalAlert(registeredUser.deviceToken, callerNumber, displayName);
  } else {
    console.log(`[Twilio] ${callerNumber} is not a VIP — ignoring`);
  }

  // Always tell Twilio to hang up (we don't re-ring the user's phone from here)
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

/**
 * POST /twilio/missed-call  (fallback / status callback)
 * Some Twilio configurations send a status callback instead of / in addition to
 * the incoming-call webhook. This handles that case.
 */
app.post('/twilio/missed-call', async (req, res) => {
  const callerNumber = req.body.From || '';
  const callStatus   = req.body.CallStatus || '';

  console.log(`[Twilio] Call status callback: ${callerNumber} → ${callStatus}`);

  const wasMissed = ['no-answer', 'busy', 'failed', 'canceled'].includes(callStatus);

  if (wasMissed && registeredUser && isVip(callerNumber, registeredUser.vipContacts)) {
    const vip = findVip(callerNumber, registeredUser.vipContacts);
    const displayName = vip ? vip.name : callerNumber;
    console.log(`[Twilio] Missed VIP call from ${displayName} — firing alarm`);
    sendCriticalAlert(registeredUser.deviceToken, callerNumber, displayName);
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

// ─── APNs critical alert ──────────────────────────────────────────────────────

async function sendCriticalAlert(deviceToken, callerNumber, callerName) {
  const provider = getApnProvider();
  if (!provider) {
    console.error('[APNs] Cannot send — provider not configured');
    return;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'com.harlangiordano.oncall';

  const notification = new apn.Notification();
  notification.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
  notification.topic  = bundleId;

  // Critical alert — bypasses silent mode and Do Not Disturb
  notification.sound = {
    critical: 1,
    name:     'alarm.wav',
    volume:   1.0,
  };

  notification.alert = {
    title: `📵 ${callerName} is trying to reach you`,
    body:  'Tap to dismiss the alarm',
  };

  // content-available: 1 wakes the app in the background so it can start the alarm
  notification.contentAvailable = true;

  notification.payload = {
    type:         'vip_call',
    callerNumber: callerNumber,
    callerName:   callerName,
  };

  // iOS 15+ interruption level
  notification.interruptionLevel = 'critical';

  try {
    const result = await provider.send(notification, deviceToken);
    if (result.failed && result.failed.length > 0) {
      console.error('[APNs] Push failed:', JSON.stringify(result.failed, null, 2));
    } else {
      console.log(`[APNs] ✅ Critical alert sent to device`);
    }
  } catch (err) {
    console.error('[APNs] Error:', err.message);
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ OnCall backend listening on port ${PORT}`);
  console.log(`   APNs key configured: ${!!process.env.APNS_KEY}`);
  console.log(`   Production mode:     ${process.env.APNS_PRODUCTION === 'true'}`);
});
