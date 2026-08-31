require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const passport = require('passport');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { connectDB, getDb } = require('./db');
const ocrRoutes = require('./routes/ocrRoutes');
const { updateDocument, archiveToDocumentLibrary, archiveRequestRecordToLibrary } = require('./services/documentLibraryService');
const googleCalendarService = require('./services/googleCalendarService');
const uploadAvatar = require('./middleware/avatarUploadMiddleware');
const uploadDoc = require('./middleware/uploadMiddleware');
const verifyMagicBytes = require('./middleware/verifyMagicBytes');

const app = express();
const PORT = process.env.PORT || 3000;

// ── PASSWORD SECURITY HELPERS ─────────────────────────────────────────────────
const BCRYPT_SALT_ROUNDS = 12;
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_SALT_ROUNDS);
}

/**
 * A hash always starts with $2a$/$2b$/$2y$ — used to tell a bcrypt hash
 * apart from a legacy plain-text password still sitting in the DB.
 */
function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (!isBcryptHash(stored)) return false; // legacy plain-text accounts must be migrated, not compared directly
  return bcrypt.compare(plain, stored);
}

function isStrongPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 8
    && /[a-z]/.test(pw)
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw);
}

const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.';

function generateTempPassword() {
  // Guaranteed to satisfy isStrongPassword(): fixed upper/lower/digit anchors + random body.
  const body = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, 'x');
  return `Tp${body}9`;
}

// Bypassed only under the automated test suite (NODE_ENV=test) — the suite's
// many independent logins would otherwise trip this shared, IP-keyed, in-memory
// limiter and spuriously fail unrelated tests. Never bypassed in production.
//
// Each named limiter below is its OWN rateLimit() instance (own counter per
// IP), not one shared object reused across routes — express-rate-limit keys
// solely by IP by default, so reusing a single instance across multiple
// routes means they'd all draw down the same shared counter, letting heavy
// legitimate traffic on one route (e.g. the institutions-search proxy) starve
// out an unrelated route (e.g. a password change) from the same IP. Caught
// live during Roadmap v2 Phase G2 verification: probing /api/institutions to
// confirm its limiter worked left zero budget for a same-IP admin password
// change moments later, using an earlier draft that shared one instance.
function makeRateLimiter(jsonMessage, htmlHandler) {
  if (process.env.NODE_ENV === 'test') return (req, res, next) => next();
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: jsonMessage },
    ...(htmlHandler ? { handler: htmlHandler } : {})
  });
}

const loginLimiter = makeRateLimiter(
  'Too many login attempts. Please wait 15 minutes and try again.',
  (req, res) => res.status(429).render('index', {
    activePage: '',
    error: 'Too many login attempts. Please wait 15 minutes and try again.'
  })
);

// Closes S11 (Roadmap v2 Phase G2, docs/SYSTEM_AUDIT_2026-07-16.md) — /signup,
// the three password-change routes, and the public /api/institutions proxy
// previously had no rate limiting at all. /signup renders the 'signup' page
// template on every other validation error, so its 429 handler matches that
// (not loginLimiter's 'index' render, which is the wrong template here).
const signupLimiter = makeRateLimiter(
  'Too many signup attempts. Please wait 15 minutes and try again.',
  (req, res) => res.status(429).render('signup', {
    activePage: '', user: null,
    formData: { name: req.body.username || '', email: req.body.email || '' },
    error: 'Too many signup attempts. Please wait 15 minutes and try again.'
  })
);
const institutionsLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const adminPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const personnelPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const partnerPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const staffPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');

// ── VIEW ENGINE ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// Render (and most PaaS hosts) terminate TLS at a proxy in front of the app, so
// Express needs to trust its X-Forwarded-Proto header — otherwise req.protocol
// always reads "http" and secure (HTTPS-only) session cookies never get set,
// breaking login in production.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/velzon/assets', express.static(path.join(__dirname, 'assets')));
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set in .env — using an insecure generated fallback for this run only.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: true,
  saveUninitialized: false,
  rolling: true,   // reset expiry on each request
  cookie: {
    maxAge: SESSION_IDLE_TIMEOUT_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── SESSION LIVE-REVALIDATION ─────────────────────────────────────────────────
// req.session.user is a snapshot taken at login. Without this, deactivating,
// deleting, or demoting a user in User Management has no effect on a session
// that's already logged in — the old snapshot keeps granting access until it
// happens to expire or the user manually logs out. Re-check against the real
// users record on every request so a revoked/changed account takes effect
// immediately, not up to 2 hours later.
app.use(async (req, res, next) => {
  if (!req.session || !req.session.user) return next();
  try {
    const db = getDb();
    const dbUser = await db.collection('users').findOne(
      { id: req.session.user.id },
      { projection: { password: 0 } }
    );
    if (!dbUser || dbUser.status === 'Inactive') {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/');
      });
    }
    // Keep the session in sync with any admin-side edits (role, name, unit)
    // instead of only refreshing them at the next login.
    req.session.user.role = dbUser.role;
    req.session.user.name = dbUser.name;
    req.session.user.unit = dbUser.unit || '';
    next();
  } catch (err) {
    next(err);
  }
});

// ── PASSPORT CONFIG ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET
},
  function (accessToken, refreshToken, profile, done) {
    return done(null, profile);
  }
));

passport.serializeUser(function (user, done) {
  done(null, user);
});

passport.deserializeUser(function (user, done) {
  done(null, user);
});

// ── RBAC MIDDLEWARE ───────────────────────────────────────────────────────────

/**
 * Requires ANY authenticated user (any role).
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/');
}

/**
 * Requires Administrator OR Auth. Personnel role.
 */
function requirePersonnel(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (user.role === 'Administrator' || user.role === 'Auth. Personnel') return next();
  return res.redirect(homeForRole(user.role));
}

/**
 * Requires Administrator, Auth. Personnel, or potential_partner — the roles
 * allowed to submit/edit/withdraw their own Partnership or Document
 * Requests. Staff is intentionally excluded: as of 2026-08-27 Staff no
 * longer submits requests at all (matching Administrator, who also only
 * reviews) — Staff's request authority is entirely on the reviewer side
 * (REQUEST_REVIEWER_ROLES / requireStaffAccess on the Approve/Reject/
 * Fulfill routes below), not the submitter side gated here.
 */
function requireRequester(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (['Administrator', 'Auth. Personnel', 'potential_partner'].includes(user.role)) return next();
  return res.redirect(homeForRole(user.role));
}

/**
 * Requires Administrator role only.
 */
function requireAdmin(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (user.role === 'Administrator') return next();
  // Non-admin users get redirected to their own dashboard
  return res.redirect(homeForRole(user.role));
}

/**
 * Requires the potential_partner role only (external orgs applying for partnership).
 */
function requirePartner(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (user.role === 'potential_partner') return next();
  return res.redirect(homeForRole(user.role));
}

/**
 * Requires Administrator, Auth. Personnel, potential_partner, OR Staff — i.e.
 * anyone allowed to upload/OCR a document, each scoped to their own uploads
 * (see OWN_SCOPE_ROLES/SELF_UPLOAD_ONLY_ROLES below).
 */
function requireUploader(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'].includes(user.role)) return next();
  return res.redirect(homeForRole(user.role));
}

/**
 * Requires Administrator OR Staff role. Mirrors requirePersonnel's
 * dual-role convention: Staff gets its own full `/staff/*` page namespace
 * reusing the same shared Administrator templates (dashboard/registry/
 * reports/calendar/lifecycle/documents/notifications/users/requests) via
 * the sidebarPartial override, the same pattern already used for Auth.
 * Personnel. As of the 2026-08-27 full-parity revision this gates most
 * mutation routes too (Partnerships, Requests, Users) — Administrator and
 * Staff are equals everywhere except: Calendar create/edit/delete (stays
 * requireAdmin — Staff is explicitly view-only there, unchanged by this
 * revision), Google Calendar integration config (requireAdmin — org-wide
 * system configuration), and any operation targeting an Administrator
 * account or granting the Administrator role (explicit in-handler checks
 * in the Users routes — a privilege-escalation guard, not a gap).
 */
function requireStaffAccess(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.redirect('/');
  if (user.role === 'Administrator' || user.role === 'Staff') return next();
  return res.redirect(homeForRole(user.role));
}

// ── HELPER: role → home URL ───────────────────────────────────────────────────
function homeForRole(role) {
  if (role === 'Administrator') return '/dashboard';
  if (role === 'Auth. Personnel') return '/personnel/dashboard';
  if (role === 'potential_partner') return '/partner/dashboard';
  return '/staff/dashboard';
}

// ── HELPER: role → user-visible label ──────────────────────────────────────────
function formatRole(role) {
  if (role === 'potential_partner') return 'Partner';
  return role || '';
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Already logged in → bounce to appropriate dashboard
  if (req.session && req.session.user) {
    return res.redirect(homeForRole(req.session.user.role));
  }
  res.render('index', { activePage: '', error: undefined });
});

app.get('/signup', (req, res) => {
  res.render('signup', { activePage: '', user: null, formData: { name: '', email: '' } });
});

// ── GOOGLE AUTH ROUTES ────────────────────────────────────────────────────────

function getCallbackUrl(req) {
  const host = req.get('host') || 'localhost:3000';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/auth/google/callback`;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}/auth/google/callback`;
}

app.get('/auth/google', (req, res, next) => {
  const callbackUrl = getCallbackUrl(req);
  console.log(`[AUTH] Redirecting to Google with callback URL: ${callbackUrl}`);
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    callbackURL: callbackUrl
  })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  const callbackUrl = getCallbackUrl(req);

  passport.authenticate('google', {
    failureRedirect: '/',
    callbackURL: callbackUrl
  }, async function (err, googleUser, info) {
    if (err) {
      console.error('❌ OAuth Error:', err.message);
      return next(err);
    }
    if (!googleUser) {
      console.warn('⚠️  No user returned from OAuth');
      return res.redirect('/');
    }

    try {
      const db = getDb();
      const googleEmail = (googleUser.emails && googleUser.emails[0])
        ? googleUser.emails[0].value.trim().toLowerCase()
        : null;

      if (!googleEmail) {
        return res.render('index', { activePage: '', error: 'Google account has no email. Please use a different login method.' });
      }

      // Look up user in our users collection
      let dbUser = await db.collection('users').findOne({ email: googleEmail });

      if (!dbUser) {
        // New Google user — auto-create as Staff
        const lastUser = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
        const nextId = lastUser.length ? lastUser[0].id + 1 : 1;
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        dbUser = {
          id: nextId,
          name: googleUser.displayName || googleEmail.split('@')[0],
          email: googleEmail,
          role: 'Staff',
          unit: '',
          login: today,
          status: 'Active',
          password: null,  // Google-only account — no password
          googleId: googleUser.id,
          createdAt: today
        };
        await db.collection('users').insertOne(dbUser);
        console.log(`✓ New Google user auto-created as Staff: ${googleEmail}`);
      } else {
        if (dbUser.status === 'Inactive') {
          return res.render('index', { activePage: '', error: 'Your account is inactive. Please contact the Administrator.' });
        }
        // Update last login
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        await db.collection('users').updateOne({ email: googleEmail }, { $set: { login: today } });
        console.log(`✓ Google login: ${dbUser.name} (${dbUser.role})`);
      }

      // Regenerate session to prevent fixation, then store user data
      req.session.regenerate((regenErr) => {
        if (regenErr) return next(regenErr);
        req.session.user = {
          id: dbUser.id,
          name: dbUser.name,
          email: dbUser.email,
          role: dbUser.role,
          unit: dbUser.unit || ''
        };
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          console.log(`✓ Google login: ${dbUser.name} (${dbUser.role})`);
          return res.redirect(homeForRole(dbUser.role));
        });
      });

    } catch (dbErr) {
      console.error('❌ DB error during Google login:', dbErr);
      return next(dbErr);
    }
  })(req, res, next);
});

// ── FORM LOGIN ────────────────────────────────────────────────────────────────
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('index', { activePage: '', error: 'Please enter your email and password.' });
  }

  try {
    const db = getDb();
    // Look up user by email (the "username" field on the login form is the email)
    const user = await db.collection('users').findOne({
      email: username.trim().toLowerCase()
    });

    if (!user) {
      return res.render('index', { activePage: '', error: 'Invalid email or password.' });
    }

    if (user.status === 'Inactive') {
      return res.render('index', { activePage: '', error: 'Your account is inactive. Please contact the Administrator.' });
    }

    if (!user.password) {
      // Google-only account (no local password set) — must sign in via "Continue with Google".
      return res.render('index', { activePage: '', error: 'This account signs in with Google. Please use "Continue with Google".' });
    }

    if (!isBcryptHash(user.password)) {
      // Legacy plain-text account that predates the password migration.
      return res.render('index', { activePage: '', error: 'Your account needs a password reset. Please contact the Administrator.' });
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      return res.render('index', { activePage: '', error: 'Invalid email or password.' });
    }

    // Regenerate session to prevent fixation, then store user data
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error('❌ Session regenerate error:', regenErr);
        return res.render('index', { activePage: '', error: 'Session error. Please try again.' });
      }
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        unit: user.unit || ''
      };

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('❌ Session save error:', saveErr);
          return res.render('index', { activePage: '', error: 'Session error. Please try again.' });
        }

        // Update last login timestamp (fire-and-forget)
        const loginDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        getDb().collection('users').updateOne({ email: user.email }, { $set: { login: loginDate } }).catch(() => { });

        console.log(`✓ Login: ${user.name} (${user.role})`);
        res.redirect(homeForRole(user.role));
      });
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.render('index', { activePage: '', error: 'A server error occurred. Please try again.' });
  }
});

app.post('/signup', signupLimiter, async (req, res) => {
  const { username: name, email, password, confirmPassword } = req.body;
  // Re-render with whatever the user already typed on any error — never the password.
  const formData = { name: name || '', email: email || '' };

  if (!name || !email || !password) {
    return res.render('signup', { activePage: '', user: null, formData, error: 'All fields are required.' });
  }
  if (password !== confirmPassword) {
    return res.render('signup', { activePage: '', user: null, formData, error: 'Passwords do not match.' });
  }
  if (!isStrongPassword(password)) {
    return res.render('signup', { activePage: '', user: null, formData, error: PASSWORD_POLICY_MESSAGE });
  }

  try {
    const db = getDb();
    const normalizedEmail = email.trim().toLowerCase();

    // Check if email already exists
    const existing = await db.collection('users').findOne({ email: normalizedEmail });
    if (existing) {
      return res.render('signup', { activePage: '', user: null, formData, error: 'An account with this email already exists. Please sign in.' });
    }

    // Auto-assign next ID
    const lastUser = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = lastUser.length ? lastUser[0].id + 1 : 1;
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const newUser = {
      id: nextId,
      name: name.trim(),
      email: normalizedEmail,
      role: 'Staff',     // All new signups start as Staff
      unit: '',
      login: 'Never',
      status: 'Active',
      password: await hashPassword(password),
      createdAt: today
    };

    await db.collection('users').insertOne(newUser);
    console.log(`✓ New user registered as Staff: ${normalizedEmail}`);

    // Regenerate session to prevent fixation, then store user data
    req.session.regenerate((regenErr) => {
      if (regenErr) return res.render('signup', { activePage: '', user: null, formData, error: 'Session error. Please try again.' });
      req.session.user = {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        unit: newUser.unit || ''
      };
      req.session.save((saveErr) => {
        if (saveErr) return res.render('signup', { activePage: '', user: null, formData, error: 'Session error. Please try again.' });
        res.redirect(homeForRole(newUser.role));  // → /staff/dashboard
      });
    });

  } catch (err) {
    console.error('❌ Signup error:', err);
    res.render('signup', { activePage: '', user: null, formData, error: 'A server error occurred. Please try again.' });
  }
});

// ── LOGOUT —————————————————————————————————————————————————
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('❌ Logout session destroy error:', err);
    // Clear the session cookie from the browser so it cannot reuse the old ID
    res.clearCookie('connect.sid', { path: '/' });
    res.redirect('/');
  });
});

// ── SESSION USER API ──────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ── API ENDPOINTS FOR DYNAMIC DATA ───────────────────────────────────────────
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const partnerships = await db.collection('partnerships').find({}).toArray();
    const requests = await db.collection('requests').find({}).toArray();

    const active = partnerships.filter(p => p.status === 'active').length;
    const expiring = partnerships.filter(p => p.status === 'expiring').length;
    const expired = partnerships.filter(p => p.status === 'expired').length;

    const pendingReqs = requests.filter(r => r.status === 'pending').length;
    const approvedReqs = requests.filter(r => r.status === 'approved').length;
    const rejectedReqs = requests.filter(r => r.status === 'rejected').length;

    const uniqueCountries = new Set(partnerships.map(p => p.country)).size;
    const uniqueInstitutions = new Set(partnerships.map(p => p.institution)).size;

    res.json({
      totalPartnerships: partnerships.length,
      activePartnerships: active,
      expiringPartnerships: expiring,
      expiredPartnerships: expired,
      totalRequests: requests.length,
      pendingRequests: pendingReqs,
      approvedRequests: approvedReqs,
      rejectedRequests: rejectedReqs,
      countries: uniqueCountries,
      institutions: uniqueInstitutions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve dashboard stats' });
  }
});

// Shared read-only partnership directory — intentionally visible to Administrator,
// Auth. Personnel, potential_partner, AND Staff (partner_dashboard.ejs's
// map/insights panels depend on the full list, not just their own — see /mine
// below for the org-scoped variant; Staff's Partnership Registry/DSS pages
// depend on it too). requireUploader (already used for the OCR upload routes)
// is reused here rather than requireAuth, keeping this scoped to the same
// four internal/uploading roles.
app.get('/api/partnerships', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('partnerships').find({}).toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve partnerships' });
  }
});

// Partnerships linked (by institution name, best-effort match) to the current
// user's own APPROVED requests only — used by the potential_partner Monitoring
// and Reports pages so they never receive other organizations' registry data,
// unlike the full /api/partnerships feed above.
app.get('/api/partnerships/mine', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const myApproved = await db.collection('requests').find({ submittedByEmail: email, status: 'Approved' }).toArray();
    const names = [...new Set(myApproved.map(r => r.institution).filter(Boolean))];
    if (names.length === 0) return res.json([]);
    const patterns = names.map(name => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    const matches = await db.collection('partnerships').find({ inst: { $in: patterns } }).toArray();
    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve partnerships' });
  }
});

// Administrator and Staff (2026-08-27 full-parity revision — Staff now
// manages every Partnership Request, not just its own) see every submitted
// request — this is what powers partnership_requests.ejs's org-wide review
// table for both roles. Every other role is scoped to only the requests
// they themselves submitted (same `submittedByEmail` filter as
// GET /api/requests/mine below).
const REQUEST_REVIEWER_ROLES = ['Administrator', 'Staff'];
app.get('/api/requests', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const filter = req.session.user && REQUEST_REVIEWER_ROLES.includes(req.session.user.role) ? {} : { submittedByEmail: email };
    const requests = await db.collection('requests').find(filter).toArray();
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve requests' });
  }
});

// 'Active' if the new expiry is more than 90 days out, 'Expiring Soon' within
// 90 days, 'Expired' if it's already past — same thresholds used everywhere
// else in the app (stat cards, dashboards, expiring tables).
function computePartnershipStatus(endDateStr) {
  const end = new Date(endDateStr);
  if (isNaN(end)) return 'Active';
  const days = Math.ceil((end - new Date()) / 86400000);
  if (days <= 0) return 'Expired';
  if (days <= 90) return 'Expiring Soon';
  return 'Active';
}

// Request a renewal for a partnership tied to this user's own approved request.
// Creates a normal `requests` entry marked isRenewal — it's reviewed through the
// exact same admin queue as any other partnership request; approving it is what
// actually extends the underlying partnership record (see PATCH /api/requests/:id).
app.post('/api/partnerships/:id/renew-request', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { proposedEndDate, notes } = req.body;
  if (!proposedEndDate || isNaN(new Date(proposedEndDate))) {
    return res.status(400).json({ error: 'A valid proposedEndDate is required.' });
  }
  try {
    const db = getDb();
    const partnership = await db.collection('partnerships').findOne({ id });
    if (!partnership) return res.status(404).json({ error: 'Partnership not found.' });

    // Ownership check — same institution-name match used by /api/partnerships/mine.
    const email = req.session.user ? req.session.user.email : '';
    const myApproved = await db.collection('requests').find({ submittedByEmail: email, status: 'Approved' }).toArray();
    const myNames = new Set(myApproved.map(r => (r.institution || '').trim().toLowerCase()).filter(Boolean));
    const partnershipName = (partnership.inst || partnership.institution || '').trim().toLowerCase();
    if (!partnershipName || !myNames.has(partnershipName)) {
      return res.status(403).json({ error: 'You can only request renewal for your own partnership.' });
    }

    // Only one pending renewal request per partnership at a time.
    const existingRenewal = await db.collection('requests').findOne({
      renewalPartnershipId: id,
      status: { $in: ['Pending', 'Under Review'] }
    });
    if (existingRenewal) {
      return res.status(409).json({ error: 'A renewal request for this partnership is already pending.' });
    }

    const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length > 0 ? (last[0].id + 1) : 1;

    const entry = {
      id: nextId,
      institution: partnership.inst || partnership.institution || '',
      country: partnership.country || '',
      type: partnership.type || '',
      nature: partnership.nature || 'Renewal',
      category: partnership.cat || partnership.category || '',
      region: partnership.region || '',
      unit: partnership.unit || '',
      startDate: partnership.start || '',
      endDate: proposedEndDate,
      notes: notes || '',
      isRenewal: true,
      renewalPartnershipId: id,
      requestedBy: req.session.user ? req.session.user.name : 'Unknown',
      submittedByEmail: email,
      status: 'Pending',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      updatedAt: new Date().toISOString()
    };

    await db.collection('requests').insertOne(entry);
    await logActivity(db, req.session.user, 'SUBMIT',
      `Renewal request submitted: ${entry.institution} (${entry.type}) by ${entry.requestedBy}`);

    res.json({ success: true, request: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a new partnership request (any authenticated user).
// `isDraft: true` saves it as a Draft instead of submitting it for review —
// used by the potential_partner Partnership Request module so an applicant
// can start a request and finish it later (see the /edit and /submit routes
// below for the rest of the draft lifecycle).
app.post('/api/requests', requireRequester, async (req, res) => {
  const {
    institution, country, type, nature, notes, requestedBy, isDraft,
    category, region, unit, startDate, endDate, attachmentLink,
    isRenewal, renewalPartnershipId
  } = req.body;

  const draft = isDraft === true;
  // Drafts are allowed to be incomplete — only a real submission requires the core fields.
  if (!draft && (!institution || !country || !type || !nature)) {
    return res.status(400).json({ error: 'Missing required fields: institution, country, type, nature.' });
  }
  try {
    const db = getDb();

    // Prevent duplicate active requests for the same institution (drafts don't count).
    if (!draft && institution) {
      const existing = await db.collection('requests').findOne({
        institution,
        status: { $in: ['Pending', 'Under Review'] }
      });
      if (existing) {
        return res.status(409).json({ error: 'A pending request for this institution already exists.' });
      }
    }

    const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length > 0 ? (last[0].id + 1) : 1;

    const entry = {
      id: nextId,
      institution: (institution || '').trim(),
      country: (country || '').trim(),
      type: type || '',
      nature: (nature || '').trim(),
      category: category || '',
      region: region || '',
      unit: unit || '',
      startDate: startDate || '',
      endDate: endDate || '',
      attachmentLink: attachmentLink || '',
      notes: notes || '',
      requestedBy: requestedBy || (req.session.user ? req.session.user.name : 'Unknown'),
      submittedByEmail: req.session.user ? req.session.user.email : '',
      status: draft ? 'Draft' : 'Pending',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      updatedAt: new Date().toISOString(),
      ...(isRenewal ? { isRenewal: true, renewalPartnershipId: renewalPartnershipId } : {})
    };

    await db.collection('requests').insertOne(entry);
    if (!draft) {
      await logActivity(db, req.session.user, 'SUBMIT',
        `Partnership request submitted: ${institution} (${type}) by ${entry.requestedBy}`);

      // Administrator and Staff — both review Partnership/Renewal Requests
      // (PATCH /api/requests/:id is requireStaffAccess-gated as of the
      // 2026-08-27 full-parity revision). Auth. Personnel was previously
      // broadcast an FYI alert for every submission by every user org-wide,
      // including other Auth. Personnel and potential_partner accounts they
      // have no relationship to — not "their own" notifications, and not
      // actionable by them. The submitter doesn't notify themselves.
      const reviewers = await db.collection('users')
        .find({ role: { $in: REQUEST_REVIEWER_ROLES } })
        .toArray();
      await notifyUsers(db, reviewers.map(u => u.email), {
        module: 'request',
        tag: isRenewal ? 'Renewal Request' : 'Partnership Request',
        icon: isRenewal ? 'ri-refresh-line' : 'ri-building-4-line',
        color: isRenewal ? 'info' : 'primary',
        title: isRenewal ? `Renewal initiated: ${entry.institution}` : `New request submitted: ${entry.institution}`,
        desc: isRenewal
          ? `${entry.requestedBy} initiated a renewal request for ${entry.institution}.`
          : `${entry.requestedBy} submitted a new partnership request for ${entry.institution}.`,
        link: '/partnership-requests?open=pr&id=' + nextId
      });

      // Give the submitter their own copy in the Document Library — skipped
      // when an OCR attachment already exists, since that upload was already
      // archived there (avoids a duplicate entry for one submission).
      if (['Auth. Personnel', 'potential_partner'].includes(req.session.user.role) && !entry.attachmentLink) {
        await archiveRequestRecordToLibrary(db, {
          requestType: 'partnership', requestId: nextId, institution: entry.institution,
          type: entry.type, submittedBy: entry.requestedBy, submittedByEmail: entry.submittedByEmail
        });
      }
    }

    res.json({ success: true, request: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a request that is still a Draft — self-service, ownership-checked.
// Once a request is submitted (Pending/Under Review/etc.) it can no longer be
// edited this way, only withdrawn.
app.patch('/api/requests/:id/edit', requireRequester, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only edit your own request.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be edited. Withdraw a submitted request instead.' });
    }

    const allowed = ['institution', 'country', 'type', 'nature', 'category', 'region', 'unit', 'startDate', 'endDate', 'notes', 'attachmentLink'];
    const patch = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    await db.collection('requests').updateOne({ id }, { $set: patch });
    const updated = await db.collection('requests').findOne({ id });
    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a previously-saved Draft for review — self-service, ownership-checked.
app.post('/api/requests/:id/submit', requireRequester, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only submit your own request.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be submitted.' });
    }
    if (!target.institution || !target.country || !target.type || !target.nature) {
      return res.status(400).json({ error: 'Please complete institution, country, agreement type, and nature before submitting.' });
    }

    const existing = await db.collection('requests').findOne({
      institution: target.institution,
      status: { $in: ['Pending', 'Under Review'] },
      id: { $ne: id }
    });
    if (existing) {
      return res.status(409).json({ error: 'A pending request for this institution already exists.' });
    }

    await db.collection('requests').updateOne({ id }, {
      $set: { status: 'Pending', date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), updatedAt: new Date().toISOString() }
    });
    const updated = await db.collection('requests').findOne({ id });
    await logActivity(db, req.session.user, 'SUBMIT',
      `Partnership request submitted: ${updated.institution} (${updated.type}) by ${updated.requestedBy}`);

    if (['Auth. Personnel', 'potential_partner'].includes(req.session.user.role) && !updated.attachmentLink) {
      await archiveRequestRecordToLibrary(db, {
        requestType: 'partnership', requestId: id, institution: updated.institution,
        type: updated.type, submittedBy: updated.requestedBy, submittedByEmail: updated.submittedByEmail
      });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a Draft outright — self-service, ownership-checked. Submitted
// requests must be withdrawn instead (see /withdraw below), not deleted.
app.delete('/api/requests/:id', requireRequester, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only delete your own draft.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be deleted.' });
    }
    await db.collection('requests').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get partnership requests submitted by current user (by email)
app.get('/api/requests/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const requests = await db.collection('requests')
      .find({ submittedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prevents re-running side effects (duplicate partnership-extension updates,
// duplicate notifications, duplicate activity-log entries, duplicate
// role-promotions) by rejecting a decision PATCH unless the request is still
// in an undecided state — closes B4 (Roadmap v2 Phase C2,
// docs/SYSTEM_AUDIT_2026-07-16.md): previously a request could be approved
// twice, rejected after already being approved, or approved after being
// withdrawn, each re-run re-executing every side effect.
const UNDECIDED_REQUEST_STATUSES = ['Pending', 'Under Review'];

// Update partnership request status (approve / reject) — Administrator and
// Staff share this exact review authority as of 2026-08-27 (full parity).
app.patch('/api/requests/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, notes } = req.body;
  const validStatuses = ['Pending', 'Under Review', 'Approved', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const db = getDb();
    if (['Approved', 'Rejected'].includes(status)) {
      const current = await db.collection('requests').findOne({ id });
      if (!current) return res.status(404).json({ error: 'Request not found.' });
      if (!UNDECIDED_REQUEST_STATUSES.includes(current.status)) {
        return res.status(400).json({ error: `This request has already been decided (current status: ${current.status}) and cannot be changed.` });
      }
    }
    await db.collection('requests').updateOne(
      { id },
      { $set: { status, notes: notes || '', updatedAt: new Date().toISOString(), decidedBy: req.session.user.name } }
    );
    const updated = await db.collection('requests').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Request not found.' });
    const action = status === 'Approved' ? 'APPROVE' : status === 'Rejected' ? 'REJECT' : 'EDIT';
    await logActivity(db, req.session.user, action,
      `Partnership request ${status.toLowerCase()}: ${updated.inst || updated.institution || 'ID #' + id} (${updated.type || ''})`);

    // Approving a renewal request doesn't just flip its own status — it actually
    // extends the linked partnership record (new expiry + recomputed status).
    if (status === 'Approved' && updated.isRenewal && updated.renewalPartnershipId) {
      const newStatus = computePartnershipStatus(updated.endDate);
      const parsedEnd = new Date(updated.endDate);
      const formattedEnd = isNaN(parsedEnd)
        ? updated.endDate
        : parsedEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const setFields = { end: formattedEnd, status: newStatus };
      if (!isNaN(parsedEnd)) setFields.endYear = parsedEnd.getFullYear();
      await db.collection('partnerships').updateOne({ id: updated.renewalPartnershipId }, { $set: setFields });
      await logActivity(db, req.session.user, 'RENEW',
        `Partnership renewed: ${updated.institution} — new expiry ${formattedEnd}`);
    }

    // Notify the submitter directly (targeted — not part of the global staff
    // feed) so a potential_partner actually finds out their request moved.
    // Includes the 'Under Review' transition (previously silent) as the
    // "additional documents requested" signal — the Administrator has no
    // separate action for this, so re-using the existing status value avoids
    // adding a new field/workflow for what is still just a status change.
    if (['Approved', 'Rejected', 'Under Review'].includes(status) && updated.submittedByEmail) {
      const label = updated.isRenewal ? 'Renewal Request' : 'Partnership Request';
      const submitter = await db.collection('users').findOne({ email: updated.submittedByEmail });
      const link = prLinkForRole(submitter && submitter.role, id);
      let title, desc, icon, color;
      if (status === 'Under Review') {
        title = `Additional documents requested: ${updated.institution}`;
        desc = `The Administrator has requested additional documents or information for your ${updated.isRenewal ? 'renewal' : 'partnership'} request (${updated.institution}).${notes ? ' Note: ' + notes : ''}`;
        icon = 'ri-file-add-line'; color = 'warning';
      } else {
        title = `${label} ${status}: ${updated.institution}`;
        icon = status === 'Approved' ? 'ri-checkbox-circle-line' : 'ri-close-circle-line';
        color = status === 'Approved' ? 'success' : 'danger';
        desc = status === 'Approved'
          ? (updated.isRenewal
            ? `Your renewal request for ${updated.institution} has been approved. The partnership has been extended.`
            : `Your partnership request for ${updated.institution} has been approved.`)
          : (updated.isRenewal
            ? `Your renewal request for ${updated.institution} was not approved.${notes ? ' Reason: ' + notes : ''}`
            : `Your partnership request for ${updated.institution} was not approved.${notes ? ' Reason: ' + notes : ''}`);
      }
      await notifyUsers(db, [updated.submittedByEmail], { module: 'request', tag: label, icon, color, title, desc, link });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Administrator or Staff uploads a supporting document while reviewing a
// Partnership Request draft/document collaboration timeline (2026-08-27
// revision). Either side of the conversation can add a new version here:
// Administrator/Staff (REQUEST_REVIEWER_ROLES, reviewing) or the request's
// own submitter (Auth. Personnel/potential_partner, revising their own
// draft) — never anyone else's request. Reuses the exact same secure
// upload workflow as everywhere else (uploadMiddleware's multer instance +
// verifyMagicBytes) and the Document Library's own archive function — the
// file is stored once, in the Document Library, and linked back from the
// request; it is not duplicated into a second, request-specific location.
// Ownership is always set to the requester's email (regardless of which
// side actually uploaded) so every version automatically appears in the
// requester's own Document Library view, and so the existing
// GET /uploads/documents/:filename ownership check already lets the true
// requester (and both reviewer roles) open any version — no changes needed
// there. Every version is pushed, never replaced — supportingDocuments is a
// running history, not a single current file.
app.post('/api/requests/:id/documents', requireAuth, (req, res) => {
  uploadDoc.single('document')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 10MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    if (!verifyMagicBytes(req.file)) {
      return res.status(400).json({ error: 'Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.' });
    }
    const id = parseInt(req.params.id);
    const actor = req.session.user;
    try {
      const db = getDb();
      const target = await db.collection('requests').findOne({ id });
      if (!target) {
        fs.unlink(req.file.path, () => { });
        return res.status(404).json({ error: 'Request not found.' });
      }

      const isReviewer = REQUEST_REVIEWER_ROLES.includes(actor.role);
      const isOwner = target.submittedByEmail && target.submittedByEmail === actor.email;
      if (!isReviewer && !isOwner) {
        fs.unlink(req.file.path, () => { });
        return res.status(403).json({ error: 'You are not authorized to upload documents to this request.' });
      }
      if (['Approved', 'Rejected', 'Withdrawn'].includes(target.status)) {
        fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: `This request has already been ${target.status.toLowerCase()} — no further documents can be added.` });
      }

      const note = (req.body.note || '').trim().slice(0, 1000);

      const { documentId, fileLink } = await archiveToDocumentLibrary(req.file.path, req.file.originalname, {
        documentType: expandDocTypeLabel(target.type),
        institution: target.institution,
        partner: target.institution,
        title: `${target.type || 'Document'} – ${target.institution} (Request #${id})`
      }, {
        uploadedBy: target.requestedBy || 'Unknown',
        uploadedByEmail: target.submittedByEmail,
        requestId: id,
        requestType: 'partnership'
      });

      const docRecord = {
        documentId, fileLink, originalFilename: req.file.originalname,
        uploadedAt: new Date().toISOString(), uploadedBy: actor.name,
        uploadedByEmail: actor.email, uploaderRole: actor.role,
        note, fileType: req.file.mimetype, fileSize: req.file.size
      };
      const setFields = { updatedAt: new Date().toISOString() };
      // A new version puts the request back "in collaboration" — reuses the
      // existing Under Review status rather than inventing a new one (it
      // already means exactly this for Approve/Reject purposes too).
      if (target.status === 'Pending') setFields.status = 'Under Review';
      await db.collection('requests').updateOne({ id }, { $push: { supportingDocuments: docRecord }, $set: setFields });
      const updated = await db.collection('requests').findOne({ id });

      await logActivity(db, actor, 'EDIT',
        `Draft document uploaded for partnership request: ${target.institution} (${req.file.originalname})${note ? ' — "' + note + '"' : ''}`);

      // Reviewer uploaded → notify the requester. Requester uploaded a
      // revision → notify every reviewer (same broadcast set used for a
      // brand-new submission), not just Administrator.
      if (isReviewer && target.submittedByEmail) {
        const submitter = await db.collection('users').findOne({ email: target.submittedByEmail });
        await notifyUsers(db, [target.submittedByEmail], {
          module: 'request',
          tag: target.isRenewal ? 'Renewal Request' : 'Partnership Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `New draft uploaded: ${target.institution}`,
          desc: `${actor.name} uploaded "${req.file.originalname}" for your request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: prLinkForRole(submitter && submitter.role, id),
          downloadLink: fileLink
        });
      } else if (isOwner) {
        const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
        await notifyUsers(db, reviewers.map(u => u.email), {
          module: 'request',
          tag: target.isRenewal ? 'Renewal Request' : 'Partnership Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `Revised draft uploaded: ${target.institution}`,
          desc: `${actor.name} uploaded a revised draft "${req.file.originalname}" for their request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: prLinkForRole('Administrator', id)
        });
      }

      res.json({ success: true, documentId, fileLink, request: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Withdraw own request — self-service, any authenticated user (not admin-gated like the route above).
// Only the original submitter may withdraw, and only while it's still Pending/Under Review.
app.post('/api/requests/:id/withdraw', requireRequester, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only withdraw your own request.' });
    }
    if (!['Pending', 'Under Review'].includes(target.status)) {
      return res.status(400).json({ error: 'Only pending or under-review requests can be withdrawn.' });
    }

    await db.collection('requests').updateOne({ id }, { $set: { status: 'Withdrawn', updatedAt: new Date().toISOString() } });
    const updated = await db.collection('requests').findOne({ id });
    await logActivity(db, req.session.user, 'EDIT',
      `Partnership request withdrawn: ${updated.institution} (${updated.type})`);
    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Document Requests (Auth. Personnel + potential_partner) ─────────────
// Replaces Personnel's old "new partnership" submission. Personnel/partner
// may only request MOA, MOU, or Accreditation documents — never a new
// partnership (that's the separate Partnership Request workflow).
const DOCUMENT_REQUEST_TYPES = ['MOA', 'MOU', 'Accreditation'];

app.post('/api/document-requests', requireRequester, async (req, res) => {
  const { institution, documentType, notes, contactNumber, documentForm } = req.body;
  if (!institution || !documentType) {
    return res.status(400).json({ error: 'Missing required fields: institution, documentType.' });
  }
  if (!DOCUMENT_REQUEST_TYPES.includes(documentType)) {
    return res.status(400).json({ error: 'documentType must be one of: ' + DOCUMENT_REQUEST_TYPES.join(', ') + '.' });
  }
  try {
    const db = getDb();
    const last = await db.collection('documentrequests').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length > 0 ? (last[0].id + 1) : 1;

    const entry = {
      id: nextId,
      institution: institution.trim(),
      documentType,
      notes: notes || '',
      // Contact Number and Document Form (Printed/Digital Copy) exist solely to
      // populate the official CSPC-F-CIRL-04 printable form — no other part of
      // the app reads them.
      contactNumber: contactNumber || '',
      documentForm: documentForm || '',
      requestedBy: req.session.user ? req.session.user.name : 'Unknown',
      requestedByEmail: req.session.user ? req.session.user.email : '',
      status: 'Pending',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.collection('documentrequests').insertOne(entry);
    await logActivity(db, req.session.user, 'SUBMIT',
      `Document request submitted: ${entry.documentType} for ${entry.institution} by ${entry.requestedBy}`);

    const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
    await notifyUsers(db, reviewers.map(u => u.email), {
      module: 'request',
      tag: 'Document Request',
      icon: 'ri-file-shield-2-line',
      color: 'secondary',
      title: `New document request submitted: ${entry.institution}`,
      desc: `${entry.requestedBy} requested a ${entry.documentType} document for ${entry.institution}.`,
      link: '/partnership-requests?open=dr&id=' + nextId
    });

    // Document Requests never have an upload step of their own, so this is
    // the only copy of the submission that ever lands in the requester's
    // Document Library — links to the existing printable form (built for the
    // print/PDF feature) rather than a fabricated file.
    if (['Auth. Personnel', 'potential_partner'].includes(req.session.user.role)) {
      await archiveRequestRecordToLibrary(db, {
        requestType: 'document', requestId: nextId, institution: entry.institution,
        type: entry.documentType, submittedBy: entry.requestedBy, submittedByEmail: entry.requestedByEmail,
        viewLink: `/document-requests/${nextId}/print`
      });
    }

    res.json({ success: true, request: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/document-requests/mine', requireRequester, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const requests = await db.collection('documentrequests')
      .find({ requestedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel own document request — self-service, ownership-checked, Pending-only.
app.delete('/api/document-requests/:id', requireRequester, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Document request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.requestedByEmail !== email) {
      return res.status(403).json({ error: 'You can only cancel your own document request.' });
    }
    if (target.status !== 'Pending') {
      return res.status(400).json({ error: 'Only pending document requests can be cancelled.' });
    }
    await db.collection('documentrequests').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all document requests (admin review queue) — requireStaffAccess so
// Administrator and Staff manage every Document Request (full parity,
// 2026-08-27) via the shared Requests page's Document Requests tab. Same
// reviewer-role scoping as GET /api/requests above: any other role sees
// only their own — moot in practice since only Administrator/Auth.
// Personnel/potential_partner can submit these (requireRequester), but kept
// consistent/correct rather than relying on that being permanently true.
app.get('/api/document-requests', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const filter = req.session.user && REQUEST_REVIEWER_ROLES.includes(req.session.user.role) ? {} : { requestedByEmail: email };
    const requests = await db.collection('documentrequests').find(filter).sort({ id: -1 }).toArray();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fulfill / reject a document request — Administrator or Staff (full parity).
app.patch('/api/document-requests/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, remark, releasedBy, receivedBy } = req.body;
  const validStatuses = ['Pending', 'Under Review', 'Fulfilled', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const db = getDb();
    if (['Fulfilled', 'Rejected'].includes(status)) {
      const current = await db.collection('documentrequests').findOne({ id });
      if (!current) return res.status(404).json({ error: 'Document request not found.' });
      if (!UNDECIDED_REQUEST_STATUSES.includes(current.status)) {
        return res.status(400).json({ error: `This request has already been decided (current status: ${current.status}) and cannot be changed.` });
      }
    }
    const now = new Date().toISOString();
    // decidedBy/updatedAt double as "Approved By"/"Approval Date" on the
    // printable form. Released By / Received By are optional, admin-typed
    // signature-line values for the same paper form — only meaningful (and
    // only ever sent by the UI) alongside a Fulfilled decision.
    const setFields = { status, remark: remark || '', updatedAt: now, decidedBy: req.session.user.name };
    if (status === 'Fulfilled') {
      if (releasedBy) { setFields.releasedBy = releasedBy; setFields.releasedAt = now; }
      if (receivedBy) { setFields.receivedBy = receivedBy; setFields.receivedAt = now; }
    }
    await db.collection('documentrequests').updateOne({ id }, { $set: setFields });
    const updated = await db.collection('documentrequests').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Document request not found.' });

    const action = status === 'Fulfilled' ? 'APPROVE' : status === 'Rejected' ? 'REJECT' : 'EDIT';
    await logActivity(db, req.session.user, action,
      `Document request ${status.toLowerCase()}: ${updated.documentType} for ${updated.institution} (requested by ${updated.requestedBy})`);

    // Targeted notification to the requester only (Auth. Personnel or, since
    // 2026-07-22, potential_partner). The 'Under Review' transition
    // (previously silent) doubles as "additional documents requested" — same
    // reasoning as the Partnership Request PATCH above: reuse the existing
    // status value rather than add a new field.
    if (['Fulfilled', 'Rejected', 'Under Review'].includes(status) && updated.requestedByEmail) {
      const requester = await db.collection('users').findOne({ email: updated.requestedByEmail });
      const link = drLinkForRole(requester && requester.role, id);
      let title, desc, icon, color;
      if (status === 'Under Review') {
        title = `Additional documents requested: ${updated.documentType} for ${updated.institution}`;
        desc = `The Administrator has requested additional documents or information for your ${updated.documentType} document request (${updated.institution}).${remark ? ' Note: ' + remark : ''}`;
        icon = 'ri-file-add-line'; color = 'warning';
      } else {
        title = `Document Request ${status}: ${updated.documentType} for ${updated.institution}`;
        icon = status === 'Fulfilled' ? 'ri-checkbox-circle-line' : 'ri-close-circle-line';
        color = status === 'Fulfilled' ? 'success' : 'danger';
        // Fulfilling a request is a status flip only — it does not itself add
        // anything to the Document Library, which requires a separate manual
        // upload through that module. The text below previously overpromised
        // this (B7, Roadmap v2 Phase C5, docs/SYSTEM_AUDIT_2026-07-16.md).
        desc = status === 'Fulfilled'
          ? `Your request for a ${updated.documentType} document (${updated.institution}) has been marked fulfilled. Check the Document Library for the uploaded file.`
          : `Your request for a ${updated.documentType} document (${updated.institution}) was not fulfilled.${remark ? ' Reason: ' + remark : ''}`;
      }
      await notifyUsers(db, [updated.requestedByEmail], { module: 'request', tag: 'Document Request', icon, color, title, desc, link });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Document Request draft/document collaboration timeline (2026-08-27,
// mirrors POST /api/requests/:id/documents above exactly). Either side can
// add a new version: Administrator/Staff (REQUEST_REVIEWER_ROLES) or the
// request's own submitter (Auth. Personnel/potential_partner). Reuses the
// exact same secure upload workflow and Document Library archive function
// as everywhere else — the file is stored once and linked back from the
// request, never duplicated. Ownership is always set to the requester's
// email (regardless of who actually uploaded it) so the existing
// GET /uploads/documents/:filename ownership check already lets the true
// requester and both reviewer roles open any version — no changes needed
// there. Every version is pushed, never replaced.
app.post('/api/document-requests/:id/documents', requireAuth, (req, res) => {
  uploadDoc.single('document')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 10MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    if (!verifyMagicBytes(req.file)) {
      return res.status(400).json({ error: 'Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.' });
    }
    const id = parseInt(req.params.id);
    const actor = req.session.user;
    try {
      const db = getDb();
      const target = await db.collection('documentrequests').findOne({ id });
      if (!target) {
        fs.unlink(req.file.path, () => { });
        return res.status(404).json({ error: 'Document request not found.' });
      }

      const isReviewer = REQUEST_REVIEWER_ROLES.includes(actor.role);
      const isOwner = target.requestedByEmail && target.requestedByEmail === actor.email;
      if (!isReviewer && !isOwner) {
        fs.unlink(req.file.path, () => { });
        return res.status(403).json({ error: 'You are not authorized to upload documents to this request.' });
      }
      if (['Fulfilled', 'Rejected'].includes(target.status)) {
        fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: `This document request has already been ${target.status.toLowerCase()} — no further documents can be added.` });
      }

      const note = (req.body.note || '').trim().slice(0, 1000);

      const { documentId, fileLink } = await archiveToDocumentLibrary(req.file.path, req.file.originalname, {
        documentType: expandDocTypeLabel(target.documentType),
        institution: target.institution,
        partner: target.institution,
        title: `${target.documentType || 'Document'} – ${target.institution} (Doc Request #${id})`
      }, {
        uploadedBy: target.requestedBy || 'Unknown',
        uploadedByEmail: target.requestedByEmail,
        requestId: id,
        requestType: 'document'
      });

      const docRecord = {
        documentId, fileLink, originalFilename: req.file.originalname,
        uploadedAt: new Date().toISOString(), uploadedBy: actor.name,
        uploadedByEmail: actor.email, uploaderRole: actor.role,
        note, fileType: req.file.mimetype, fileSize: req.file.size
      };
      const setFields = { updatedAt: new Date().toISOString() };
      // A new version puts the request back "in collaboration" — reuses the
      // existing Under Review status rather than inventing a new one.
      if (target.status === 'Pending') setFields.status = 'Under Review';
      await db.collection('documentrequests').updateOne({ id }, { $push: { supportingDocuments: docRecord }, $set: setFields });
      const updated = await db.collection('documentrequests').findOne({ id });

      await logActivity(db, actor, 'EDIT',
        `Draft document uploaded for document request: ${target.institution} (${req.file.originalname})${note ? ' — "' + note + '"' : ''}`);

      // Reviewer uploaded → notify the requester. Requester uploaded a
      // revision → notify every reviewer, same broadcast set used for a
      // brand-new submission.
      if (isReviewer && target.requestedByEmail) {
        const requester = await db.collection('users').findOne({ email: target.requestedByEmail });
        await notifyUsers(db, [target.requestedByEmail], {
          module: 'request',
          tag: 'Document Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `New draft uploaded: ${target.institution}`,
          desc: `${actor.name} uploaded "${req.file.originalname}" for your document request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: drLinkForRole(requester && requester.role, id),
          downloadLink: fileLink
        });
      } else if (isOwner) {
        const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
        await notifyUsers(db, reviewers.map(u => u.email), {
          module: 'request',
          tag: 'Document Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `Revised draft uploaded: ${target.institution}`,
          desc: `${actor.name} uploaded a revised draft "${req.file.originalname}" for their document request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: '/partnership-requests?open=dr&id=' + id
        });
      }

      res.json({ success: true, documentId, fileLink, request: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ── Document Request — printable CSPC-F-CIRL-04 form (view/print/PDF) ───────
// Administrator and Staff (full parity, 2026-08-27) may access any request;
// every other role may only access their own — same ownership rule already
// enforced on DELETE /api/document-requests/:id above.
function canAccessDocumentRequest(user, target) {
  return REQUEST_REVIEWER_ROLES.includes(user.role) || target.requestedByEmail === user.email;
}

// Shared formatting so the HTML print view and the PDFKit download show
// identical values.
function drFormFields(r) {
  const dtSource = r.submittedAt || r.date;
  const dt = dtSource ? new Date(dtSource) : null;
  const dateTimeStr = dt && !isNaN(dt)
    ? dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : (r.date || '—');
  const docTypeLabel = r.documentType ? `${expandDocTypeLabel(r.documentType)} (${r.documentType})` : '—';
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  return { dateTimeStr, docTypeLabel, fmtDate };
}

app.get('/document-requests/:id/print', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).send('Document request not found.');
    if (!canAccessDocumentRequest(req.session.user, target)) {
      return res.status(403).send('You are not authorized to view this document request.');
    }
    res.render('print/document_request_print', { r: target, ...drFormFields(target) });
  } catch (err) {
    res.status(500).send('Failed to render the document request form.');
  }
});

app.get('/api/document-requests/:id/pdf', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Document request not found.' });
    if (!canAccessDocumentRequest(req.session.user, target)) {
      return res.status(403).json({ error: 'You are not authorized to download this document request.' });
    }
    renderDocumentRequestPdf(res, target);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Administrator/Auth. Personnel are scoped to their own targeted notifications
// only, the same ownership model potential_partner already used — no role sees
// a cross-user shared feed. (Product decision 2026-07-18: previously this route
// returned every notification in the collection to Administrator/Auth.
// Personnel; see docs/SYSTEM_AUDIT_2026-07-16.md for the full rationale,
// including that system-wide lifecycle alerts, which carry no targetEmail,
// are no longer visible to anyone via this route as a result.)
const OWN_SCOPE_ROLES = ['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'];

// requireAuth (not requirePersonnel) as of 2026-08-27 — administrator/
// notifications.ejs is now also rendered for Staff (/staff/notifications,
// full-parity revision) and this is the one route that page calls to load
// its list. Safe to open to any authenticated role: the query below is
// already own-scoped by targetEmail, same protection GET
// /api/notifications/mine already relies on.
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('notifications')
      .find({ targetEmail: req.session.user.email })
      .sort({ id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every role's unread badge is scoped to their own targetEmail — there is no
// role for which a system-wide count is ever the right answer here (unlike
// OWN_SCOPE_ROLES above, which gates the unrelated Document Library feature —
// a separate concern for a different resource). Historical note: before the
// 2026-07-27 notification security pass, View-Only (now Staff) fell through
// to a global count with no targetEmail filter at all, exposing every user's
// unread total in their own badge — see docs/SYSTEM_AUDIT_2026-07-16.md.
app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const count = await db.collection('notifications').countDocuments({ targetEmail: email, unread: true });
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// Same query as GET /api/notifications above — kept as a separate route
// because potential_partner's frontend calls it by this name.
app.get('/api/notifications/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const docs = await db.collection('notifications')
      .find({ targetEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Administrator-only audit view — every notification in the collection,
// regardless of recipient, for management/auditing purposes. Deliberately a
// separate route from GET /api/notifications (which stays own-scoped even for
// Administrator, so their personal feed/badge never silently expands to
// include other users' notifications). This is also the only place system-wide
// alerts with no targetEmail (e.g. the automatic partnership lifecycle check
// below) are visible to anyone — they were never matched by any per-user query.
app.get('/api/notifications/all', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('notifications').find({}).sort({ id: -1 }).toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// requireUploader (not requireAuth) restricts this to the four internal/
// uploading roles — Administrator, Auth. Personnel, potential_partner, and
// Staff (added 2026-08-27, View-Only → Staff migration) — all four of which
// are also in OWN_SCOPE_ROLES, so the filter below always scopes to the
// caller's own uploads. (Historical: pre-2026-07-18, this route was
// reachable unscoped by an under-restricted role, exposing every
// organization's document metadata — residual S7, Roadmap v2 Phase B1, see
// docs/SYSTEM_AUDIT_2026-07-16.md.)
app.get('/api/documents', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    const filter = OWN_SCOPE_ROLES.includes(req.session.user.role)
      ? { uploadedByEmail: req.session.user.email }
      : {};
    const docs = await db.collection('documents').find(filter).toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// Documents uploaded by the current user only — used by the potential_partner
// Document Library so an external organization never sees another org's files.
app.get('/api/documents/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const docs = await db.collection('documents')
      .find({ uploadedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// Lets a user correct any OCR-suggested metadata (title/type/institution/etc.)
// on a document that was already auto-archived to the library.
app.patch('/api/documents/:id', requirePersonnel, async (req, res) => {
  try {
    const updated = await updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json({ success: true, document: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DOCUMENT LIBRARY — FOLDERS ────────────────────────────────────────────────
// Personal, per-owner folders (Administrator/Auth. Personnel/potential_partner
// — the same three roles the Document Library itself already supports via
// requireUploader). Every route below is ownership-checked against the
// session email; there is no cross-user folder visibility or management,
// mirroring the existing /api/documents ownership model exactly.
app.get('/api/document-folders/mine', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    const folders = await db.collection('documentfolders')
      .find({ ownerEmail: req.session.user.email })
      .sort({ name: 1 })
      .toArray();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/document-folders', requireUploader, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required.' });
  try {
    const db = getDb();
    const last = await db.collection('documentfolders').find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const folder = {
      id, name, ownerEmail: req.session.user.email, archived: false,
      createdAt: new Date().toISOString()
    };
    await db.collection('documentfolders').insertOne(folder);
    res.json({ success: true, folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename and/or archive/unarchive a folder — either field may be sent alone.
app.patch('/api/document-folders/:id', requireUploader, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const folder = await db.collection('documentfolders').findOne({ id });
    if (!folder) return res.status(404).json({ error: 'Folder not found.' });
    if (folder.ownerEmail !== req.session.user.email) {
      return res.status(403).json({ error: 'You can only manage your own folders.' });
    }
    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Folder name cannot be empty.' });
      updates.name = name;
    }
    if (req.body.archived !== undefined) updates.archived = !!req.body.archived;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
    await db.collection('documentfolders').updateOne({ id }, { $set: updates });
    res.json({ success: true, folder: await db.collection('documentfolders').findOne({ id }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move a document into (or out of, via folderId: null) a folder, and/or
// archive/unarchive it — the two actions the Document Library needs beyond
// the existing OCR-metadata-correction route above, kept separate from it so
// that route's Administrator/Auth. Personnel-only RBAC is never touched.
app.patch('/api/documents/:id/organize', requireUploader, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ id });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.uploadedByEmail !== req.session.user.email) {
      return res.status(403).json({ error: 'You can only organize your own documents.' });
    }
    const updates = {};
    if (req.body.folderId !== undefined) {
      updates.folderId = req.body.folderId === null ? null : parseInt(req.body.folderId);
    }
    if (req.body.archived !== undefined) updates.archived = !!req.body.archived;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
    await db.collection('documents').updateOne({ id }, { $set: updates });
    res.json({ success: true, document: await db.collection('documents').findOne({ id }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PARTNERSHIPS (Registry) ───────────────────────────────────────────────────
// Canonical schema. `inst` is the ONLY accepted institution-name field — legacy
// code used to also fall back to `institution`/`partner`, but live data is 100%
// `inst` (confirmed against the full collection), so those aliases are dropped
// rather than perpetuated. Every field the Add/Edit forms actually send is
// listed here; anything else in the request body is rejected outright rather
// than silently written to a schemaless document.
const PARTNERSHIP_FIELDS = {
  inst: 'string', country: 'string', region: 'string', type: 'string', nature: 'string',
  cat: 'string', unit: 'string', coordinator: 'string', partnerEmail: 'string', docLink: 'string',
  start: 'string', end: 'string', status: 'string', remarks: 'string',
  startYear: 'number', endYear: 'number'
};
const REQUIRED_PARTNERSHIP_FIELDS = ['inst', 'type', 'unit', 'start', 'end'];
const VALID_PARTNERSHIP_TYPES = ['MOA', 'MOU'];
const VALID_PARTNERSHIP_CATEGORIES = ['International', 'Local'];
const VALID_PARTNERSHIP_STATUSES = ['Active', 'Expiring Soon', 'Expired'];

/**
 * Builds a MongoDB-safe field set from a request body: unknown keys must
 * already have been rejected by the caller (see the `unknown fields` checks
 * below) before this runs. Every accepted field is checked against its
 * declared type — a bracket/dot-notation-injected object or array can never
 * pass the `typeof` check, so it's simply reported as a type error rather
 * than ever reaching `$set`/`insertOne`.
 */
function sanitizePartnershipFields(body, { requireCore }) {
  const fields = {};
  const errors = [];
  for (const [field, type] of Object.entries(PARTNERSHIP_FIELDS)) {
    const value = body[field];
    if (value === undefined) continue;
    if (type === 'string') {
      if (typeof value !== 'string') { errors.push(`${field} must be a string.`); continue; }
      const trimmed = value.trim();
      if (field === 'inst' && !trimmed) { errors.push('inst must not be empty.'); continue; }
      fields[field] = trimmed;
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${field} must be a number.`); continue; }
      fields[field] = value;
    }
  }
  if (fields.type !== undefined && !VALID_PARTNERSHIP_TYPES.includes(fields.type)) {
    errors.push('type must be one of: ' + VALID_PARTNERSHIP_TYPES.join(', '));
  }
  if (fields.cat !== undefined && !VALID_PARTNERSHIP_CATEGORIES.includes(fields.cat)) {
    errors.push('cat must be one of: ' + VALID_PARTNERSHIP_CATEGORIES.join(', '));
  }
  if (fields.status !== undefined && !VALID_PARTNERSHIP_STATUSES.includes(fields.status)) {
    errors.push('status must be one of: ' + VALID_PARTNERSHIP_STATUSES.join(', '));
  }
  if (requireCore) {
    for (const field of REQUIRED_PARTNERSHIP_FIELDS) {
      if (!fields[field]) errors.push(`${field} is required.`);
    }
  }
  return { fields, errors };
}

// Registry CRUD — Administrator and Staff share full authority (2026-08-27
// full-parity revision); every other role stays read-only or unauthenticated.
app.post('/api/partnerships', requireStaffAccess, async (req, res) => {
  try {
    const unknown = Object.keys(req.body).filter(k => !(k in PARTNERSHIP_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    const { fields, errors } = sanitizePartnershipFields(req.body, { requireCore: true });
    if (errors.length) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    const db = getDb();
    const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? last[0].id + 1 : 1;
    const entry = { id: nextId, ...fields };
    await db.collection('partnerships').insertOne(entry);
    await logActivity(db, req.session.user, 'ADD', `Partnership added: ${entry.inst || 'Record #' + nextId} (${entry.type || ''})`);
    res.json({ success: true, partnership: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/partnerships/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const unknown = Object.keys(req.body).filter(k => !(k in PARTNERSHIP_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    const { fields, errors } = sanitizePartnershipFields(req.body, { requireCore: false });
    if (errors.length) {
      return res.status(400).json({ error: errors.join(' ') });
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const db = getDb();
    await db.collection('partnerships').updateOne({ id }, { $set: fields });
    const updated = await db.collection('partnerships').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    await logActivity(db, req.session.user, 'EDIT', `Partnership updated: ${updated.inst || 'Record #' + id} (${updated.type || ''})`);
    res.json({ success: true, partnership: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/partnerships/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('partnerships').findOne({ id });
    await db.collection('partnerships').deleteOne({ id });
    await logActivity(db, req.session.user, 'DELETE', `Partnership deleted: ${target ? (target.inst || 'Record #' + id) : 'Record #' + id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PARTNERSHIP STATS (for Reports DSS) ──────────────────────────────────────
app.get('/api/partnerships/stats', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const all = await db.collection('partnerships').find({}).toArray();
    // Recompute status live from each record's own end date — the same
    // authoritative computeStatusFromEnd() the Reports & Analytics engine
    // uses — rather than trusting the stored `status` field, which is only
    // refreshed by the hourly lifecycle job and can be stale by up to an
    // hour. Without this, the Reports page's own quick-export cards (Active
    // Partnerships List, Expiring Soon List, etc.) could show a live count
    // here that disagreed with what clicking that same card's PDF/Excel
    // button actually exports.
    all.forEach(p => {
      const calcStatus = computeStatusFromEnd(p.end);
      if (calcStatus) p.status = calcStatus;
    });
    const total = all.length;
    const active = all.filter(p => p.status === 'Active').length;
    const expiring = all.filter(p => p.status === 'Expiring Soon').length;
    const expired = all.filter(p => p.status === 'Expired').length;
    const byType = {};
    const byRegion = {};
    const byUnit = {};
    const byInstitutionCounts = {};
    all.forEach(p => {
      byType[p.type] = (byType[p.type] || 0) + 1;
      byRegion[p.region] = (byRegion[p.region] || 0) + 1;
      byUnit[p.unit] = (byUnit[p.unit] || 0) + 1;
      if (p.inst) byInstitutionCounts[p.inst] = (byInstitutionCounts[p.inst] || 0) + 1;
    });
    // Top 8 institutions by count — an institution-by-institution breakdown can
    // have far more distinct values than the small, fixed set of CSPC units, so
    // this caps the chart the same way "Top Partner Countries" already does.
    const byInstitution = Object.fromEntries(
      Object.entries(byInstitutionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
    );
    res.json({ total, active, expiring, expired, byType, byRegion, byUnit, byInstitution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REPORT EXPORTS (real PDF/Excel generation) ────────────────────────────────

function safeFilename(title) {
  return title.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'report';
}

// Only these five fields are ever filterable, and only as plain equality
// matches on a plain string. Express's query parser turns bracket/dot-notation
// input (e.g. ?status[$ne]=Approved, ?cat[$in][]=A) into a nested object or
// array rather than a string, so requiring `typeof value === 'string'` rejects
// every MongoDB-operator-injection shape in one check — there's no pattern to
// blacklist, because anything that isn't a plain string for an allowlisted key
// is simply never looked at. Unknown field names (not in this list) are
// likewise never read from `query` at all, injection-shaped or not.
const PARTNERSHIP_FILTER_FIELDS = ['status', 'type', 'cat', 'region', 'unit'];

function buildPartnershipFilter(query) {
  const filter = {};
  for (const field of PARTNERSHIP_FILTER_FIELDS) {
    const value = query[field];
    if (typeof value === 'string' && value.length > 0) {
      filter[field] = value;
    }
  }
  return filter;
}

/**
 * `start`/`end` are stored as formatted display strings (e.g. "Apr 12,
 * 2026"), not real Dates, so date-range filtering happens in memory after
 * the DB query — fine at this data scale, and avoids reformatting the whole
 * collection.
 *
 * This used to filter by `end` alone, which meant almost any realistic
 * Date From/Date To window returned ZERO records: partnerships here run
 * 3-6+ years, so a window like "2021" excluded a partnership that started
 * in Apr 2021 and runs to 2026, even though it was clearly active (and
 * newly signed) throughout that window — confirmed live against the real
 * database. Date From/Date To is a generic "partnerships active/relevant
 * during this period" filter, not an "ends within this period" filter (the
 * dedicated Report Types and the Status filter already cover expiry-based
 * questions) — so this now uses standard date-RANGE OVERLAP: a partnership
 * matches whenever its own [start, end] period overlaps the requested
 * window at all (start <= dateTo AND end >= dateFrom), not only when one
 * single field happens to land inside it.
 */
function filterByDateRange(docs, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return docs;
  // `dateFrom`/`dateTo` come from an <input type="date"> as bare "YYYY-MM-DD"
  // strings. A bare ISO date-only string is parsed as UTC midnight per the
  // ECMAScript spec, but appending a time-of-day (as `to` already did below)
  // makes it a date-TIME form, parsed as LOCAL midnight instead — and a
  // partnership's own start/end (e.g. "Apr 12, 2026") is a non-ISO format,
  // always parsed as LOCAL time too. Leaving `from` as a bare date therefore
  // compared a UTC instant against local-time instants, silently excluding
  // any record dated exactly on the `dateFrom` boundary day in a timezone
  // ahead of UTC (confirmed live in Asia/Manila, UTC+8). Appending
  // 'T00:00:00' to `from` too makes both boundaries — and the record dates
  // being compared — consistently local-time.
  const from = dateFrom ? new Date(dateFrom + 'T00:00:00') : null;
  const to = dateTo ? new Date(dateTo + 'T23:59:59') : null;
  return docs.filter(d => {
    const start = new Date(d.start);
    const end = new Date(d.end);
    if (isNaN(start) || isNaN(end)) return false;
    if (from && end < from) return false;
    if (to && start > to) return false;
    return true;
  });
}

/**
 * Streams a simple paginated table as a landscape PDF — shared by every
 * PDF export route so pagination/header drawing isn't duplicated per report.
 */
function renderTablePdf(res, { title, filename, subtitle, columns, rows }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  // A mid-stream failure (PDFKit internal error, or the client disconnecting
  // before the download finishes) fires as an 'error' event on these streams,
  // not a thrown exception — uncaught, that crashes the process. Closes S14
  // (Roadmap v2 Phase G5, docs/SYSTEM_AUDIT_2026-07-16.md).
  doc.on('error', (err) => {
    console.error('❌ PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => {
    console.error('❌ PDF response stream error:', err);
  });
  // A client disconnecting mid-download fires 'close' on the response, not
  // 'error' — confirmed empirically during this fix's own verification (a
  // throttled-then-aborted curl download produced no 'error' event, only
  // 'close'). writableEnded is false only when the stream was cut off before
  // res.end() was reached normally.
  res.on('close', () => {
    if (!res.writableEnded) console.error('❌ PDF download interrupted (client disconnected before completion)');
  });
  doc.pipe(res);

  // ── Full CSPC-CIRL Letterhead (matching the official template design) ──
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath = path.join(__dirname, 'public', 'images', 'QS.png');
  const LOGO_SIZE = 50;
  const headerTop = doc.page.margins.top;
  // Left: CSPC logo only
  try { doc.image(cspcLogoPath, left, headerTop, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
  // Right: PQA, TUV, QS accreditation logos
  const rightLogoSize = 50;
  const rightLogoX = right - (rightLogoSize * 3 + 8);
  try { doc.image(pqaLogoPath, rightLogoX, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath, rightLogoX + rightLogoSize + 4, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath, rightLogoX + (rightLogoSize + 4) * 2, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  // Center text block
  const centerX = left + LOGO_SIZE + 8;
  const centerW = rightLogoX - centerX - 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
    .text('CAMARINES SUR POLYTECHNIC COLLEGES', centerX, headerTop, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5)
    .text('Nabua, Camarines Sur', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8)
    .text('Telephone No. (054) 288-4421 to 23 local 206', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
    .text('cspcinternational@cspc.edu.ph', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', centerX, doc.y, { width: centerW, align: 'center' });
  doc.y = Math.max(doc.y, headerTop + LOGO_SIZE) + 6;
  // Blue underline separator
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#000').text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#666')
    .text(subtitle, { align: 'center' });
  doc.moveDown(0.8);
  doc.fillColor('#000');

  const startX = doc.page.margins.left;
  let y = doc.y;

  function drawHeader() {
    let x = startX;
    doc.font('Helvetica-Bold').fontSize(9);
    columns.forEach(col => {
      doc.text(col.label, x, y, { width: col.width, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    y += 16;
    doc.moveTo(startX, y - 4).lineTo(x, y - 4).strokeColor('#cccccc').stroke();
  }

  drawHeader();
  doc.font('Helvetica').fontSize(8.5);

  if (!rows.length) {
    doc.text('No records match this report.', startX, y + 4);
  }

  rows.forEach(row => {
    if (y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
      doc.font('Helvetica').fontSize(8.5);
    }
    let x = startX;
    columns.forEach(col => {
      const val = String(row[col.key] == null || row[col.key] === '' ? '—' : row[col.key]);
      doc.text(val, x, y, { width: col.width - 5, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    y += 16;
  });

  doc.end();
}

/**
 * Streams the official CSPC-F-CIRL-04 "Documents Request Form" as a portrait
 * PDF, mirroring views/print/document_request_print.ejs field-for-field so
 * the browser print view and the downloaded PDF never drift apart.
 */
function renderDocumentRequestPdf(res, r) {
  const filename = `Document_Request_${r.id}`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.on('error', (err) => {
    console.error('❌ Document Request PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Document Request PDF response stream error:', err));
  doc.pipe(res);

  const { dateTimeStr, docTypeLabel, fmtDate } = drFormFields(r);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const cspcLogoPath2 = path.join(__dirname, 'public', 'images', 'cspc.PNG');

  // ── Full CSPC Letterhead ──
  const DR_LOGO_SIZE = 50;
  let headerTop = doc.y;
  // Left: CSPC logo only
  try { doc.image(cspcLogoPath2, left, headerTop, { width: DR_LOGO_SIZE, height: DR_LOGO_SIZE }); } catch (e) { /* optional */ }
  // Right: PQA, TUV, QS accreditation logos
  const drRightLogoSize = 30;
  const drRightLogoX = right - (drRightLogoSize * 3 + 8);
  try { doc.image(pqaLogoPath2, drRightLogoX, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath2, drRightLogoX + drRightLogoSize + 4, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath2, drRightLogoX + (drRightLogoSize + 4) * 2, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#0a58ca').text('CSPC-F-CIRL-04', right - 100, headerTop, { width: 100, align: 'right' });
  // Center text block
  const drCenterX = left + DR_LOGO_SIZE + 8;
  const drCenterW = drRightLogoX - drCenterX - 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
    .text('CAMARINES SUR POLYTECHNIC COLLEGES', drCenterX, headerTop, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5)
    .text('Nabua, Camarines Sur', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8)
    .text('Telephone No. (054) 288-4421 to 23 local 206', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
    .text('cspcinternational@cspc.edu.ph', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.fillColor('#000');

  doc.y = Math.max(doc.y, headerTop + DR_LOGO_SIZE) + 8;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(13).text('DOCUMENTS REQUEST FORM', left, doc.y, { width: contentWidth, align: 'center' });
  doc.moveDown(0.8);

  // ── Form table ──
  const labelW = 190;
  const valueW = contentWidth - labelW;
  let y = doc.y;

  function row(label, renderValue, height) {
    const rowTop = y;
    doc.rect(left, rowTop, labelW, height).stroke();
    doc.rect(left + labelW, rowTop, valueW, height).stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).text(label, left + 6, rowTop + 6, { width: labelW - 12 });
    doc.font('Helvetica').fontSize(9.5);
    renderValue(left + labelW + 8, rowTop + 6, valueW - 16);
    y = rowTop + height;
  }

  const text = (v) => (x, top, w) => doc.text(String(v == null || v === '' ? '—' : v), x, top, { width: w });

  row('Name of Requestor', text(r.requestedBy), 26);
  row('Office / College / Institution', text(r.institution), 26);
  row('Date / Time Submitted', text(dateTimeStr), 26);
  row('Contact No.', text(r.contactNumber), 26);
  row('Document/s to be Requested', text(docTypeLabel), 40);
  row('Purpose', text(r.notes), 48);
  row('Document Form', (x, top) => {
    const printedChecked = r.documentForm === 'Printed Copy';
    const digitalChecked = r.documentForm === 'Digital Copy';
    doc.rect(x, top + 1, 10, 10).stroke();
    if (printedChecked) doc.fontSize(8).text('X', x + 1.5, top + 1.5);
    doc.fontSize(9.5).text('Printed Copy', x + 16, top);
    const digitalX = x + 130;
    doc.rect(digitalX, top + 1, 10, 10).stroke();
    if (digitalChecked) doc.fontSize(8).text('X', digitalX + 1.5, top + 1.5);
    doc.fontSize(9.5).text('Digital Copy', digitalX + 16, top);
  }, 26);
  row('Email Address', text(r.requestedByEmail), 26);

  doc.y = y + 30;

  // ── Signature block ──
  const colW = contentWidth / 3;
  const sigCols = [
    { label: 'Approved By:', name: r.decidedBy, date: fmtDate(r.updatedAt) },
    { label: 'Released By:', name: r.releasedBy, date: fmtDate(r.releasedAt) },
    { label: 'Received By:', name: r.receivedBy, date: fmtDate(r.receivedAt) }
  ];
  const sigTop = doc.y;
  sigCols.forEach((col, i) => {
    const x = left + i * colW;
    doc.font('Helvetica').fontSize(9).text(col.label, x, sigTop, { width: colW - 20 });
    doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop + 34, { width: colW - 20, align: 'center' });
    doc.moveTo(x, sigTop + 50).lineTo(x + colW - 20, sigTop + 50).stroke();
    doc.font('Helvetica').fontSize(8).text('DATE: ' + (col.date || ''), x, sigTop + 54, { width: colW - 20, align: 'center' });
  });

  // ── Footer ──
  const footerY = doc.page.height - doc.page.margins.bottom - 30;
  doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(2).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.font('Helvetica').fontSize(8).fillColor('#000')
    .text('Effectivity Date: February 2023', left, footerY + 6, { width: contentWidth / 3 })
    .text('Rev. 1', left + contentWidth / 3, footerY + 6, { width: contentWidth / 3, align: 'center' })
    .text('Page 1 of 1', left + (2 * contentWidth) / 3, footerY + 6, { width: contentWidth / 3, align: 'right' });

  doc.end();
}

const PARTNERSHIP_COLUMNS = [
  { key: 'inst', label: 'Institution', width: 150 },
  { key: 'country', label: 'Country', width: 85 },
  { key: 'type', label: 'Type', width: 40 },
  { key: 'cat', label: 'Category', width: 75 },
  { key: 'unit', label: 'Unit', width: 45 },
  { key: 'start', label: 'Start', width: 70 },
  { key: 'end', label: 'End', width: 70 },
  { key: 'status', label: 'Status', width: 80 }
];

// Columns actually printed in the official-style report — Category is dropped
// here because records are already grouped by Category (see groupPartnershipDocs
// below), so repeating it in every row would be redundant.
// Primary Custom Report PDF/Excel template — column structure mirrors the
// official CIRL "List of Active International Partners" reference document
// (No. | Name of Schools | Address/Country | Date of Signing | Date of
// Expiration) exactly; only the structure is templated — every value below
// is read live from the partnerships collection, nothing is hardcoded.
const PARTNERSHIP_REPORT_COLUMNS = [
  { key: 'inst', label: 'Name of Schools/Institutions', width: 180 },
  { key: 'country', label: 'Address/Country', width: 170 },
  { key: 'start', label: 'Date of Signing', width: 70 },
  { key: 'end', label: 'Date of Expiration', width: 75 }
];
const PARTNERSHIP_REPORT_NO_COL_WIDTH = 28;

/**
 * Groups partnership docs by Category (International/Local/etc.) for the
 * report's section headers — but only when the export actually spans more
 * than one category. A `cat` filter already narrows the export to a single
 * category, so grouping in that case would just produce one redundant
 * section header; skip it and print a flat list instead.
 */
function groupPartnershipDocs(docs) {
  const cats = [...new Set(docs.map(d => d.cat || 'Uncategorized'))];
  if (cats.length <= 1) return [{ label: null, docs }];
  const order = ['International', 'Local'];
  cats.sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return cats.map(cat => ({ label: cat, docs: docs.filter(d => (d.cat || 'Uncategorized') === cat) }));
}

/**
 * Renders the official-style "Partnership Registry Report" PDF: CIRL
 * letterhead, report period/generation meta, a summary strip, records grouped
 * by Category with shaded group headers and alternating row bands, repeating
 * column headers across pages (buffered so "Page X of Y" can be written once
 * the true page count is known), and a Prepared/Reviewed/Approved By
 * signature block after the last row.
 */
function renderPartnershipReportPdf(res, { title, docs, periodLabel, generatedBy, customReportData }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(title)}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
  doc.on('error', (err) => {
    console.error('❌ Partnership report PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Partnership report PDF response stream error:', err));
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const now = new Date();
  const generatedStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Logo paths for the full letterhead
  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath = path.join(__dirname, 'public', 'images', 'QS.png');

  function drawLetterhead() {
    const top = doc.page.margins.top;
    doc.y = top;
    const LOGO_SIZE = 50;
    // Left: CSPC logo only
    try { doc.image(cspcLogoPath, left, top, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
    // Right: PQA, TUV, QS accreditation logos
    const rightLogoSize = 30;
    const rightLogoX = right - (rightLogoSize * 3 + 8);
    try { doc.image(pqaLogoPath, rightLogoX, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    try { doc.image(tuvLogoPath, rightLogoX + rightLogoSize + 4, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    try { doc.image(qsLogoPath, rightLogoX + (rightLogoSize + 4) * 2, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    // Center text block
    const centerX = left + LOGO_SIZE + 8;
    const centerW = rightLogoX - centerX - 8;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
      .text('CAMARINES SUR POLYTECHNIC COLLEGES', centerX, top, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8.5)
      .text('Nabua, Camarines Sur', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8)
      .text('Telephone No. (054) 288-4421 to 23 local 206', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
      .text('cspcinternational@cspc.edu.ph', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
      .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', centerX, doc.y, { width: centerW, align: 'center' });
    doc.y = Math.max(doc.y, top + LOGO_SIZE) + 6;
    // Blue separator line
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
    doc.lineWidth(1).strokeColor('#000');
    doc.moveDown(0.7);

    doc.font('Helvetica-Bold').fontSize(15).text(title.toUpperCase(), left, doc.y, { width: contentWidth, align: 'center' });
    doc.moveDown(0.4);

    doc.font('Helvetica').fontSize(9).fillColor('#444')
      .text(periodLabel, left, doc.y, { width: contentWidth, align: 'center' })
      .text(`Generated ${generatedStr} by ${generatedBy}`, left, doc.y, { width: contentWidth, align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(0.8);
  }

  const colStartX = left + PARTNERSHIP_REPORT_NO_COL_WIDTH;
  function drawColumnHeader() {
    const y = doc.y;
    doc.rect(left, y, contentWidth, 18).fillAndStroke('#0a58ca', '#0a58ca');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
    doc.text('No.', left + 4, y + 5, { width: PARTNERSHIP_REPORT_NO_COL_WIDTH - 8, lineBreak: false });
    let x = colStartX;
    PARTNERSHIP_REPORT_COLUMNS.forEach(col => {
      doc.text(col.label, x + 4, y + 5, { width: col.width - 8, lineBreak: false });
      x += col.width;
    });
    doc.fillColor('#000');
    doc.y = y + 18;
  }

  function drawGroupHeader(label, count) {
    const y = doc.y;
    doc.rect(left, y, contentWidth, 16).fillAndStroke('#dbe6fb', '#c9d6ea');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0a3d91')
      .text(`${label} (${count})`, left + 6, y + 4, { width: contentWidth - 12 });
    doc.fillColor('#000');
    doc.y = y + 16;
  }

  function ensureSpace(neededHeight) {
    if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      drawColumnHeader();
    }
  }

  drawLetterhead();

  const groups = groupPartnershipDocs(docs);
  drawColumnHeader();

  doc.font('Helvetica').fontSize(8);
  let rowIndex = 0;
  groups.forEach(group => {
    if (group.label) {
      ensureSpace(16 + 16);
      drawGroupHeader(group.label, group.docs.length);
    }
    if (!group.docs.length) {
      ensureSpace(16);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#888')
        .text('No records in this category.', left + 6, doc.y + 3, { width: contentWidth - 12 });
      doc.fillColor('#000').font('Helvetica').fontSize(8);
      doc.y += 16;
      return;
    }
    group.docs.forEach(p => {
      ensureSpace(16);
      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(left, y, contentWidth, 16).fillAndStroke('#f5f7fa', '#f5f7fa');
      doc.strokeColor('#e3e6eb');
      doc.rect(left, y, contentWidth, 16).stroke();
      doc.fillColor('#000').text(String(rowIndex + 1), left + 4, y + 4, { width: PARTNERSHIP_REPORT_NO_COL_WIDTH - 8, lineBreak: false });
      let x = colStartX;
      PARTNERSHIP_REPORT_COLUMNS.forEach(col => {
        const val = String(p[col.key] == null || p[col.key] === '' ? '—' : p[col.key]);
        doc.fillColor('#000').text(val, x + 4, y + 4, { width: col.width - 8, lineBreak: false, ellipsis: true });
        x += col.width;
      });
      doc.strokeColor('#000');
      doc.y = y + 16;
      rowIndex++;
    });
  });

  // ── Signature block — matches the reference document's two-column
  // "Prepared by / Noted by" footer. Prepared by is dynamically the
  // exporting Administrator; Noted by is left blank for a wet signature. ──
  ensureSpace(90);
  doc.moveDown(1.2);
  const sigColW = contentWidth / 2;
  const sigTop = doc.y;
  [
    { label: 'Prepared by:', name: generatedBy },
    { label: 'Noted by:', name: '' }
  ].forEach((col, i) => {
    const x = left + i * sigColW;
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(col.label, x, sigTop, { width: sigColW - 20 });
    doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop + 32, { width: sigColW - 20, align: 'center' });
    doc.moveTo(x, sigTop + 48).lineTo(x + sigColW - 20, sigTop + 48).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#666')
      .text('Name / Signature over Printed Name', x, sigTop + 51, { width: sigColW - 20, align: 'center' });
  });
  doc.fillColor('#000');

  // ── Page numbering — written after all content so the true total is known.
  // Writing below the printable area normally makes pdfkit auto-insert a new
  // page mid-write (caught live: it was silently doubling the page count) —
  // the standard workaround is to zero the bottom margin just for this write
  // so text() doesn't treat the footer position as an overflow. ──
  const range = doc.bufferedPageRange();
  const savedBottomMargin = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - savedBottomMargin + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888')
      .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottomMargin;
  }

  doc.end();
}

/**
 * Custom Report & Comparison Data Engine (Administrator DSS Analytics)
 */
// Shared by the report/comparison engines below whenever a free-text filter
// (institution name) needs to become a safe, case-insensitive partial match
// instead of a literal regex injection.
function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Country is a free-text field (unlike Region/Unit/Category/Agreement Type,
// which are fixed dropdowns already matching the DB's exact casing) — real
// data in this collection is entered with inconsistent casing, so a plain
// `filter.country = country` exact-string match silently returned zero
// results whenever the admin's typed casing didn't byte-for-byte match what
// was stored (e.g. "japan" vs "Japan"). This still requires the WHOLE field
// to match (unlike Institution's intentional partial search) — only the
// casing requirement is relaxed. Shared by both report engines so Country
// matching can never diverge between the Custom Report Builder and Compare.
function buildExactCaseInsensitiveMatch(value) {
  return { $regex: '^' + escapeRegexLiteral(value) + '$', $options: 'i' };
}

// The Report Builder's Report Type dropdown (e.g. "Active Partnerships")
// implies a status even though it is a separate control from the Status
// filter — used by BOTH computeCustomReportData (so Preview/PDF/Excel never
// silently include a status the Report Type didn't ask for) AND
// computeComparisonReport (so a comparison's "original report" — Group A —
// stays the exact same record set the admin was just looking at in Preview,
// rather than silently reverting to every status once Compare is opened).
const REPORT_TYPE_IMPLIED_STATUS = {
  'Active Partnerships': 'Active',
  'Active List': 'Active',
  'Inactive Partnerships': 'Inactive',
  'Expired Partnerships': 'Expired',
  'Expired List': 'Expired',
  'Expiring Soon': 'Expiring Soon'
};

async function computeCustomReportData(db, query, user) {
  const reportType = query.reportType || query.type || 'Summary';
  const cat = query.cat || '';
  const dateFrom = query.dateFrom || '';
  const dateTo = query.dateTo || '';
  const unit = query.unit || '';
  const agtype = query.agtype || query.typeFilter || query.type || '';
  const region = query.region || '';
  const statusFilter = query.status || '';
  const nature = query.nature || '';
  const country = query.country || '';
  const inst = query.inst || '';
  const compareByInput = query.compareBy || 'Country';

  // Build DB filter
  const filter = {};
  if (cat) filter.cat = cat;
  if (unit) filter.unit = unit;
  if (agtype && ['MOA', 'MOU'].includes(agtype)) filter.type = agtype;
  if (region) filter.region = region;
  if (country) filter.country = buildExactCaseInsensitiveMatch(country);
  if (inst) filter.inst = { $regex: escapeRegexLiteral(inst), $options: 'i' };
  if (nature) filter.nature = nature;

  let docs = await db.collection('partnerships').find(filter).sort({ id: 1 }).toArray();

  // Date range filter
  if (dateFrom || dateTo) {
    docs = filterByDateRange(docs, dateFrom, dateTo);
  }

  // Recompute & standardize status for each doc
  docs.forEach(p => {
    const calcStatus = computeStatusFromEnd(p.end);
    if (calcStatus) p.status = calcStatus;
    p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
  });

  // Explicit Status filter always wins; otherwise fall back to whatever
  // status the Report Type implies (see REPORT_TYPE_IMPLIED_STATUS above).
  const effectiveStatusFilter = statusFilter || REPORT_TYPE_IMPLIED_STATUS[reportType] || '';

  // Apply Status filter if specified (explicitly, or implied by Report Type)
  if (effectiveStatusFilter) {
    docs = docs.filter(p => {
      if (effectiveStatusFilter === 'Active') return p.status === 'Active';
      if (effectiveStatusFilter === 'Expiring Soon') return p.status === 'Expiring Soon';
      if (effectiveStatusFilter === 'Expired') return p.status === 'Expired';
      if (effectiveStatusFilter === 'Inactive') return p.status === 'Expired' || p.status === 'Inactive' || p.status === 'Expiring Soon';
      return p.status === effectiveStatusFilter;
    });
  }

  // Determine comparison mode and compareBy key
  const isComparison = [
    'Active vs Inactive', 'Active vs Expired', 'Active vs Expiring Soon',
    'Renewed vs Non-Renewed', 'Custom Comparison', 'By Institution',
    'By College / Unit', 'By Country', 'By Region', 'By Agreement Type', 'By Nature of Partnership'
  ].includes(reportType);

  let compareBy = compareByInput;
  if (reportType === 'By Institution') compareBy = 'Institution';
  else if (reportType === 'By College / Unit') compareBy = 'College / Unit';
  else if (reportType === 'By Country') compareBy = 'Country';
  else if (reportType === 'By Region') compareBy = 'Region';
  else if (reportType === 'By Agreement Type') compareBy = 'Agreement Type';
  else if (reportType === 'By Nature of Partnership') compareBy = 'Nature of Partnership';

  // Determine metric groups for comparison
  let metricGroups = ['Active', 'Inactive'];
  if (reportType === 'Active vs Expired') metricGroups = ['Active', 'Expired'];
  else if (reportType === 'Active vs Expiring Soon') metricGroups = ['Active', 'Expiring Soon'];
  else if (reportType === 'Renewed vs Non-Renewed') metricGroups = ['Renewed', 'Non-Renewed'];
  else if (reportType === 'Custom Comparison') {
    let custom = query.customStatuses;
    if (typeof custom === 'string') custom = custom.split(',').map(s => s.trim()).filter(Boolean);
    if (Array.isArray(custom) && custom.length > 0) metricGroups = custom;
    else metricGroups = ['Active', 'Inactive', 'Expired'];
  }

  function getGroupVal(p, key) {
    if (key === 'Country') return p.country || 'Unspecified';
    if (key === 'Institution') return p.inst || 'Unspecified';
    if (key === 'College / Unit') return p.unit || 'Unspecified';
    if (key === 'Region') return p.region || 'Unspecified';
    if (key === 'Agreement Type') return p.type || 'Unspecified';
    if (key === 'Nature of Partnership') return p.nature || 'Unspecified';
    if (key === 'Category') return p.cat || 'Unspecified';
    if (key === 'Year') return p.startYear ? String(p.startYear) : (p.start ? String(new Date(p.start).getFullYear()) : 'Unspecified');
    return p.country || 'Unspecified';
  }

  const groupsMap = {};
  docs.forEach(p => {
    const gVal = getGroupVal(p, compareBy);
    if (!groupsMap[gVal]) {
      groupsMap[gVal] = { group: gVal, Total: 0 };
      metricGroups.forEach(m => groupsMap[gVal][m] = 0);
    }
    groupsMap[gVal].Total += 1;

    metricGroups.forEach(m => {
      let match = false;
      if (m === 'Active') match = (p.status === 'Active');
      else if (m === 'Inactive') match = (p.status === 'Expired' || p.status === 'Inactive');
      else if (m === 'Expired') match = (p.status === 'Expired');
      else if (m === 'Expiring Soon') match = (p.status === 'Expiring Soon');
      else if (m === 'Renewed') match = p.isRenewed;
      else if (m === 'Non-Renewed') match = !p.isRenewed;
      else match = (p.status === m);
      if (match) groupsMap[gVal][m] += 1;
    });
  });

  const comparisonData = Object.values(groupsMap).sort((a, b) => b.Total - a.Total);
  const primaryMetric = metricGroups[0];
  comparisonData.forEach(row => {
    const cnt = row[primaryMetric] || 0;
    const pct = row.Total > 0 ? ((cnt / row.Total) * 100).toFixed(1) : '0.0';
    row[`${primaryMetric} %`] = `${pct}%`;
  });

  const totalActive = docs.filter(p => p.status === 'Active').length;
  const totalExpiring = docs.filter(p => p.status === 'Expiring Soon').length;
  const totalExpired = docs.filter(p => p.status === 'Expired').length;
  const totalInactive = docs.filter(p => p.status === 'Expired' || p.status === 'Inactive').length;

  const now = new Date();
  const generatedDate = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const title = query.title || `${reportType} Report`;

  return {
    title,
    generatedDate,
    generatedBy: (user && user.name) || 'Administrator',
    totalRecords: docs.length,
    isComparison,
    compareBy,
    metricGroups,
    primaryMetric,
    metrics: [compareBy, ...metricGroups, 'Total', `${primaryMetric} %`],
    comparisonData,
    summary: {
      activeCount: totalActive,
      expiringSoonCount: totalExpiring,
      expiredCount: totalExpired,
      inactiveCount: totalInactive,
      totalCount: docs.length
    },
    // College/Unit, Region, Nature of Partnership and Institution are
    // deliberately omitted here — they are no longer fields the Custom
    // Report Builder exposes, so surfacing them in this report's own
    // metadata (Preview badges / Excel "Applied Filters" sheet) would only
    // ever show a permanent, meaningless "All". The underlying MongoDB
    // filter capability for unit/region/nature/inst above is untouched and
    // still used when those query params are supplied directly (e.g. by
    // the Compare workflow's separate engine).
    filters: {
      reportType,
      category: cat || 'All',
      dateFrom: dateFrom || 'Earliest',
      dateTo: dateTo || 'Present',
      agreementType: agtype || 'All',
      country: country || 'All',
      status: effectiveStatusFilter || 'All',
      compareBy
    },
    records: docs
  };
}

// ── Custom Report Preview API (Administrator-only) ──────────────────────────
app.get('/api/reports/custom/preview', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const result = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Generated Custom Report preview: ${result.title}`);
    res.json(result);
  } catch (err) {
    console.error('❌ Custom Report Preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/partnerships/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const reportData = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Custom Report PDF: ${reportData.title}`);

    const periodLabel = (req.query.dateFrom || req.query.dateTo)
      ? `Report Period: ${req.query.dateFrom || 'earliest'} to ${req.query.dateTo || 'present'}`
      : 'Report Period: All Records';
    renderPartnershipReportPdf(res, {
      title: reportData.title,
      docs: reportData.records,
      periodLabel,
      generatedBy: reportData.generatedBy,
      customReportData: reportData
    });
  } catch (err) {
    console.error('❌ Partnerships PDF export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// Full-detail column set — used by the dedicated Comparison Excel export's
// per-group record sheets, where the extra attributes help cross-reference
// records between Group A and Group B.
const PARTNERSHIP_FULL_EXCEL_COLUMNS = [
  { header: 'Institution', key: 'inst', width: 32 },
  { header: 'Country', key: 'country', width: 18 },
  { header: 'Region', key: 'region', width: 14 },
  { header: 'Type', key: 'type', width: 8 },
  { header: 'Nature', key: 'nature', width: 18 },
  { header: 'Category', key: 'cat', width: 14 },
  { header: 'Unit', key: 'unit', width: 10 },
  { header: 'Coordinator', key: 'coordinator', width: 20 },
  { header: 'Start Date', key: 'start', width: 14 },
  { header: 'End Date', key: 'end', width: 14 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Remarks', key: 'remarks', width: 30 }
];

// Primary Custom Report Excel template — mirrors the official CIRL "List of
// Active International Partners" reference document's column structure
// exactly (No. | Name of Schools | Address/Country | Date of Signing |
// Date of Expiration). "No." is a printed row index, not a stored field.
const INSTITUTIONAL_LIST_EXCEL_COLUMNS = [
  { header: 'No.', key: 'no', width: 6 },
  { header: 'Name of Schools/Institutions', key: 'inst', width: 38 },
  { header: 'Address/Country', key: 'country', width: 30 },
  { header: 'Date of Signing', key: 'start', width: 16 },
  { header: 'Date of Expiration', key: 'end', width: 18 }
];

function excelColLetter(index) {
  let n = index, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const THIN_BORDER = { style: 'thin', color: { argb: 'FFB7C0CC' } };
const CELL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function buildPartnershipExcel({ title, docs, periodLabel, generatedBy, customReportData }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CIPRMS';
  workbook.created = new Date();

  // Sheet 1: Report Summary & Records
  const sheet1 = workbook.addWorksheet('Report Summary', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
  });

  const colCount = INSTITUTIONAL_LIST_EXCEL_COLUMNS.length;
  const lastCol = excelColLetter(colCount);
  sheet1.columns = INSTITUTIONAL_LIST_EXCEL_COLUMNS.map(c => ({ key: c.key, width: c.width }));

  function mergedRow(sheet, text, { bold = false, size = 11, color = 'FF000000', height = 18, align = 'center', endCol = lastCol } = {}) {
    const row = sheet.addRow([]);
    row.height = height;
    sheet.mergeCells(`A${row.number}:${endCol}${row.number}`);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold, size, color: { argb: color } };
    cell.alignment = { horizontal: align, vertical: 'middle' };
    return row;
  }

  mergedRow(sheet1, 'Republic of the Philippines', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
  mergedRow(sheet1, 'Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'Telephone No. (054) 288-4421 to 23 local 206  |  cspcinternational@cspc.edu.ph', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 11, color: 'FF0A3D91' });
  mergedRow(sheet1, title.toUpperCase(), { bold: true, size: 14, color: 'FF0A58CA', height: 22 });
  mergedRow(sheet1, periodLabel, { size: 9.5, color: 'FF444444' });
  const generatedRow = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  mergedRow(sheet1, `Generated ${generatedRow} by ${generatedBy}`, { size: 9.5, color: 'FF444444' });
  sheet1.addRow([]);

  if (customReportData && customReportData.summary) {
    const s = customReportData.summary;
    const sumRow = sheet1.addRow([
      `Total Records: ${s.totalCount}`,
      `Active: ${s.activeCount}`,
      `Inactive: ${s.inactiveCount}`,
      `Expiring Soon: ${s.expiringSoonCount}`,
      `Expired: ${s.expiredCount}`
    ]);
    sumRow.height = 18;
    sumRow.eachCell(c => {
      c.font = { bold: true, size: 9.5, color: { argb: 'FF0A3D91' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
      c.border = CELL_BORDERS;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    sheet1.addRow([]);
  }

  const groups = groupPartnershipDocs(docs);

  const headerRow = sheet1.addRow(INSTITUTIONAL_LIST_EXCEL_COLUMNS.map(c => c.header));
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });
  const headerRowNumber = headerRow.number;

  let rowIndex = 0;
  groups.forEach(group => {
    if (group.label) {
      const gRow = mergedRow(sheet1, `${group.label} (${group.docs.length})`, { bold: true, size: 10, color: 'FF0A3D91', align: 'left', height: 16 });
      gRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
    }
    group.docs.forEach(p => {
      const rowValues = INSTITUTIONAL_LIST_EXCEL_COLUMNS.reduce((acc, c) => {
        acc[c.key] = c.key === 'no' ? (rowIndex + 1) : p[c.key];
        return acc;
      }, {});
      const row = sheet1.addRow(rowValues);
      const fill = rowIndex % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = CELL_BORDERS;
        cell.alignment = { vertical: 'middle' };
      });
      row.getCell('no').alignment = { vertical: 'middle', horizontal: 'center' };
      rowIndex++;
    });
  });

  sheet1.columns.forEach((col, i) => {
    const header = INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].header;
    let max = header.length;
    docs.forEach(p => {
      const v = INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].key === 'no' ? null : p[INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].key];
      if (v != null) max = Math.max(max, String(v).length);
    });
    col.width = Math.min(Math.max(max + 2, INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].width), 45);
  });

  sheet1.addRow([]);
  const sigRow = sheet1.addRow([]);
  sigRow.height = 16;
  const half = Math.max(1, Math.floor(colCount / 2));
  const sigCols = [
    { label: 'Prepared by:', name: generatedBy, start: 1 },
    { label: 'Noted by:', name: '', start: half + 1 }
  ];
  sigCols.forEach(sc => {
    const end = Math.min(sc.start + half - 1, colCount);
    if (end > sc.start) sheet1.mergeCells(sigRow.number, sc.start, sigRow.number, end);
    const cell = sigRow.getCell(sc.start);
    cell.value = sc.label;
    cell.font = { bold: true, size: 9.5 };
  });
  const sigNameRow = sheet1.addRow([]);
  sigNameRow.height = 16;
  sigCols.forEach(sc => {
    const end = Math.min(sc.start + half - 1, colCount);
    if (end > sc.start) sheet1.mergeCells(sigNameRow.number, sc.start, sigNameRow.number, end);
    const cell = sigNameRow.getCell(sc.start);
    cell.value = sc.name || ' ';
    cell.font = { size: 10 };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: THIN_BORDER };
  });

  sheet1.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet1.pageSetup.printTitlesRow = `${headerRowNumber}:${headerRowNumber}`;

  // Sheet 2 — Applied Filters (the dedicated comparison-only "Comparison
  // Results" sheet was removed — comparison is now a separate, dedicated
  // export reachable only via Preview → Compare, per the Reports & Analytics
  // Round 2 requirements)
  const sheet3 = workbook.addWorksheet('Applied Filters');
  mergedRow(sheet3, 'APPLIED REPORT FILTERS & PARAMETERS', { bold: true, size: 12, color: 'FF0A3D91', endCol: 'B' });
  sheet3.addRow([]);
  
  const filterHeaderRow = sheet3.addRow(['Filter Parameter', 'Applied Value']);
  filterHeaderRow.height = 20;
  filterHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });

  const filterObj = (customReportData && customReportData.filters) || {};
  // Mirrors the Custom Report Builder's actual (reduced) filter set exactly —
  // College/Unit, Region and Nature of Partnership are no longer builder
  // fields, and Country was previously missing here even though it IS a
  // real, still-applied builder filter (a genuine metadata gap: the sheet
  // could show "Country: All" for a report that was actually filtered to a
  // single country).
  const filterLabels = {
    reportType: 'Report Type',
    category: 'Category',
    dateFrom: 'Date From',
    dateTo: 'Date To',
    agreementType: 'Agreement Type',
    status: 'Status',
    country: 'Country'
  };

  Object.entries(filterLabels).forEach(([key, label], idx) => {
    const val = filterObj[key] || 'All';
    const row = sheet3.addRow([label, val]);
    const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
    row.eachCell((cell, cIdx) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = CELL_BORDERS;
      cell.alignment = { horizontal: cIdx === 1 ? 'left' : 'center', vertical: 'middle' };
    });
  });

  sheet3.getColumn(1).width = 25;
  sheet3.getColumn(2).width = 35;

  return workbook;
}

app.get('/api/reports/partnerships/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const reportData = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Custom Report Excel: ${reportData.title}`);

    const periodLabel = (req.query.dateFrom || req.query.dateTo)
      ? `Report Period: ${req.query.dateFrom || 'earliest'} to ${req.query.dateTo || 'present'}`
      : 'Report Period: All Records';

    const workbook = buildPartnershipExcel({
      title: reportData.title,
      docs: reportData.records,
      periodLabel,
      generatedBy: reportData.generatedBy,
      customReportData: reportData
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(reportData.title)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Partnerships Excel export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// ── Comparison Report Endpoints (Separate Section, Administrator-only) ──────
// These power the "Comparison Reports" cards and the Comparison Builder panel.
// They reuse computeCustomReportData() for all DB queries and status logic,
// then render a dedicated two-group comparison PDF and a 3-sheet Excel.

/**
 * Render a dedicated Comparison Report PDF with:
 *   - CSPC letterhead
 *   - Comparison Summary block (Group A vs Group B: count, difference, % diff)
 *   - Detailed records table for each group side-by-side
 */
function renderComparisonReportPdf(res, { title, groupA, groupB, groupADocs, groupBDocs, periodLabel, generatedBy, filters }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(title)}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
  doc.on('error', (err) => {
    console.error('❌ Comparison Report PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate comparison PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Comparison Report PDF response stream error:', err));
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath  = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath  = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath   = path.join(__dirname, 'public', 'images', 'QS.png');

  // ── Letterhead ──
  const LOGO_SIZE = 48;
  const top = doc.page.margins.top;
  doc.y = top;
  try { doc.image(cspcLogoPath, left, top, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
  const rLS = 28;
  const rLX = right - (rLS * 3 + 8);
  try { doc.image(pqaLogoPath,  rLX,              top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath,  rLX + rLS + 4,    top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath,   rLX + (rLS+4)*2,  top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }

  const cX = left + LOGO_SIZE + 8;
  const cW = rLX - cX - 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('CAMARINES SUR POLYTECHNIC COLLEGES', cX, top, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).text('Nabua, Camarines Sur', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text('Telephone No. (054) 288-4421 to 23 local 206', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#0a58ca').text('cspcinternational@cspc.edu.ph', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', cX, doc.y, { width: cW, align: 'center' });
  doc.y = Math.max(doc.y, top + LOGO_SIZE) + 6;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(title.toUpperCase(), left, doc.y, { width: contentWidth, align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8.5).fillColor('#444')
    .text(periodLabel, left, doc.y, { width: contentWidth, align: 'center' })
    .text(`Generated ${now} by ${generatedBy}`, left, doc.y, { width: contentWidth, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // ── Comparison Summary Box ──
  const boxTop = doc.y;
  const boxH = 74;
  doc.rect(left, boxTop, contentWidth, boxH).fill('#EBF2FF').stroke('#0a58ca');
  doc.fill('#000');

  const totalA = groupADocs.length;
  const totalB = groupBDocs.length;
  const diff = Math.abs(totalA - totalB);
  const totalBoth = totalA + totalB;
  const pctA = totalBoth > 0 ? ((totalA / totalBoth) * 100).toFixed(1) : '0.0';
  const pctB = totalBoth > 0 ? ((totalB / totalBoth) * 100).toFixed(1) : '0.0';
  const pctDiff = totalBoth > 0 ? (Math.abs((totalA - totalB) / totalBoth) * 100).toFixed(1) : '0.0';

  const halfW = contentWidth / 2 - 8;

  // Group A column
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a3d91')
    .text(groupA.toUpperCase(), left + 10, boxTop + 8, { width: halfW });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#0a3d91')
    .text(String(totalA), left + 10, boxTop + 22, { width: halfW });
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text(`${pctA}% of compared records`, left + 10, boxTop + 54, { width: halfW });

  // Group B column
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c')
    .text(groupB.toUpperCase(), left + contentWidth / 2 + 4, boxTop + 8, { width: halfW });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#b91c1c')
    .text(String(totalB), left + contentWidth / 2 + 4, boxTop + 22, { width: halfW });
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text(`${pctB}% of compared records`, left + contentWidth / 2 + 4, boxTop + 54, { width: halfW });

  // Center divider line
  doc.moveTo(left + contentWidth / 2, boxTop + 6).lineTo(left + contentWidth / 2, boxTop + boxH - 6)
    .lineWidth(1).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');

  doc.y = boxTop + boxH + 6;

  // Difference + % diff line
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text(`Difference: ${diff} record${diff !== 1 ? 's' : ''} (${pctDiff}% gap)  |  Total compared: ${totalBoth}`,
      left, doc.y, { width: contentWidth, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // Applied Filters (compact)
  if (filters && Object.keys(filters).length > 0) {
    const fParts = Object.entries(filters)
      .filter(([, v]) => v && v !== 'All' && v !== 'All Units' && v !== 'Earliest' && v !== 'Present' && v !== 'All Natures')
      .map(([k, v]) => `${k}: ${v}`);
    if (fParts.length > 0) {
      doc.font('Helvetica').fontSize(8).fillColor('#666')
        .text('Filters applied: ' + fParts.join('  ·  '), left, doc.y, { width: contentWidth });
      doc.fillColor('#000');
      doc.moveDown(0.6);
    }
  }

  // ── Records Tables ──
  const COL_DEFS = [
    { key: 'inst',    label: 'Institution',  width: 175 },
    { key: 'country', label: 'Country',      width: 80  },
    { key: 'region',  label: 'Region',       width: 65  },
    { key: 'type',    label: 'Type',         width: 45  },
    { key: 'nature',  label: 'Nature',       width: 110 },
    { key: 'unit',    label: 'Unit',         width: 50  },
    { key: 'start',   label: 'Start',        width: 75  },
    { key: 'end',     label: 'End',          width: 75  },
    { key: 'status',  label: 'Status',       width: 85  }
  ];

  function drawTableSection(sectionTitle, sectionColor, sectionDocs) {
    if (doc.y + 60 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    // Section header
    const shY = doc.y;
    doc.rect(left, shY, contentWidth, 18).fillAndStroke(sectionColor, sectionColor);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff')
      .text(sectionTitle + ` (${sectionDocs.length} record${sectionDocs.length !== 1 ? 's' : ''})`, left + 6, shY + 5, { width: contentWidth - 12 });
    doc.fillColor('#000');
    doc.y = shY + 18;

    if (sectionDocs.length === 0) {
      const emY = doc.y;
      doc.rect(left, emY, contentWidth, 16).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor('#888')
        .text('No records found for this group.', left + 4, emY + 4, { width: contentWidth - 8 });
      doc.fillColor('#000');
      doc.y = emY + 16;
      doc.moveDown(0.4);
      return;
    }

    // Column headers
    const chY = doc.y;
    doc.rect(left, chY, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
    let cx = left;
    COL_DEFS.forEach(col => {
      doc.text(col.label, cx + 3, chY + 4, { width: col.width - 6, lineBreak: false });
      cx += col.width;
    });
    doc.fillColor('#000');
    doc.y = chY + 16;

    sectionDocs.forEach((p, idx) => {
      if (doc.y + 16 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        // Re-draw col headers on new page
        const chY2 = doc.y;
        doc.rect(left, chY2, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
        let cx2 = left;
        COL_DEFS.forEach(col => {
          doc.text(col.label, cx2 + 3, chY2 + 4, { width: col.width - 6, lineBreak: false });
          cx2 += col.width;
        });
        doc.fillColor('#000');
        doc.y = chY2 + 16;
      }
      const rowY = doc.y;
      const fill = idx % 2 === 0 ? '#FFFFFF' : '#F5F7FA';
      doc.rect(left, rowY, contentWidth, 16).fill(fill).stroke('#ddd');
      doc.font('Helvetica').fontSize(7.5).fillColor('#222');
      let rx = left;
      COL_DEFS.forEach(col => {
        const val = String(p[col.key] == null || p[col.key] === '' ? '—' : p[col.key]);
        doc.text(val, rx + 3, rowY + 4, { width: col.width - 6, lineBreak: false, ellipsis: true });
        rx += col.width;
      });
      doc.strokeColor('#000');
      doc.y = rowY + 16;
    });
    doc.moveDown(0.6);
  }

  drawTableSection(`Group A: ${groupA}`, '#0a3d91', groupADocs);
  drawTableSection(`Group B: ${groupB}`, '#991B1B', groupBDocs);

  // ── Signature block ──
  if (doc.y + 90 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; }
  doc.moveDown(1);
  const sigColW = contentWidth / 3;
  const sigTop = doc.y;
  [{ label: 'Prepared By:', name: generatedBy }, { label: 'Reviewed By:', name: '' }, { label: 'Approved By:', name: '' }]
    .forEach((col, i) => {
      const x = left + i * sigColW;
      doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(col.label, x, sigTop, { width: sigColW - 20 });
      doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop + 32, { width: sigColW - 20, align: 'center' });
      doc.moveTo(x, sigTop + 48).lineTo(x + sigColW - 20, sigTop + 48).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#666')
        .text('Name / Signature over Printed Name', x, sigTop + 51, { width: sigColW - 20, align: 'center' });
    });
  doc.fillColor('#000');

  // ── Page numbering ──
  const range = doc.bufferedPageRange();
  const savedBM = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - savedBM + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888')
      .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBM;
  }
  doc.end();
}

/**
 * Build a dedicated 3-sheet Comparison Report Excel workbook.
 *   Sheet 1 — Comparison Summary: header + summary table (group A vs B)
 *   Sheet 2 — Group A Records: full partnership columns
 *   Sheet 3 — Group B Records: full partnership columns
 */
function buildComparisonExcel({ title, groupA, groupB, groupADocs, groupBDocs, periodLabel, generatedBy, filters }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CIPRMS';
  workbook.created = new Date();

  const totalA = groupADocs.length;
  const totalB = groupBDocs.length;
  const diff = Math.abs(totalA - totalB);
  const totalBoth = totalA + totalB;
  const pctA = totalBoth > 0 ? ((totalA / totalBoth) * 100).toFixed(1) : '0.0';
  const pctB = totalBoth > 0 ? ((totalB / totalBoth) * 100).toFixed(1) : '0.0';
  const pctDiff = totalBoth > 0 ? (Math.abs((totalA - totalB) / totalBoth) * 100).toFixed(1) : '0.0';
  const generatedStr = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ── Sheet 1: Comparison Summary ──
  const s1 = workbook.addWorksheet('Comparison Summary');
  s1.columns = [{ width: 30 }, { width: 20 }, { width: 20 }, { width: 20 }];

  function s1MergedRow(text, opts = {}) {
    const row = s1.addRow([]);
    row.height = opts.height || 18;
    s1.mergeCells(`A${row.number}:D${row.number}`);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold: opts.bold || false, size: opts.size || 10, color: { argb: opts.color || 'FF000000' } };
    cell.alignment = { horizontal: opts.align || 'center', vertical: 'middle' };
    return row;
  }

  s1MergedRow('Republic of the Philippines', { size: 9, color: 'FF444444' });
  s1MergedRow('CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
  s1MergedRow('Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
  s1MergedRow('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 10, color: 'FF0A3D91' });
  s1MergedRow(title.toUpperCase(), { bold: true, size: 14, color: 'FF0A58CA', height: 22 });
  s1MergedRow(periodLabel, { size: 9, color: 'FF444444' });
  s1MergedRow(`Generated ${generatedStr} by ${generatedBy}`, { size: 9, color: 'FF444444' });
  s1.addRow([]);

  // Summary table
  const sumHeaderRow = s1.addRow(['', 'Count', '% of Total Compared', '']);
  sumHeaderRow.height = 18;
  ['A', 'B', 'C', 'D'].forEach((col, i) => {
    const cell = sumHeaderRow.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });

  const groupARow = s1.addRow([`Group A: ${groupA}`, totalA, `${pctA}%`, '']);
  groupARow.height = 18;
  groupARow.getCell(1).font = { bold: true, color: { argb: 'FF0A3D91' } };
  groupARow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
  groupARow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  groupARow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const groupBRow = s1.addRow([`Group B: ${groupB}`, totalB, `${pctB}%`, '']);
  groupBRow.height = 18;
  groupBRow.getCell(1).font = { bold: true, color: { argb: 'FF991B1B' } };
  groupBRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
  groupBRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  groupBRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const diffRow = s1.addRow([`Difference`, diff, `${pctDiff}% gap`, '']);
  diffRow.height = 18;
  diffRow.getCell(1).font = { bold: true };
  diffRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  diffRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const totalRow = s1.addRow([`Total Compared`, totalBoth, '100%', '']);
  totalRow.height = 18;
  totalRow.getCell(1).font = { bold: true };
  totalRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F9' } };
  totalRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  totalRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  s1.addRow([]);
  if (filters) {
    const fRow = s1.addRow(['Applied Filters']);
    fRow.getCell(1).font = { bold: true, size: 10 };
    Object.entries(filters).forEach(([k, v]) => {
      if (v && v !== 'All' && v !== 'All Units' && v !== 'Earliest' && v !== 'Present' && v !== 'All Natures') {
        s1.addRow([k, v]);
      }
    });
  }

  // ── Sheet 2: Group A Records ──
  function buildRecordSheet(name, groupName, docList) {
    const sh = workbook.addWorksheet(name);
    sh.columns = PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => ({ key: c.key, width: c.width }));

    const hdr1 = sh.addRow([]);
    sh.mergeCells(`A${hdr1.number}:L${hdr1.number}`);
    const hdr1Cell = hdr1.getCell(1);
    hdr1Cell.value = `${title.toUpperCase()} — ${groupName.toUpperCase()}`;
    hdr1Cell.font = { bold: true, size: 12, color: { argb: 'FF0A3D91' } };
    hdr1Cell.alignment = { horizontal: 'center', vertical: 'middle' };
    hdr1.height = 20;

    const hdr2 = sh.addRow([]);
    sh.mergeCells(`A${hdr2.number}:L${hdr2.number}`);
    hdr2.getCell(1).value = `${docList.length} record${docList.length !== 1 ? 's' : ''}  |  ${generatedStr}  |  Prepared by: ${generatedBy}`;
    hdr2.getCell(1).font = { size: 9, color: { argb: 'FF444444' } };
    hdr2.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    hdr2.height = 15;
    sh.addRow([]);

    const headerRow = sh.addRow(PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => c.header));
    headerRow.height = 20;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = CELL_BORDERS;
    });

    docList.forEach((p, idx) => {
      const row = sh.addRow(PARTNERSHIP_FULL_EXCEL_COLUMNS.reduce((acc, c) => { acc[c.key] = p[c.key]; return acc; }, {}));
      const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = CELL_BORDERS;
        cell.alignment = { vertical: 'middle' };
      });
    });

    sh.columns.forEach((col, i) => {
      const header = PARTNERSHIP_FULL_EXCEL_COLUMNS[i].header;
      let max = header.length;
      docList.forEach(p => {
        const v = p[PARTNERSHIP_FULL_EXCEL_COLUMNS[i].key];
        if (v != null) max = Math.max(max, String(v).length);
      });
      col.width = Math.min(Math.max(max + 2, PARTNERSHIP_FULL_EXCEL_COLUMNS[i].width), 45);
    });
  }

  buildRecordSheet('Group A Records', `Group A: ${groupA}`, groupADocs);
  buildRecordSheet('Group B Records', `Group B: ${groupB}`, groupBDocs);

  return workbook;
}

/**
 * Shared helper: parse comparison query params, pull docs from DB, split into
 * two groups (A and B), and return all data needed for PDF/Excel/JSON.
 */
async function computeComparisonReport(db, query, user) {
  const compType    = query.compType || 'Active vs Inactive';
  const reportType  = query.reportType || '';
  const dateFrom    = query.dateFrom || '';
  const dateTo      = query.dateTo   || '';
  const unit        = query.unit     || '';
  const agtype      = query.agtype   || '';
  const nature      = query.nature   || '';
  const region      = query.region   || '';
  const country     = query.country  || '';
  const inst        = query.inst     || '';
  const cat         = query.cat      || '';
  const statusQ     = query.status   || '';
  const statusA     = query.statusA  || '';
  const statusB     = query.statusB  || '';

  // Build MongoDB base filter (indexed fields)
  const filter = {};
  if (unit)    filter.unit    = unit;
  if (agtype && ['MOA', 'MOU'].includes(agtype)) filter.type = agtype;
  if (nature)  filter.nature  = nature;
  if (region)  filter.region  = region;
  if (country) filter.country = buildExactCaseInsensitiveMatch(country);
  if (cat)     filter.cat     = cat;
  if (inst)    filter.inst    = { $regex: escapeRegexLiteral(inst), $options: 'i' };

  let docs = await db.collection('partnerships').find(filter).sort({ id: 1 }).toArray();

  // Date range filter
  if (dateFrom || dateTo) {
    docs = filterByDateRange(docs, dateFrom, dateTo);
  }

  // Recompute status using lifecycle logic for every doc
  docs.forEach(p => {
    const calcStatus = computeStatusFromEnd(p.end);
    if (calcStatus) p.status = calcStatus;
    p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
  });

  // Explicit Status filter always wins; otherwise fall back to whatever
  // status the ORIGINAL report's Report Type implied — this is what keeps
  // Group A (the "original, preserved report") identical to what Preview
  // just showed, instead of silently reverting to every status the moment
  // Compare is opened (see REPORT_TYPE_IMPLIED_STATUS).
  const effectiveStatusQ = statusQ || REPORT_TYPE_IMPLIED_STATUS[reportType] || '';

  // Optional single-status pre-filter (for narrowing scope before comparison)
  if (effectiveStatusQ) {
    docs = docs.filter(p => {
      if (effectiveStatusQ === 'Active')        return p.status === 'Active';
      if (effectiveStatusQ === 'Expiring Soon') return p.status === 'Expiring Soon';
      if (effectiveStatusQ === 'Expired')       return p.status === 'Expired';
      if (effectiveStatusQ === 'Inactive')      return p.status === 'Expired' || p.status === 'Inactive';
      return p.status === effectiveStatusQ;
    });
  }

  // Determine the two groups
  let groupALabel, groupBLabel;
  let groupADocs, groupBDocs;

  function matchStatus(p, label) {
    if (label === 'Active')        return p.status === 'Active';
    if (label === 'Inactive')      return p.status === 'Expired' || p.status === 'Inactive' || p.status === 'Expiring Soon';
    if (label === 'Expired')       return p.status === 'Expired';
    if (label === 'Expiring Soon') return p.status === 'Expiring Soon';
    if (label === 'Renewed')       return p.isRenewed === true;
    if (label === 'Non-Renewed')   return p.isRenewed === false;
    return p.status === label;
  }

  if (compType === 'Active vs Inactive') {
    groupALabel = 'Active';    groupBLabel = 'Inactive';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Inactive'));

  } else if (compType === 'Active vs Expired') {
    groupALabel = 'Active';    groupBLabel = 'Expired';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Expired'));

  } else if (compType === 'New vs Renewed') {
    groupALabel = 'New (Non-Renewed)'; groupBLabel = 'Renewed';
    groupADocs = docs.filter(p => !p.isRenewed);
    groupBDocs = docs.filter(p => p.isRenewed);

  } else if (compType === 'Custom Status Comparison') {
    // statusA and statusB from the form
    const sA = statusA || 'Active';
    const sB = statusB || 'Inactive';
    groupALabel = sA; groupBLabel = sB;
    groupADocs = docs.filter(p => matchStatus(p, sA));
    groupBDocs = docs.filter(p => matchStatus(p, sB));

  } else if (compType === 'Compare Against') {
    // Dimension-override comparison — the ONLY mode reachable from the
    // Custom Report Builder's Preview → Compare button. Group A is the
    // ORIGINAL report exactly as already filtered above ("docs"), never
    // rebuilt or narrowed — it is preserved verbatim, per the requirement
    // that the admin's original report must never be replaced or destroyed.
    // Group B re-runs the SAME base filters with exactly one dimension
    // overridden to the chosen comparison value.
    const dimFieldMap = { country: 'country', inst: 'inst', unit: 'unit', region: 'region', type: 'type', nature: 'nature', cat: 'cat' };
    const dimLabelMap = {
      country: 'Country', inst: 'Institution', unit: 'College / Unit', region: 'Region',
      type: 'Agreement Type', nature: 'Nature of Partnership', cat: 'Category',
      year: 'Year', status: 'Partnership Status'
    };
    const dimField = query.compareField || 'country';
    const dimValue = (query.compareValue || '').trim();
    const dimLabel = dimLabelMap[dimField] || dimField;

    groupALabel = query.title || 'Original Report';
    groupBLabel = dimValue ? `${dimLabel}: ${dimValue}` : 'No comparison value selected';
    groupADocs = docs;

    async function fetchOverrideGroup(overrideFilter, statusOverride) {
      let odocs = await db.collection('partnerships').find(overrideFilter).sort({ id: 1 }).toArray();
      if (dateFrom || dateTo) odocs = filterByDateRange(odocs, dateFrom, dateTo);
      odocs.forEach(p => {
        const calcStatus = computeStatusFromEnd(p.end);
        if (calcStatus) p.status = calcStatus;
        p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
      });
      if (statusOverride) odocs = odocs.filter(p => matchStatus(p, statusOverride));
      return odocs;
    }

    if (!dimValue) {
      groupBDocs = [];
    } else if (dimField === 'year') {
      groupBDocs = (await fetchOverrideGroup(filter, effectiveStatusQ)).filter(p => {
        const y = p.startYear || (p.start ? new Date(p.start).getFullYear() : null);
        return String(y) === dimValue;
      });
    } else if (dimField === 'status') {
      groupBDocs = await fetchOverrideGroup(filter, dimValue);
    } else if (dimField === 'inst') {
      groupBDocs = await fetchOverrideGroup({ ...filter, inst: { $regex: escapeRegexLiteral(dimValue), $options: 'i' } }, effectiveStatusQ);
    } else if (dimField === 'country') {
      groupBDocs = await fetchOverrideGroup({ ...filter, country: buildExactCaseInsensitiveMatch(dimValue) }, effectiveStatusQ);
    } else if (dimFieldMap[dimField]) {
      groupBDocs = await fetchOverrideGroup({ ...filter, [dimFieldMap[dimField]]: dimValue }, effectiveStatusQ);
    } else {
      groupBDocs = [];
    }

  } else {
    // Fallback to Active vs Inactive
    groupALabel = 'Active'; groupBLabel = 'Inactive';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Inactive'));
  }

  const title = `${groupALabel} vs ${groupBLabel} Comparison Report`;
  const periodLabel = (dateFrom || dateTo)
    ? `Report Period: ${dateFrom || 'Earliest'} to ${dateTo || 'Present'}`
    : 'Report Period: All Records';

  const filters = {
    'Comparison Type': compType,
    'Category': cat || 'All',
    'Date From': dateFrom || 'Earliest',
    'Date To': dateTo || 'Present',
    'College / Unit': unit || 'All',
    'Agreement Type': agtype || 'All',
    'Nature': nature || 'All',
    'Region': region || 'All',
    'Country': country || 'All',
    'Institution': inst || 'All',
    'Status Filter': effectiveStatusQ || 'All'
  };

  return {
    title,
    groupA: groupALabel,
    groupB: groupBLabel,
    groupADocs,
    groupBDocs,
    totalA: groupADocs.length,
    totalB: groupBDocs.length,
    totalBoth: groupADocs.length + groupBDocs.length,
    diff: Math.abs(groupADocs.length - groupBDocs.length),
    periodLabel,
    generatedBy: (user && user.name) || 'Administrator',
    generatedDate: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    filters
  };
}

// Distinct real values for a given comparison dimension — powers the
// "Compare Against" picker in the Preview → Compare step. Never hardcoded;
// always read live from the partnerships collection.
const COMPARE_DIMENSION_DB_FIELDS = { country: 'country', inst: 'inst', unit: 'unit', region: 'region', type: 'type', nature: 'nature', cat: 'cat' };
app.get('/api/reports/dimension-values', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const field = req.query.field || 'country';
    if (field === 'status') {
      return res.json({ field, values: ['Active', 'Expiring Soon', 'Expired', 'Inactive'] });
    }
    if (field === 'year') {
      const docs = await db.collection('partnerships').find({}, { projection: { start: 1, startYear: 1 } }).toArray();
      const years = new Set();
      docs.forEach(p => {
        const y = p.startYear || (p.start ? new Date(p.start).getFullYear() : null);
        if (y) years.add(String(y));
      });
      return res.json({ field, values: Array.from(years).sort().reverse() });
    }
    const dbField = COMPARE_DIMENSION_DB_FIELDS[field];
    if (!dbField) return res.status(400).json({ error: 'Invalid comparison field.' });
    let values = await db.collection('partnerships').distinct(dbField);
    values = values.filter(Boolean).sort();
    res.json({ field, values });
  } catch (err) {
    console.error('❌ Dimension values error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Comparison Report: JSON preview
app.get('/api/reports/comparison/preview', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Generated Comparison Report preview: ${data.title}`);
    // Return JSON-serializable summary (omit full doc arrays for perf, just counts)
    res.json({
      title: data.title,
      groupA: data.groupA,
      groupB: data.groupB,
      totalA: data.totalA,
      totalB: data.totalB,
      totalBoth: data.totalBoth,
      diff: data.diff,
      periodLabel: data.periodLabel,
      generatedBy: data.generatedBy,
      generatedDate: data.generatedDate,
      filters: data.filters,
      // Include limited records for the preview table (max 100 per group)
      groupARecords: data.groupADocs.slice(0, 100),
      groupBRecords: data.groupBDocs.slice(0, 100)
    });
  } catch (err) {
    console.error('❌ Comparison Report preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Comparison Report: PDF
app.get('/api/reports/comparison/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Comparison Report PDF: ${data.title}`);
    renderComparisonReportPdf(res, data);
  } catch (err) {
    console.error('❌ Comparison Report PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// Comparison Report: Excel
app.get('/api/reports/comparison/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Comparison Report Excel: ${data.title}`);

    const workbook = buildComparisonExcel(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(data.title)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Comparison Report Excel error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

app.get('/api/reports/activitylog/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.collection('activitylogs').find(activityLogFilterFor(req.session.user)).sort({ id: -1 }).toArray();
    const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const isOwnTrailOnly = req.session.user && req.session.user.role === 'Staff';
    renderTablePdf(res, {
      title: isOwnTrailOnly ? 'My Activity Trail' : 'Activity / Audit Trail', filename: 'Activity_Audit_Log',
      subtitle: `Generated ${now} · ${logs.length} entries`,
      columns: [
        { key: 'action', label: 'Action', width: 70 },
        { key: 'record', label: 'Record / Details', width: 330 },
        { key: 'by', label: 'Performed By', width: 130 },
        { key: 'role', label: 'Role', width: 110 },
        { key: 'date', label: 'Date & Time', width: 120 }
      ],
      rows: logs.map(l => ({ ...l, role: formatRole(l.role) }))
    });
  } catch (err) {
    console.error('❌ Activity log PDF export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

app.get('/api/reports/activitylog/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.collection('activitylogs').find(activityLogFilterFor(req.session.user)).sort({ id: -1 }).toArray();
    const isOwnTrailOnly = req.session.user && req.session.user.role === 'Staff';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CIPRMS';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Audit Trail', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    const auditCols = 5;
    const auditLastCol = 'E';
    function auditMergedRow(text, { bold = false, size = 10, color = 'FF000000', height = 16, align = 'center' } = {}) {
      const r = sheet.addRow([]);
      r.height = height;
      sheet.mergeCells(`A${r.number}:${auditLastCol}${r.number}`);
      const cell = r.getCell(1);
      cell.value = text;
      cell.font = { bold, size, color: { argb: color } };
      cell.alignment = { horizontal: align, vertical: 'middle' };
      return r;
    }
    auditMergedRow('Republic of the Philippines', { size: 9, color: 'FF444444' });
    auditMergedRow('CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
    auditMergedRow('Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
    auditMergedRow('Telephone No. (054) 288-4421 to 23 local 206  |  cspcinternational@cspc.edu.ph', { size: 9, color: 'FF444444' });
    auditMergedRow('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 11, color: 'FF0A3D91' });
    auditMergedRow(isOwnTrailOnly ? 'MY ACTIVITY TRAIL' : 'ACTIVITY / AUDIT TRAIL', { bold: true, size: 14, color: 'FF0A58CA', height: 20 });
    const auditNow = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    auditMergedRow(`Generated ${auditNow}  ·  ${logs.length} entries`, { size: 9, color: 'FF444444' });
    sheet.addRow([]);
    sheet.columns = [
      { header: 'Action', key: 'action', width: 12 },
      { header: 'Record / Details', key: 'record', width: 55 },
      { header: 'Performed By', key: 'by', width: 22 },
      { header: 'Role', key: 'role', width: 18 },
      { header: 'Date & Time', key: 'date', width: 22 }
    ];
    // Re-add merged header rows since setting sheet.columns resets row structure;
    // instead, manually set the column header row after the letterhead rows.
    const auditHeaderRow = sheet.addRow(['Action', 'Record / Details', 'Performed By', 'Role', 'Date & Time']);
    auditHeaderRow.height = 18;
    auditHeaderRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'thin', color: { argb: 'FFB7C0CC' } }, left: { style: 'thin', color: { argb: 'FFB7C0CC' } }, bottom: { style: 'thin', color: { argb: 'FFB7C0CC' } }, right: { style: 'thin', color: { argb: 'FFB7C0CC' } } };
    });
    const auditDataKeys = ['action', 'record', 'by', 'role', 'date'];
    logs.forEach((l, idx) => {
      const row = sheet.addRow(auditDataKeys.map(k => k === 'role' ? formatRole(l[k]) : l[k]));
      const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB7C0CC' } }, left: { style: 'thin', color: { argb: 'FFB7C0CC' } }, bottom: { style: 'thin', color: { argb: 'FFB7C0CC' } }, right: { style: 'thin', color: { argb: 'FFB7C0CC' } } };
        cell.alignment = { vertical: 'middle' };
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Activity_Audit_Log.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Activity log Excel export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
// Administrator and Staff share full User Management CRUD (2026-08-27
// full-parity revision) — GET/POST/PATCH/DELETE /api/users are all
// requireStaffAccess. The one preserved boundary: Staff can never
// create/edit/delete an Administrator account or grant the Administrator
// role (see the explicit checks inside POST/PATCH/DELETE below) — a
// deliberate privilege-escalation guard, not an oversight.
app.get('/api/users', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    // Never expose password field to the client
    const docs = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_USER_ROLES = ['Administrator', 'Auth. Personnel', 'Staff', 'potential_partner'];
const VALID_USER_STATUSES = ['Active', 'Inactive'];

// User Management — Administrator and Staff share full CRUD (2026-08-27
// full-parity revision), EXCEPT Staff may never create, edit, or delete an
// Administrator account, nor grant the Administrator role to anyone
// (privilege-escalation boundary — see the three checks below and in
// PATCH/DELETE below; this is the "genuinely security-sensitive" exception
// the spec calls out, preserved deliberately rather than relaxed).
app.post('/api/users', requireStaffAccess, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    // Normalize the same way /signup and Google login do — otherwise an email typed
    // with different casing here silently can never match at login time.
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const role = req.body.role || 'Staff';
    if (!VALID_USER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (req.session.user.role === 'Staff' && role === 'Administrator') {
      return res.status(403).json({ error: 'Staff cannot create Administrator accounts.' });
    }
    const status = req.body.status || 'Active';
    if (!VALID_USER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const db = getDb();
    const existing = await db.collection('users').findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Every new account gets its own randomly-generated temporary password unless
    // the admin explicitly typed one — never reuse a single shared default password.
    let tempPassword = null;
    let passwordToStore;
    if (req.body.password) {
      if (!isStrongPassword(req.body.password)) {
        return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
      }
      passwordToStore = await hashPassword(req.body.password);
    } else {
      tempPassword = generateTempPassword();
      passwordToStore = await hashPassword(tempPassword);
    }

    // Strip client-supplied id/_id before spreading req.body — otherwise a
    // caller could override the server-computed id and collide with (or hijack
    // the identity of) an existing user, which every edit/delete/password
    // route looks up by that same id.
    const { id: _clientId, _id: _clientMongoId, ...safeBody } = req.body;
    const last = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? last[0].id + 1 : 1;
    // Unit/Department is optional — normalize to an empty string rather than
    // storing it as undefined/missing when the admin leaves it blank.
    const entry = { id: nextId, ...safeBody, name, email, role, status, unit: (req.body.unit || '').trim(), password: passwordToStore, createdAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) };
    await db.collection('users').insertOne(entry);
    await logActivity(db, req.session.user, 'ADD', `User created: ${entry.name} (${entry.role}) — ${entry.email}`);
    const { password: _, ...safeEntry } = entry; // don't return the password hash
    // tempPassword is only ever returned this one time so the admin can relay it out-of-band.
    res.json({ success: true, user: safeEntry, tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    // Strip client-supplied id/_id — otherwise the request body could rename
    // this record's identity mid-edit, breaking every route that looks it up
    // by id (delete, password change, this same edit endpoint next time).
    const { id: _clientId, _id: _clientMongoId, ...updateData } = req.body;

    // Privilege-escalation boundary: Staff can manage every other account,
    // but never an Administrator's (regardless of which fields are being
    // changed — email/password/status edits on an admin account are just as
    // sensitive as a role change) and can never grant the Administrator
    // role to anyone, including themselves.
    if (req.session.user.role === 'Staff') {
      const target = await db.collection('users').findOne({ id });
      if (target && target.role === 'Administrator') {
        return res.status(403).json({ error: 'Staff cannot modify Administrator accounts.' });
      }
      if (updateData.role === 'Administrator') {
        return res.status(403).json({ error: 'Staff cannot grant the Administrator role.' });
      }
    }

    if (updateData.name !== undefined) {
      updateData.name = (updateData.name || '').trim();
      if (!updateData.name) {
        return res.status(400).json({ error: 'Name is required.' });
      }
    }
    if (updateData.role !== undefined && !VALID_USER_ROLES.includes(updateData.role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (updateData.status !== undefined && !VALID_USER_STATUSES.includes(updateData.status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    // Normalize the same way /signup and Google login do — otherwise an email typed
    // with different casing here silently can never match at login time.
    if (updateData.email !== undefined) {
      const email = (updateData.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
      }
      const conflict = await db.collection('users').findOne({ email, id: { $ne: id } });
      if (conflict) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      updateData.email = email;
    }

    // Unit/Department is optional — if the field was sent at all, normalize it
    // to a trimmed string (never leave it as undefined/null in the update).
    if (updateData.unit !== undefined) {
      updateData.unit = (updateData.unit || '').trim();
    }

    // Never let an admin lock everyone out: block deactivating your own account,
    // and block demoting the last remaining Administrator.
    if (req.session.user.id === id && updateData.status === 'Inactive') {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    if (updateData.role !== undefined && updateData.role !== 'Administrator') {
      const target = await db.collection('users').findOne({ id });
      if (target && target.role === 'Administrator') {
        const adminCount = await db.collection('users').countDocuments({ role: 'Administrator' });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last remaining Administrator.' });
        }
      }
    }

    // Only allow password update if explicitly provided (admin setting it via User Management)
    if (!updateData.password) {
      delete updateData.password;
    } else {
      if (!isStrongPassword(updateData.password)) {
        return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
      }
      updateData.password = await hashPassword(updateData.password);
    }
    await db.collection('users').updateOne({ id }, { $set: updateData });
    const updated = await db.collection('users').findOne({ id }, { projection: { password: 0 } });
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    await logActivity(db, req.session.user, 'EDIT', `User updated: ${updated.name} — role: ${updated.role}, status: ${updated.status}`);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    // Never let an admin lock everyone out: block deleting your own account,
    // and block deleting the last remaining Administrator.
    if (req.session.user.id === id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    const target = await db.collection('users').findOne({ id }, { projection: { password: 0 } });
    // Privilege-escalation boundary: Staff can never delete an Administrator
    // account, regardless of how many Administrators remain.
    if (target && target.role === 'Administrator' && req.session.user.role === 'Staff') {
      return res.status(403).json({ error: 'Staff cannot delete Administrator accounts.' });
    }
    if (target && target.role === 'Administrator') {
      const adminCount = await db.collection('users').countDocuments({ role: 'Administrator' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last remaining Administrator.' });
      }
    }
    await db.collection('users').deleteOne({ id });
    await logActivity(db, req.session.user, 'DELETE', `User deleted: ${target ? target.name + ' (' + target.email + ')' : 'ID #' + id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ACTIVITY LOGS ─────────────────────────────────────────────────────────────

/**
 * logActivity — server-side helper to write an audit entry.
 * @param {object} db   - Mongo db handle
 * @param {object} user - req.session.user
 * @param {string} action - ADD | EDIT | DELETE | APPROVE | REJECT | RENEW | VIEW
 * @param {string} record - human-readable description
 */
async function logActivity(db, user, action, record) {
  try {
    const last = await db.collection('activitylogs').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? (last[0].id || 0) + 1 : 1;
    await db.collection('activitylogs').insertOne({
      id: nextId,
      action,
      record,
      by: user ? user.name : 'System',
      role: user ? user.role : 'System',
      // Added 2026-08-27 (View-Only → Staff migration) so the Audit Trail can
      // scope Staff to their own records by a stable identifier rather than
      // by display name (which is not guaranteed unique). Entries logged
      // before this change have no `email` field — left as-is, a legitimate
      // historical record, not migrated/backfilled.
      email: user ? user.email : null,
      date: new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      })
    });
  } catch (e) {
    console.error('logActivity error:', e.message);
  }
}

// Audit Trail visibility boundary: Administrator sees every record
// (unfiltered); Staff sees ONLY their own — enforced here at the query
// level (not just hidden in the UI) and reused by every Audit Trail data
// source (JSON, PDF, Excel) so none of them can drift out of sync.
function activityLogFilterFor(user) {
  if (user && user.role === 'Staff') return { email: user.email };
  return {};
}

/**
 * notifyUsers — shared helper for inserting one targeted notification per
 * recipient. Every notification-producing route in this file (request
 * decisions, document uploads, new-submission alerts, calendar events) reuses
 * this instead of re-deriving the next `id` and repeating the same insertOne
 * shape at each call site.
 * @param {object} db
 * @param {string[]} emails - target recipient emails (deduped, falsy entries dropped)
 * @param {object} payload - { module, tag, icon, color, title, desc, link, downloadLink }
 */
async function notifyUsers(db, emails, payload) {
  const targets = [...new Set((emails || []).filter(Boolean))];
  if (!targets.length) return;
  const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
  let nextId = last.length ? (last[0].id || 0) + 1 : 1;
  const time = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const docs = targets.map(targetEmail => ({
    id: nextId++,
    targetEmail,
    unread: true,
    time,
    ...payload
  }));
  await db.collection('notifications').insertMany(docs);
}

// documentLibraryService.shortDocType() classifies by matching words like
// "agreement"/"understanding" in a free-form OCR guess — short codes like
// "MOA"/"MOU" don't contain those words, so this expands them to a
// descriptive phrase first, keeping the Document Library entry correctly
// typed instead of always falling through to "Other".
const DOC_TYPE_LABELS = {
  MOA: 'Memorandum of Agreement',
  MOU: 'Memorandum of Understanding',
  LOI: 'Letter of Intent',
  JVA: 'Joint Venture Agreement',
  Accreditation: 'Accreditation'
};
function expandDocTypeLabel(shortCode) {
  return DOC_TYPE_LABELS[shortCode] || shortCode;
}

/**
 * Picks the right "Request Details" destination for a Partnership Request
 * notification based on the submitter's own role — Administrator has the
 * shared review modal (deep-linkable by id), while potential_partner and
 * Staff each only have their own plain request-tracking list (no
 * per-request modal exists there today), so those link at the page level.
 */
function prLinkForRole(role, id) {
  if (role === 'Administrator') return '/partnership-requests?open=pr&id=' + id;
  // potential_partner's own request tracking moved from the Requests page onto
  // Monitoring (2026-07-23) — the Requests page now only holds the submission
  // forms, not a history table to highlight a row in. `type=pr` disambiguates
  // from a Document Request's `id`, since the two collections' ids are not
  // unique with respect to each other.
  if (role === 'potential_partner') return '/partner/monitoring?type=pr&id=' + id;
  // Staff can no longer submit new Partnership Requests (2026-08-27) but may
  // still have historical ones from before that change — those are tracked
  // read-only on the shared Requests page, same as everyone else's own-scoped view.
  if (role === 'Staff') return '/staff/requests?id=' + id;
  // Auth. Personnel's tracking moved from the Requests page onto its own
  // Monitoring page (2026-07-25), matching the potential_partner convention
  // above — the Requests page now only holds the submission forms.
  if (role === 'Auth. Personnel') return '/personnel/monitoring?type=pr&id=' + id;
  return '/partnership-requests?open=pr&id=' + id;
}

// Same per-role deep-link resolution as prLinkForRole, for Document Request
// notifications. potential_partner gained Document Requests 2026-07-22, and
// its tracking also lives on Monitoring (never a page of its own).
function drLinkForRole(role, id) {
  if (role === 'Administrator') return '/partnership-requests?open=dr&id=' + id;
  if (role === 'potential_partner') return '/partner/monitoring?type=dr&id=' + id;
  // Auth. Personnel is the only other role that submits Document Requests
  // (requireRequester excludes Staff, same conservative scope View-Only had)
  // — tracking lives on their Monitoring page (2026-07-25), matching the
  // potential_partner convention above.
  return '/personnel/monitoring?type=dr&id=' + id;
}

// ── LIFECYCLE AUTOMATION — status computation & notification generation ──────
const LIFECYCLE_EXPIRING_WINDOW_DAYS = 90;
const LIFECYCLE_CHECK_INTERVAL_MS = parseInt(process.env.LIFECYCLE_CHECK_INTERVAL_MS, 10) || 60 * 60 * 1000; // hourly by default

/**
 * Derives a partnership's status purely from its end date — the same
 * "days until expiry" rule used across the UI (computeStatus/computeEditStatus/
 * computeRenewStatus), now applied server-side so it doesn't depend on a human
 * happening to open that specific record.
 */
function computeStatusFromEnd(endStr) {
  const end = new Date(endStr);
  if (isNaN(end)) return null; // unparseable/missing end date — leave the record alone
  const daysLeft = Math.ceil((end - new Date()) / 86400000);
  if (daysLeft < 0) return 'Expired';
  if (daysLeft <= LIFECYCLE_EXPIRING_WINDOW_DAYS) return 'Expiring Soon';
  return 'Active';
}

/**
 * Recomputes every partnership's status from its end date and creates a
 * notification the first time a record newly becomes Expiring Soon or Expired.
 * `lastNotifiedStatus` (stored on the partnership doc) prevents re-notifying on
 * every run for a record that's already been flagged and hasn't changed since —
 * it's cleared once the partnership returns to Active (e.g. after a renewal),
 * so a future re-expiry notifies again.
 */
async function recomputePartnershipStatuses(db) {
  const partnerships = await db.collection('partnerships').find({}).toArray();
  const toNotify = [];

  for (const p of partnerships) {
    const newStatus = computeStatusFromEnd(p.end);
    if (!newStatus) continue;

    const updates = {};
    if (newStatus !== p.status) updates.status = newStatus;

    if (newStatus === 'Active') {
      if (p.lastNotifiedStatus) updates.lastNotifiedStatus = null;
    } else if (p.lastNotifiedStatus !== newStatus) {
      updates.lastNotifiedStatus = newStatus;
      toNotify.push({ partnership: p, status: newStatus });
    }

    if (Object.keys(updates).length) {
      await db.collection('partnerships').updateOne({ id: p.id }, { $set: updates });
    }
  }

  if (toNotify.length) {
    const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = last.length ? (last[0].id || 0) + 1 : 1;
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const docs = toNotify.map(({ partnership: p, status }) => {
      const isExpired = status === 'Expired';
      return {
        id: nextId++,
        module: 'lifecycle',
        tag: 'Lifecycle',
        unread: true,
        icon: isExpired ? 'ri-close-circle-line' : 'ri-alarm-warning-line',
        color: isExpired ? 'danger' : 'warning',
        title: isExpired ? `Partnership Expired: ${p.inst}` : `Partnership Expiring Soon: ${p.inst}`,
        desc: isExpired
          ? `The agreement with ${p.inst}${p.country ? ' (' + p.country + ')' : ''} expired on ${p.end}. Renewal or archival action is needed.`
          : `The agreement with ${p.inst}${p.country ? ' (' + p.country + ')' : ''} is expiring on ${p.end}. Consider initiating renewal.`,
        time: today
      };
    });

    await db.collection('notifications').insertMany(docs);

    const expiredCount = toNotify.filter(t => t.status === 'Expired').length;
    const expiringCount = toNotify.length - expiredCount;
    await logActivity(db, null, 'EDIT',
      `Automatic lifecycle check: ${toNotify.length} partnership(s) flagged (${expiringCount} newly expiring, ${expiredCount} newly expired)`);
  }

  return toNotify.length;
}

async function runLifecycleCheck() {
  try {
    const db = getDb();
    const count = await recomputePartnershipStatuses(db);
    if (count > 0) console.log(`✓ Lifecycle check: ${count} new notification(s) generated.`);
  } catch (err) {
    console.error('❌ Lifecycle check failed:', err.message);
  }
}

// Manual trigger (admin only) — lets an admin force a check immediately instead
// of waiting for the next scheduled run; also used to validate the feature.
app.post('/api/lifecycle/recompute', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const count = await recomputePartnershipStatuses(db);
    res.json({ success: true, notificationsCreated: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/activitylogs', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('activitylogs')
      .find(activityLogFilterFor(req.session.user))
      .sort({ _id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
// NOTE: the public POST /api/activitylogs and POST /api/notifications routes
// that used to live here were removed 2026-07-18 (Roadmap v2, Phase A1) — both
// were requireAuth-only, spread req.body into the inserted document with zero
// validation, and had zero frontend callers, making them pure forgery vectors
// (any authenticated user could fabricate audit-log entries or notifications
// targeted at anyone). Real activity-log writes still go through the trusted
// server-side logActivity() helper; real notification writes still go through
// the lifecycle/approval code paths. See docs/SYSTEM_AUDIT_2026-07-16.md.

// Marks only the current user's own targeted notifications as read. Every
// role uses this same route now — Administrator/Auth. Personnel's frontend
// (administrator/notifications.ejs) was repointed here from the old,
// unscoped /markallread (removed 2026-07-18, see docs/SYSTEM_AUDIT_2026-07-16.md).
app.patch('/api/notifications/markallread/mine', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    await db.collection('notifications').updateMany({ targetEmail: email }, { $set: { unread: false } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every role, including Administrator/Auth. Personnel, may only act on a
// notification actually addressed to them (targetEmail match) — no role gets
// a blanket-access exception.
function canActOnNotification(user, notif) {
  return !!notif && notif.targetEmail === user.email;
}

// Every real caller (admin/personnel/partner notification views) only ever
// sends { unread: false } — that's the entire canonical schema for this route.
const NOTIFICATION_PATCH_FIELDS = { unread: 'boolean' };

app.patch('/api/notifications/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const unknown = Object.keys(req.body).filter(k => !(k in NOTIFICATION_PATCH_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    if (req.body.unread !== undefined && typeof req.body.unread !== 'boolean') {
      return res.status(400).json({ error: 'unread must be a boolean.' });
    }

    const db = getDb();
    const notif = await db.collection('notifications').findOne({ id });
    if (!notif) return res.status(404).json({ error: 'Not found.' });
    if (!canActOnNotification(req.session.user, notif)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    const fields = {};
    if (req.body.unread !== undefined) fields.unread = req.body.unread;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }
    await db.collection('notifications').updateOne({ id }, { $set: fields });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const notif = await db.collection('notifications').findOne({ id });
    if (!notif) return res.status(404).json({ error: 'Not found.' });
    if (!canActOnNotification(req.session.user, notif)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    await db.collection('notifications').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CALENDAR EVENTS ───────────────────────────────────────────────────────────
// Explicit allowlist mirroring the real fields the calendar UI actually sends
// (views/administrator/calendar.ejs: the Add/Edit modal, drag-move, and
// drag-resize handlers) — closes the id-mass-assignment gap (Roadmap v2 Phase
// A2, docs/SYSTEM_AUDIT_2026-07-16.md) the same way PARTNERSHIP_FIELDS already
// does for partnerships: never spread req.body directly into an insert/$set.
const CALENDAR_EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'className', 'location', 'description'];
function pickCalendarEventFields(body) {
  const safe = {};
  for (const f of CALENDAR_EVENT_FIELDS) {
    if (body[f] !== undefined) safe[f] = body[f];
  }
  return safe;
}

// Visibility: Administrators see every event (full oversight). Every other
// role only sees events that either name them as a recipient or were never
// scoped to specific recipients in the first place — events predating this
// feature, and events created with no/"all" recipients, carry no
// `recipientEmails` field at all, so they stay visible to everyone exactly as
// before (closes the "existing calendar functionality unaffected" requirement).
app.get('/api/calendarevents', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const user = req.session.user;
    const filter = user.role === 'Administrator'
      ? {}
      : { $or: [{ recipientEmails: { $exists: false } }, { recipientEmails: user.email }] };
    const docs = await db.collection('calendarevents').find(filter).toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CALENDAR_RECIPIENT_ROLES = ['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'];

/**
 * Resolves the "recipients" the Administrator picked when creating a
 * calendar event into a concrete, de-duplicated list of target emails.
 * `recipients` is an array mixing role tokens (from CALENDAR_RECIPIENT_ROLES,
 * or 'all') and/or individual user emails — a user selected both by role and
 * individually (e.g. "Auth. Personnel" plus that same person's own email)
 * only ends up in the list once. Used both for who gets notified and — via
 * the caller — for who the event is visible to, so de-duping here matters
 * for both, not just for avoiding duplicate notifications.
 */
async function resolveCalendarRecipients(db, recipients) {
  if (!Array.isArray(recipients) || !recipients.length) return [];
  if (recipients.includes('all')) {
    // "All Users" only ever reaches active accounts — an Inactive/deactivated
    // user can't log in to see the notification anyway.
    const all = await db.collection('users').find({ status: 'Active' }).toArray();
    return [...new Set(all.map(u => u.email))];
  }
  const roles = recipients.filter(r => CALENDAR_RECIPIENT_ROLES.includes(r));
  const emails = recipients.filter(r => !CALENDAR_RECIPIENT_ROLES.includes(r) && r !== 'all');
  let roleEmails = [];
  if (roles.length) {
    const users = await db.collection('users').find({ role: { $in: roles } }).toArray();
    roleEmails = users.map(u => u.email);
  }
  return [...new Set([...roleEmails, ...emails])];
}

// The calendar itself is a shared institutional calendar, viewable by every
// authenticated role (see GET above, requireAuth) — but only Administrator
// may create/edit/delete entries (requireAdmin on this route and PATCH/DELETE
// below). Corrected 2026-07-29 (RBAC matrix audit, docs/SYSTEM_AUDIT_2026-07-16.md):
// this comment previously said "Administrator/Auth. Personnel", which never
// matched the actual gate on any of the three routes.
app.post('/api/calendarevents', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const last = await db.collection('calendarevents').find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? (last[0].id || 0) + 1 : 1;

    // Recipients are only meaningful at creation time — only the users
    // selected here are notified, per the recipient-targeting requirement.
    const rawRecipients = req.body.recipients;
    const targetEmails = await resolveCalendarRecipients(db, rawRecipients);
    // "All Users" (or no recipients picked at all) means the event is public/
    // system-wide — only a genuinely narrowed selection (specific roles
    // and/or specific individuals, not "all") restricts who can see it.
    const isScoped = Array.isArray(rawRecipients) && rawRecipients.length && !rawRecipients.includes('all');
    const entry = {
      id: nextId,
      ...pickCalendarEventFields(req.body),
      ...(isScoped ? { recipientEmails: targetEmails } : {}),
      // Separate from recipientEmails (which drives CIPRMS's own visibility
      // filter above, and is deliberately absent for "all users" events) —
      // this is the STABLE attendee list Google Calendar sync uses on every
      // future edit, captured once here regardless of whether the event was
      // scoped or public. Without this, an "All Users" event's Google
      // attendees would silently be wiped on its first edit, since
      // recipientEmails never existed on that doc to fall back to.
      ...(targetEmails.length ? { googleAttendeeEmails: targetEmails } : {})
    };
    await db.collection('calendarevents').insertOne(entry);

    // Deep-link straight to the event on whichever calendar page the
    // recipient's role actually has (mirrors prLinkForRole's per-role
    // navigation for Partnership Request notifications) so a click opens the
    // event detail modal immediately instead of landing on a blank calendar.
    const recipientUsers = targetEmails.length
      ? await db.collection('users').find({ email: { $in: targetEmails } }).toArray()
      : [];
    const roleOfEmail = new Map(recipientUsers.map(u => [u.email, u.role]));
    const CALENDAR_LINK_BY_ROLE = {
      'Administrator': '/calendar?id=' + entry.id,
      'Auth. Personnel': '/personnel/calendar?id=' + entry.id,
      'potential_partner': '/partner/calendar?id=' + entry.id,
      'Staff': '/staff/calendar?id=' + entry.id
    };
    const emailsByLink = new Map();
    for (const email of targetEmails) {
      const link = CALENDAR_LINK_BY_ROLE[roleOfEmail.get(email)] || '/calendar';
      if (!emailsByLink.has(link)) emailsByLink.set(link, []);
      emailsByLink.get(link).push(email);
    }
    for (const [link, emails] of emailsByLink) {
      await notifyUsers(db, emails, {
        module: 'calendar',
        tag: 'Calendar',
        icon: 'ri-calendar-event-line',
        color: 'primary',
        title: `New event: ${entry.title}`,
        desc: `${req.session.user.name} scheduled "${entry.title}"${entry.location ? ' at ' + entry.location : ''}.`,
        link
      });
    }

    // Google Calendar sync (2026-08-02) — best-effort, alongside (not instead
    // of) the in-app notification above. Only attempted when there's a real
    // recipient list to invite; never blocks or fails the event's own save —
    // if the org hasn't connected Google Calendar, or the API call fails, the
    // CIPRMS event still exists exactly as it did before this feature.
    if (targetEmails.length) {
      const sync = await googleCalendarService.createGoogleEvent(db, entry, targetEmails);
      if (sync.ok) {
        await db.collection('calendarevents').updateOne({ id: entry.id }, { $set: { googleEventId: sync.googleEventId } });
        entry.googleEventId = sync.googleEventId;
      }
    }

    res.json({ success: true, event: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/calendarevents/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    await db.collection('calendarevents').updateOne({ id }, { $set: pickCalendarEventFields(req.body) });
    const updated = await db.collection('calendarevents').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Event not found.' });

    // Google Calendar sync — only events that were successfully created on
    // Google in the first place (i.e. have a googleEventId) get updated;
    // best-effort, same as create (see POST above). Uses googleAttendeeEmails
    // (the stable attendee list captured at creation), never recipientEmails
    // — the latter is absent entirely for "all users" events and would
    // otherwise silently wipe every attendee off the Google event.
    if (updated.googleEventId) {
      await googleCalendarService.updateGoogleEvent(db, updated, updated.googleAttendeeEmails);
    }

    res.json({ success: true, event: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/calendarevents/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const existing = await db.collection('calendarevents').findOne({ id });
    if (existing && existing.googleEventId) {
      await googleCalendarService.deleteGoogleEvent(db, existing.googleEventId);
    }
    await db.collection('calendarevents').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GOOGLE CALENDAR INTEGRATION (2026-08-02) ───────────────────────────────────
// A single, org-wide Google account (connected once by an Administrator) is
// used to create/update/delete calendar events — see
// services/googleCalendarService.js for the full rationale and
// docs/SYSTEM_AUDIT_2026-07-16.md for the architecture writeup. All four
// routes are requireAdmin, matching the existing POST/PATCH/DELETE
// /api/calendarevents gate: connecting/disconnecting the org's calendar
// integration is exactly as sensitive as creating events. This is fully
// independent of the passport-google-oauth20 *login* flow above (which
// discards its tokens) — it talks to googleapis's own OAuth2Client directly
// so it can capture and persist a refresh token.
function getGoogleCalendarCallbackUrl(req) {
  const host = req.get('host') || 'localhost:3000';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/api/google-calendar/callback`;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}/api/google-calendar/callback`;
}

app.get('/api/google-calendar/status', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const integration = await googleCalendarService.getIntegration(db);
    res.json(integration
      ? {
        connected: true,
        connectedByEmail: integration.connectedByEmail,
        connectedByName: integration.connectedByName,
        connectedAt: integration.connectedAt,
        lastSyncOk: integration.lastSyncOk === undefined ? null : integration.lastSyncOk,
        lastSyncError: integration.lastSyncError || null,
        lastSyncAt: integration.lastSyncAt || null
      }
      : { connected: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google-calendar/connect', requireAdmin, (req, res) => {
  // CSRF protection on the callback: a random state tied to this session,
  // checked (and consumed) below before any token exchange happens.
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleCalendarOAuthState = state;
  const url = googleCalendarService.getAuthUrl(getGoogleCalendarCallbackUrl(req), state);
  res.redirect(url);
});

app.get('/api/google-calendar/callback', requireAdmin, async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.googleCalendarOAuthState;
  delete req.session.googleCalendarOAuthState;

  if (error) return res.redirect('/admin/settings?googleCalendar=error');
  if (!code || !state || state !== expectedState) return res.redirect('/admin/settings?googleCalendar=error');

  try {
    const db = getDb();
    await googleCalendarService.handleOAuthCallback(db, code, getGoogleCalendarCallbackUrl(req), req.session.user);
    res.redirect('/admin/settings?googleCalendar=connected');
  } catch (err) {
    console.error('Google Calendar: OAuth callback failed:', err.message);
    res.redirect('/admin/settings?googleCalendar=error');
  }
});

app.post('/api/google-calendar/disconnect', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    await googleCalendarService.disconnect(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MONGO-BACKED PROFILE STORES ───────────────────────────────────────────────
// Admin profile GET
app.get('/api/admin/profile', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('profiles').findOne({ role: 'admin' });
    res.json(doc ? doc.profile : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin profile POST
app.post('/api/admin/profile', requireAdmin, async (req, res) => {
  const { name, email, dept, position, institution } = req.body;
  if (!name || !email || !dept || !position || !institution)
    return res.status(400).json({ error: 'Missing required fields.' });
  try {
    const db = getDb();
    await db.collection('profiles').updateOne(
      { role: 'admin' },
      { $set: { profile: { name, email, dept, position, institution } } },
      { upsert: true }
    );
    // Keep session email in sync
    req.session.user.email = email;
    req.session.user.name = name;
    res.json({ success: true, profile: { name, email, dept, position, institution } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin password POST
app.post('/api/admin/password', adminPasswordLimiter, requireAdmin, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — the profile form lets an
    // admin edit req.session.user.email without that change ever reaching the
    // users collection, which would otherwise make this lookup silently fail.
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Personnel profile GET
app.get('/api/personnel/profile', requirePersonnel, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('profiles').findOne({ role: 'personnel' });
    res.json(doc ? doc.profile : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Personnel profile POST
app.post('/api/personnel/profile', requirePersonnel, async (req, res) => {
  const { name, email, dept, position, institution } = req.body;
  if (!name || !email || !dept || !position || !institution)
    return res.status(400).json({ error: 'Missing required fields.' });
  try {
    const db = getDb();
    await db.collection('profiles').updateOne(
      { role: 'personnel' },
      { $set: { profile: { name, email, dept, position, institution } } },
      { upsert: true }
    );
    req.session.user.email = email;
    req.session.user.name = name;
    res.json({ success: true, profile: { name, email, dept, position, institution } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Personnel password POST
app.post('/api/personnel/password', personnelPasswordLimiter, requirePersonnel, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — the profile form lets personnel
    // edit req.session.user.email without that change ever reaching the users
    // collection, which would otherwise make this lookup silently fail.
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff profile GET (2026-08-27 View-Only → Staff migration — mirrors the
// Personnel profile store above exactly, keyed to its own 'staff' role doc).
app.get('/api/staff/profile', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('profiles').findOne({ role: 'staff' });
    res.json(doc ? doc.profile : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff profile POST
app.post('/api/staff/profile', requireStaffAccess, async (req, res) => {
  const { name, email, dept, position, institution } = req.body;
  if (!name || !email || !dept || !position || !institution)
    return res.status(400).json({ error: 'Missing required fields.' });
  try {
    const db = getDb();
    await db.collection('profiles').updateOne(
      { role: 'staff' },
      { $set: { profile: { name, email, dept, position, institution } } },
      { upsert: true }
    );
    req.session.user.email = email;
    req.session.user.name = name;
    res.json({ success: true, profile: { name, email, dept, position, institution } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff password POST
app.post('/api/staff/password', staffPasswordLimiter, requireStaffAccess, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — the profile form lets Staff
    // edit req.session.user.email without that change ever reaching the users
    // collection, which would otherwise make this lookup silently fail.
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INSTITUTION API PROXY ─────────────────────────────────────────────────────
app.get('/api/institutions', institutionsLimiter, async (req, res) => {
  const name = req.query.name || '';
  if (!name || name.trim().length < 2) {
    return res.json([]);
  }
  try {
    const http = require('http');
    const url = `http://universities.hipolabs.com/search?name=${encodeURIComponent(name.trim())}`;
    http.get(url, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed.slice(0, 15));
        } catch {
          res.json([]);
        }
      });
    }).on('error', () => res.json([]));
  } catch {
    res.json([]);
  }
});

// ── OCR (document upload → field extraction for the Partnership Registry) ────
// requireAuth (not requireUploader) — Staff's Partnership Request page uses
// this same OCR pipeline for its auto-fill upload. Safe to
// open beyond requireUploader's role set because every OCR job is
// per-uploader ownership-checked (see ocrController.status), unlike the
// Document Library routes above which stay on requireUploader deliberately.
app.use('/api/ocr', requireAuth, ocrRoutes);

// Every file OCR'd is archived here automatically — auth-gated since these
// are institutional partnership documents, not public assets.
// Ownership-checked file serving (not a blanket express.static): same
// OWN_SCOPE_ROLES boundary as GET /api/documents above, EXCEPT Administrator
// and Staff, who are deliberately exempted here — that own-scoping exists
// for the *Document Library browsing* experience (each role's own "My
// Documents"), but both reviewer roles (REQUEST_REVIEWER_ROLES, full parity
// as of 2026-08-27) also need to open/download every supporting document
// attached to Partnership/Document Requests during review, regardless of
// who uploaded it. Including a reviewer role in the ownership check here
// made every such file return 403 whenever the requester wasn't the
// reviewer themselves — i.e. always, since requesters are Auth.
// Personnel/potential_partner, never Administrator/Staff. Auth.
// Personnel/potential_partner remain restricted to their own uploads — they
// are never reviewers, so neither has a legitimate reason to open another
// user's file.
const SELF_UPLOAD_ONLY_ROLES = ['Auth. Personnel', 'potential_partner'];
app.get('/uploads/documents/:filename', requireUploader, async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ fileLink: '/uploads/documents/' + filename });
    if (SELF_UPLOAD_ONLY_ROLES.includes(req.session.user.role) && (!doc || doc.uploadedByEmail !== req.session.user.email)) {
      return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(__dirname, 'uploads', 'documents', filename), (err) => {
      if (err && !res.headersSent) res.status(404).send('Not found');
    });
  } catch (err) {
    res.status(500).send('Server error');
  }
});
app.use('/uploads/avatars', requireAuth, express.static(path.join(__dirname, 'uploads', 'avatars')));

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
// Shared by /dashboard (Administrator) and /staff/dashboard (Staff, 2026-08-27
// migration) — both render this same set of live counters/DSS insights, just
// into their own template with their own sidebar. Kept as one function so the
// two dashboards can never silently drift out of sync with each other.
async function computeDashboardStats(db) {
  const [allPartnerships, allRequests] = await Promise.all([
    db.collection('partnerships').find({}).toArray(),
    db.collection('requests').find({}).toArray()
  ]);

  // ── Stat counters ─────────────────────────────────────────────────────────
  const dashActive   = allPartnerships.filter(p => p.status === 'Active').length;
  const dashExpiring = allPartnerships.filter(p => p.status === 'Expiring Soon').length;
  const dashExpired  = allPartnerships.filter(p => p.status === 'Expired').length;
  const dashTotal    = allPartnerships.length;

  // ── Expiring / Expired table rows (up to 6, soonest first) ───────────────
  const expiringRows = allPartnerships
    .filter(p => p.status === 'Expiring Soon' || p.status === 'Expired')
    .sort((a, b) => new Date(a.end || a.endDate || 0) - new Date(b.end || b.endDate || 0))
    .slice(0, 6);

  // ── DSS: High Renewal Priority ────────────────────────────────────────────
  const expiringSoon = allPartnerships.filter(p => p.status === 'Expiring Soon');
  let insightRenewal;
  if (expiringSoon.length) {
    const soonest = expiringSoon.slice().sort((a, b) => new Date(a.end || a.endDate || 0) - new Date(b.end || b.endDate || 0))[0];
    const instName = soonest.inst || soonest.institution || 'an institution';
    insightRenewal = `${expiringSoon.length} partnership${expiringSoon.length > 1 ? 's' : ''} (including ${instName}) ${expiringSoon.length > 1 ? 'are' : 'is'} expiring within 90 days. Immediate action is recommended to maintain program continuity.`;
  } else {
    insightRenewal = 'No partnerships are currently expiring within the next 90 days.';
  }

  // ── DSS: Expansion Opportunity ────────────────────────────────────────────
  const openRequests = allRequests.filter(r => r.status === 'Pending' || r.status === 'Under Review');
  let insightExpansion;
  if (openRequests.length) {
    const byCountry = {};
    openRequests.forEach(r => { const c = r.country || 'an unspecified country'; byCountry[c] = (byCountry[c] || 0) + 1; });
    const [topCountry, topCount] = Object.entries(byCountry).sort((a, b) => b[1] - a[1])[0];
    insightExpansion = `${topCount} pending request${topCount > 1 ? 's' : ''} target${topCount > 1 ? '' : 's'} partnerships in ${topCountry}. Consider prioritizing this region for new agreements.`;
  } else {
    insightExpansion = 'No pending partnership requests at this time.';
  }

  // ── DSS: Resource Optimization ────────────────────────────────────────────
  const expiredList = allPartnerships.filter(p => p.status === 'Expired');
  let insightOptimization;
  if (expiredList.length) {
    insightOptimization = `${expiredList.length} expired partnership${expiredList.length > 1 ? 's have' : ' has'} not yet been renewed or archived. Consider reviewing ${expiredList.length > 1 ? 'these agreements' : 'this agreement'} to optimize resource allocation.`;
  } else {
    insightOptimization = 'No expired partnerships currently require review.';
  }

  return { dashActive, dashExpiring, dashExpired, dashTotal, expiringRows, insightRenewal, insightExpansion, insightOptimization };
}

app.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const stats = await computeDashboardStats(db);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      user: req.session.user,
      ...stats
    });
  } catch (err) {
    console.error('Dashboard render error:', err);
    // Fallback: render with empty/safe defaults so the page still loads
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      user: req.session.user,
      dashActive: 0, dashExpiring: 0, dashExpired: 0, dashTotal: 0,
      expiringRows: [],
      insightRenewal: 'Could not load renewal data.',
      insightExpansion: 'Could not load expansion data.',
      insightOptimization: 'Could not load optimization data.'
    });
  }
});

// Auth. Personnel access removed 2026-07-23 — Registry (Add/Edit/Delete
// partnerships) is no longer part of their responsibilities; Administrator-only.
app.get('/registry', requireAdmin, (req, res) => {
  res.render('administrator/registry', { activePage: 'registry', user: req.session.user });
});

app.get('/lifecycle', requirePersonnel, (req, res) => {
  res.render('administrator/lifecycle', { activePage: 'lifecycle', user: req.session.user });
});

// Administrator's own Notifications/Document Library pages. Auth. Personnel,
// potential_partner, and Staff all have their own dedicated, correctly-scoped
// equivalents (/personnel/notifications, /personnel/documents,
// /partner/notifications, /partner/documents, /staff/notifications,
// /staff/documents) — these bare routes are not a shared fallback for other
// roles, so requireAdmin (not requireAuth) keeps Staff/partner from ever
// landing on the Administrator's own sidebar.
app.get('/notifications', requireAdmin, (req, res) => {
  res.render('administrator/notifications', { activePage: 'notifications', user: req.session.user });
});

app.get('/documents', requireAdmin, (req, res) => {
  res.render('administrator/documents', { activePage: 'documents', user: req.session.user });
});

app.get('/calendar', requirePersonnel, (req, res) => {
  res.render('administrator/calendar', { activePage: 'calendar', user: req.session.user });
});

// Auth. Personnel access removed 2026-07-23 — Reports & Audit Trails are
// Administrator-only now (personnel had their own /personnel/reports page,
// also removed in the same change).
app.get('/reports', requireAdmin, (req, res) => {
  res.render('administrator/reports', { activePage: 'reports', user: req.session.user });
});

app.get('/users', requireAdmin, (req, res) => {
  res.render('users', { activePage: 'users', user: req.session.user });
});

// ── UNIFIED PARTNERSHIP REQUESTS PAGE ────────────────────────────────────────
app.get('/partnership-requests', requireAdmin, (req, res) => {
  res.render('administrator/partnership_requests', {
    activePage: 'access-requests',
    user: req.session.user
  });
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('administrator/admin_settings', {
    activePage: 'settings',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── AUTH. PERSONNEL ROUTES ────────────────────────────────────────────────────
app.get('/personnel/dashboard', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_dashboard', {
    activePage: 'dashboard',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/requests', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_requests', {
    activePage: 'requests',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

// Request tracking, moved off the Requests page (2026-07-25) to match the
// potential_partner Requests/Monitoring split — same /mine endpoints, no new
// backend routes needed.
app.get('/personnel/monitoring', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_monitoring', {
    activePage: 'monitoring',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/lifecycle', requirePersonnel, (req, res) => {
  res.render('administrator/lifecycle', {
    activePage: 'lifecycle',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/calendar', requirePersonnel, (req, res) => {
  res.render('administrator/calendar', {
    activePage: 'calendar',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/notifications', requirePersonnel, (req, res) => {
  res.render('administrator/notifications', {
    activePage: 'notifications',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/documents', requirePersonnel, (req, res) => {
  res.render('administrator/documents', {
    activePage: 'documents',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/settings', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_settings', {
    activePage: 'settings',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── STAFF ROUTES (2026-08-27 View-Only → Staff migration) ────────────────────
// Staff gets the same major modules as Administrator, minus destructive/
// security-sensitive actions (enforced server-side, not just hidden in the
// UI — see requireAdmin-only mutation routes throughout this file). Most
// pages below reuse the exact same shared Administrator templates via the
// sidebarPartial override, the same pattern already used for Auth. Personnel
// (see the personnel routes above) — Dashboard, Requests, and Settings get
// their own Staff-specific views instead, mirroring Personnel's equivalents.
app.get('/staff', requireStaffAccess, (req, res) => res.redirect('/staff/dashboard'));

// Staff uses the exact same Dashboard implementation as Administrator
// (2026-08-27 full-parity revision — no more duplicate staff_dashboard.ejs)
// — only the sidebarPartial and role-aware links inside admin_dashboard.ejs
// (isStaffRole) differ per role.
app.get('/staff/dashboard', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const stats = await computeDashboardStats(db);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      sidebarPartial: 'sidebar_staff',
      user: req.session.user,
      ...stats
    });
  } catch (err) {
    console.error('Staff dashboard render error:', err);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      sidebarPartial: 'sidebar_staff',
      user: req.session.user,
      dashActive: 0, dashExpiring: 0, dashExpired: 0, dashTotal: 0,
      expiringRows: [],
      insightRenewal: 'Could not load renewal data.',
      insightExpansion: 'Could not load expansion data.',
      insightOptimization: 'Could not load optimization data.'
    });
  }
});

app.get('/staff/calendar', requireStaffAccess, (req, res) => {
  res.render('administrator/calendar', {
    activePage: 'calendar',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// "Monitoring" — Partnership Lifecycle Monitoring, the same feature and
// template Administrator's own sidebar labels "Monitoring".
app.get('/staff/lifecycle', requireStaffAccess, (req, res) => {
  res.render('administrator/lifecycle', {
    activePage: 'lifecycle',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Requests — the same Administrator review page (partnership_requests.ejs
// role-gates its own Approve/Reject/Review actions to Administrator only).
// Staff sees a read-only "View" mode of their own submitted requests — as of
// 2026-08-27, Staff can no longer submit new Partnership or Document
// Requests at all (the "+ New Partnership Request" button and the
// staff_request_access.ejs form were removed; see requireRequester below,
// which already excludes Staff from every request-mutating route).
app.get('/staff/requests', requireStaffAccess, (req, res) => {
  res.render('administrator/partnership_requests', {
    activePage: 'access-requests',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Registry — view-only for Staff (registry.ejs role-gates Add/Edit/Delete to
// Administrator only); POST/PATCH/DELETE /api/partnerships stay
// requireAdmin-only regardless of what the UI shows.
app.get('/staff/registry', requireStaffAccess, (req, res) => {
  res.render('administrator/registry', {
    activePage: 'registry',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

app.get('/staff/documents', requireStaffAccess, (req, res) => {
  res.render('administrator/documents', {
    activePage: 'documents',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Reports & Analytics — Reports / Audit Trail / Strategic Insights (DSS) are
// all tabs within this one template. GET /api/activitylogs (the Audit Trail
// tab's data source) scopes Staff to their own records only — see that route.
app.get('/staff/reports', requireStaffAccess, (req, res) => {
  res.render('administrator/reports', {
    activePage: 'reports',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// User Management — view-only for Staff (users.ejs role-gates Add User/Edit/
// Deactivate to Administrator only); POST/PATCH/DELETE /api/users stay
// requireAdmin-only regardless of what the UI shows.
app.get('/staff/users', requireStaffAccess, (req, res) => {
  res.render('users', {
    activePage: 'users',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

app.get('/staff/notifications', requireStaffAccess, (req, res) => {
  res.render('administrator/notifications', {
    activePage: 'notifications',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

app.get('/staff/settings', requireStaffAccess, (req, res) => {
  res.render('staff/staff_settings', {
    activePage: 'settings',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── POTENTIAL PARTNER ROUTES ──────────────────────────────────────────────────
// External organizations applying for / managing an official partnership with CSPC.
app.get('/partner', requirePartner, (req, res) => res.redirect('/partner/dashboard'));

app.get('/partner/dashboard', requirePartner, (req, res) => {
  res.render('potential_partner/partner_dashboard', {
    activePage: 'dashboard', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/requests', requirePartner, (req, res) => {
  res.render('potential_partner/partner_requests', {
    activePage: 'requests', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/documents', requirePartner, (req, res) => {
  res.render('potential_partner/partner_documents', {
    activePage: 'documents', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/calendar', requirePartner, (req, res) => {
  res.render('potential_partner/partner_calendar', {
    activePage: 'calendar', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/monitoring', requirePartner, (req, res) => {
  res.render('potential_partner/partner_monitoring', {
    activePage: 'monitoring', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/notifications', requirePartner, (req, res) => {
  res.render('potential_partner/partner_notifications', {
    activePage: 'notifications', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/settings', requirePartner, (req, res) => {
  res.render('potential_partner/partner_settings', {
    activePage: 'settings', sidebarPartial: 'sidebar_partner', user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── PARTNER PROFILE / SETTINGS API ────────────────────────────────────────────
// Unlike the admin/personnel profile docs (keyed by `role` — shared by every
// user of that role), partner profiles are keyed by `email` since there can be
// many distinct partner organizations, each needing their own profile.
app.get('/api/partner/profile', requirePartner, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('profiles').findOne({ email: req.session.user.email });
    res.json(doc ? doc.profile : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/partner/profile', requirePartner, async (req, res) => {
  const { organization, contactName, contactNumber, address, notifyRequestUpdates, notifyApprovals, notifyDocuments, notifyMeetings, notifyRenewals } = req.body;
  try {
    const db = getDb();
    const profile = {
      organization: organization || '',
      contactName: contactName || '',
      email: req.session.user.email,
      contactNumber: contactNumber || '',
      address: address || '',
      notifyRequestUpdates: notifyRequestUpdates !== false,
      notifyApprovals: notifyApprovals !== false,
      notifyDocuments: notifyDocuments !== false,
      notifyMeetings: notifyMeetings !== false,
      notifyRenewals: notifyRenewals !== false
    };
    await db.collection('profiles').updateOne(
      { email: req.session.user.email },
      { $set: { email: req.session.user.email, profile } },
      { upsert: true }
    );
    if (contactName) {
      req.session.user.name = contactName;
      await db.collection('users').updateOne({ email: req.session.user.email }, { $set: { name: contactName, organization: organization || '' } });
    }
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/partner/password', partnerPasswordLimiter, requirePartner, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email, for the same reason as the
    // admin/personnel password routes — id never drifts from the session.
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/partner/avatar', requirePartner, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
    if (!verifyMagicBytes(req.file)) {
      return res.status(400).json({ error: 'Unsupported file type. Only JPG, JPEG, and PNG are accepted.' });
    }
    try {
      const db = getDb();
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;
      await db.collection('profiles').updateOne(
        { email: req.session.user.email },
        { $set: { email: req.session.user.email, 'profile.avatarUrl': avatarUrl } },
        { upsert: true }
      );
      res.json({ success: true, avatarUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send('<h2>404 — Page not found</h2><a href="/">Go home</a>');
});

// ── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
// Last-resort fallback for anything not already caught by a route's own
// try/catch — every route here already handles its own expected failure
// modes (validation errors, etc.) and returns its own message, so this only
// fires for genuinely unexpected failures (a throw outside any try/catch, or
// — since Express 5 auto-forwards rejected promises from async handlers to
// error middleware — an unhandled async rejection). Logs the real error
// server-side but never leaks it to the client, regardless of NODE_ENV
// (S13, Roadmap v2 Phase G4, docs/SYSTEM_AUDIT_2026-07-16.md).
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  if (res.headersSent) return next(err);
  const wantsJson = req.path.startsWith('/api/') || req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  } else {
    res.status(500).send('<h2>500 — Something went wrong</h2><a href="/">Go home</a>');
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
// Only actually bind/connect/open-a-browser when this file is run directly
// (`node cirl.js`) — not when required as a module (e.g. by the test suite),
// which just needs the bare `app` to drive with supertest against its own
// test-managed DB connection.
if (require.main === module) {
  app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`CIPRMS server running → ${url}`);
    try {
      await connectDB();
      await runLifecycleCheck(); // catch up immediately on startup, don't wait for the first interval tick
      setInterval(runLifecycleCheck, LIFECYCLE_CHECK_INTERVAL_MS);
    } catch (err) {
      console.error('❌ Failed to connect to MongoDB on startup:', err);
    }
    try {
      const { default: open } = await import('open');
      open(url);
    } catch (err) {
      console.log('Could not auto-open browser, but server is running');
    }
  });
}

module.exports = app;