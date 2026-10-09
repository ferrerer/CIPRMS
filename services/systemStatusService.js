// Real, reusable service-availability check (2026-11) — reads each integration's OWN already-existing
// status signal (googleCalendarService/googleDocsService integration docs + lastSyncOk, emailService's
// isConfigured()/verify(), a live MongoDB ping) rather than inventing a parallel monitoring system. A
// failure in one entry here must never be reported as "CIPRMS is down" — only Database failing is treated
// as a broader system problem (see `coreAvailable` below), matching the rest of the app via the existing
// getDb()/connectDB() contract.
const { getDb } = require('../db');
const googleCalendarService = require('./googleCalendarService');
const googleDocsService = require('./googleDocsService');
const emailService = require('./emailService');

const PING_TIMEOUT_MS = 4000;

function googleCredentialsConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// available: everything is working. degraded: configured/connected but the last real attempt failed.
// not_configured: the feature exists in CIPRMS but this server has no credentials for it (an infra/deploy
// choice, not a crash). unavailable: a hard failure (e.g. the database itself did not respond).
async function checkDatabase() {
  try {
    const db = getDb(); // throws synchronously if connectDB() never completed
    await withTimeout(db.command({ ping: 1 }), PING_TIMEOUT_MS);
    return { key: 'database', label: 'Database', state: 'available', message: 'Connected.' };
  } catch (err) {
    return { key: 'database', label: 'Database', state: 'unavailable', message: 'The database is not responding.' };
  }
}

async function checkGoogleCalendar() {
  if (!googleCredentialsConfigured()) {
    return { key: 'googleCalendar', label: 'Google Calendar', state: 'not_configured', message: 'Google credentials are not configured on this server.' };
  }
  try {
    const integration = await googleCalendarService.getIntegration(getDb());
    if (!integration) return { key: 'googleCalendar', label: 'Google Calendar', state: 'available', message: 'Not connected yet (optional — connect it from Account Settings).' };
    if (integration.lastSyncOk === false) {
      return { key: 'googleCalendar', label: 'Google Calendar', state: 'degraded', message: integration.lastSyncError || 'The last attempt to reach Google Calendar failed.' };
    }
    return { key: 'googleCalendar', label: 'Google Calendar', state: 'available', message: 'Connected.' };
  } catch (err) {
    return { key: 'googleCalendar', label: 'Google Calendar', state: 'unavailable', message: 'Could not check the Google Calendar connection.' };
  }
}

async function checkGoogleDocs() {
  if (!googleCredentialsConfigured()) {
    return { key: 'googleDocs', label: 'Google Docs', state: 'not_configured', message: 'Google credentials are not configured on this server.' };
  }
  try {
    const integration = await googleDocsService.getIntegration(getDb());
    if (!integration) return { key: 'googleDocs', label: 'Google Docs', state: 'available', message: 'Not connected yet (optional — connect it from Account Settings).' };
    if (integration.lastSyncOk === false) {
      return { key: 'googleDocs', label: 'Google Docs', state: 'degraded', message: integration.lastSyncError || 'The last attempt to reach Google Docs failed.' };
    }
    return { key: 'googleDocs', label: 'Google Docs', state: 'available', message: 'Connected.' };
  } catch (err) {
    return { key: 'googleDocs', label: 'Google Docs', state: 'unavailable', message: 'Could not check the Google Docs connection.' };
  }
}

async function checkEmail() {
  if (!emailService.isConfigured()) {
    return { key: 'email', label: 'Email Notifications', state: 'not_configured', message: 'Email sending is not configured on this server.' };
  }
  try {
    const result = await withTimeout(emailService.verify(), PING_TIMEOUT_MS);
    return result.ok
      ? { key: 'email', label: 'Email Notifications', state: 'available', message: 'Connected.' }
      : { key: 'email', label: 'Email Notifications', state: 'unavailable', message: result.error || 'Could not sign in to the mail server.' };
  } catch (err) {
    return { key: 'email', label: 'Email Notifications', state: 'unavailable', message: 'Could not reach the mail server.' };
  }
}

// OCR/extraction (tesseract.js, sharp, pdf-parse) is a bundled, in-process library, not a remote account to
// connect — there is no "connected/not connected" state, only "did the engine load." A missing/incompatible
// native dependency is the one realistic failure mode, and it would already break every OCR upload, so this
// is a genuine (if rarely-tripped) signal, not a fabricated one.
function checkOcr() {
  try {
    require('tesseract.js');
    require('sharp');
    require('pdf-parse');
    return { key: 'ocr', label: 'Document OCR / Extraction', state: 'available', message: 'Available.' };
  } catch (err) {
    return { key: 'ocr', label: 'Document OCR / Extraction', state: 'unavailable', message: 'The OCR engine failed to load on this server.' };
  }
}

const STATE_RANK = { unavailable: 3, degraded: 2, not_configured: 1, available: 0 };

async function getSystemStatus() {
  const [database, googleCalendar, googleDocs, email] = await Promise.all([
    checkDatabase(), checkGoogleCalendar(), checkGoogleDocs(), checkEmail()
  ]);
  const ocr = checkOcr();
  const services = [database, googleCalendar, googleDocs, email, ocr];

  // The database is the one dependency every other feature sits on top of — if it is down, this is a
  // whole-system problem, not "one feature is unavailable" (see section 11 of the brief this implements).
  const coreAvailable = database.state === 'available';
  const problems = services.filter(s => s.state !== 'available' && s.key !== 'database');
  const worst = problems.reduce((acc, s) => (STATE_RANK[s.state] > STATE_RANK[acc] ? s.state : acc), 'available');

  return {
    coreAvailable,
    overall: !coreAvailable ? 'unavailable' : (problems.length ? worst : 'available'),
    services,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  getSystemStatus, googleCredentialsConfigured,
  // Exported individually so tests can safely exercise each state (including "unavailable") without
  // touching a real external service — e.g. closeDB()/connectDB() around checkDatabase() to reproduce a
  // real-but-local database outage, or writing a lastSyncOk:false integration doc for the Google checks.
  checkDatabase, checkGoogleCalendar, checkGoogleDocs, checkEmail, checkOcr
};
