require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const PORT = 3000;

// ── VIEW ENGINE ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: '130fbe881d6eec6c8f29d4624839d2a5436802bf79d235252e9337facb72d2de', // Replace with a secure secret in production
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// ── PASSPORT CONFIG ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET
    // callbackURL removed - will be set dynamically per request
  },
  function(accessToken, refreshToken, profile, done) {
    // For simplicity, return the profile. In production, save to database.
    return done(null, profile);
  }
));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.render('index', { activePage: 'home' });
});

app.get('/login', (req, res) => {
    res.render('login', { activePage: '' });
});

app.get('/signup', (req, res) => {
    res.render('signup', { activePage: '' });
});

// ── GOOGLE AUTH ROUTES ───────────────────────────────────────────────────────

function getCallbackUrl(req) {
  // Get the current host from the request
  const host = req.get('host') || 'localhost:3000';

  // If accessing via localhost, use localhost callback
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/auth/google/callback`;
  }

  // If accessing via ngrok or other external host, use that host
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
  console.log(`[CALLBACK] Received callback with URL: ${callbackUrl}`);
  
  passport.authenticate('google', {
    failureRedirect: '/login',
    callbackURL: callbackUrl
  }, function(err, user, info) {
    if (err) {
      console.error('❌ OAuth Error:', err.message);
      console.error('Full error:', err);
      return next(err);
    }
    if (!user) {
      console.warn('⚠️  No user returned from OAuth');
      return res.redirect('/login');
    }
    console.log('✓ User authenticated:', user.displayName);
    req.logIn(user, function(err) {
      if (err) {
        console.error('❌ Login error:', err);
        return next(err);
      }
      console.log('✓ Session created for user:', user.displayName);
      return res.redirect('/dashboard');
    });
  })(req, res, next);
});


// ── API ENDPOINTS FOR DYNAMIC DATA ──────────────────────────────────────
app.get('/api/dashboard/stats', (req, res) => {
  // Mock dashboard statistics - replace with real data from database
  const stats = {
    totalPartnerships: 28,
    activePartnerships: 22,
    expiringPartnerships: 4,
    expiredPartnerships: 2,
    totalRequests: 15,
    pendingRequests: 8,
    approvedRequests: 5,
    rejectedRequests: 2,
    countries: 8,
    institutions: 28
  };
  res.json(stats);
});

app.get('/api/partnerships', (req, res) => {
  // Partnership data - same as in dashboard but served via API
  const partnerships = [
    // Philippines (Local)
    { name: 'CSPC - Main Campus', institution: 'Camarines Sur Polytechnic Colleges', lat: 13.6234, lng: 123.1945, country: 'Philippines', type: 'MOA', status: 'active' },
    { name: 'De La Salle University', institution: 'De La Salle University', lat: 14.5627, lng: 120.9930, country: 'Philippines', type: 'MOA', status: 'active' },
    { name: 'Ateneo de Manila University', institution: 'Ateneo de Manila University', lat: 14.6407, lng: 121.0778, country: 'Philippines', type: 'MOA', status: 'active' },
    { name: 'University of Santo Tomas', institution: 'University of Santo Tomas', lat: 14.6096, lng: 120.9895, country: 'Philippines', type: 'MOU', status: 'active' },
    { name: 'Bicol University', institution: 'Bicol University', lat: 13.1391, lng: 123.7438, country: 'Philippines', type: 'MOA', status: 'expiring' },
    { name: 'Partido State University', institution: 'Partido State University', lat: 13.7791, lng: 123.7416, country: 'Philippines', type: 'MOU', status: 'active' },

    // Japan
    { name: 'Osaka University Partnership', institution: 'Osaka University', lat: 34.8219, lng: 135.5235, country: 'Japan', type: 'MOA', status: 'active' },
    { name: 'University of Tokyo MOU', institution: 'University of Tokyo', lat: 35.7127, lng: 139.7613, country: 'Japan', type: 'MOU', status: 'active' },
    { name: 'Kyoto University', institution: 'Kyoto University', lat: 35.0261, lng: 135.7804, country: 'Japan', type: 'MOU', status: 'active' },
    { name: 'Tohoku University', institution: 'Tohoku University', lat: 38.2558, lng: 140.8421, country: 'Japan', type: 'MOA', status: 'expiring' },
    { name: 'Nagoya University', institution: 'Nagoya University', lat: 35.1569, lng: 136.9237, country: 'Japan', type: 'MOA', status: 'active' },

    // South Korea
    { name: 'Seoul National University', institution: 'Seoul National University', lat: 37.4601, lng: 126.9522, country: 'South Korea', type: 'MOU', status: 'active' },
    { name: 'KAIST', institution: 'Korea Advanced Inst. of Science', lat: 36.3715, lng: 127.3614, country: 'South Korea', type: 'MOU', status: 'active' },
    { name: 'Yonsei University', institution: 'Yonsei University', lat: 37.5641, lng: 126.9381, country: 'South Korea', type: 'MOA', status: 'expiring' },

    // United States
    { name: 'MIT Partnership', institution: 'Massachusetts Institute of Technology', lat: 42.3601, lng: -71.0942, country: 'USA', type: 'MOA', status: 'active' },
    { name: 'University of California', institution: 'University of California, Berkeley', lat: 37.8724, lng: -122.2595, country: 'USA', type: 'MOU', status: 'active' },
    { name: 'Harvard University', institution: 'Harvard University', lat: 42.3770, lng: -71.1167, country: 'USA', type: 'MOA', status: 'expired' },
    { name: 'Stanford University', institution: 'Stanford University', lat: 37.4275, lng: -122.1697, country: 'USA', type: 'MOU', status: 'active' },

    // Australia
    { name: 'University of Melbourne', institution: 'University of Melbourne', lat: -37.7963, lng: 144.9614, country: 'Australia', type: 'MOU', status: 'expiring' },
    { name: 'Australia National University', institution: 'Australian National University', lat: -35.2777, lng: 149.1185, country: 'Australia', type: 'MOA', status: 'active' },

    // China
    { name: 'Tsinghua University', institution: 'Tsinghua University', lat: 40.0022, lng: 116.3260, country: 'China', type: 'MOU', status: 'active' },
    { name: 'Peking University', institution: 'Peking University', lat: 39.9993, lng: 116.3073, country: 'China', type: 'MOA', status: 'active' },
    { name: 'Fudan University', institution: 'Fudan University', lat: 31.2986, lng: 121.5032, country: 'China', type: 'MOU', status: 'expired' },

    // Germany
    { name: 'Technical University Munich', institution: 'Technical University of Munich', lat: 48.1499, lng: 11.5680, country: 'Germany', type: 'MOU', status: 'active' },
    { name: 'Heidelberg University', institution: 'Heidelberg University', lat: 49.4083, lng: 8.6939, country: 'Germany', type: 'MOA', status: 'active' },
  ];
  res.json(partnerships);
});

app.get('/api/requests', (req, res) => {
  // Mock requests data
  const requests = [
    { id: 1, title: 'Student Exchange Program', institution: 'University of Tokyo', status: 'pending', date: '2024-03-15', type: 'exchange' },
    { id: 2, title: 'Research Collaboration', institution: 'MIT', status: 'approved', date: '2024-03-10', type: 'research' },
    { id: 3, title: 'Faculty Development', institution: 'Seoul National University', status: 'pending', date: '2024-03-08', type: 'training' },
    { id: 4, title: 'Joint Degree Program', institution: 'University of Melbourne', status: 'rejected', date: '2024-03-05', type: 'academic' },
    { id: 5, title: 'Cultural Exchange', institution: 'Peking University', status: 'approved', date: '2024-03-01', type: 'cultural' },
  ];
  res.json(requests);
});

app.get('/api/notifications', (req, res) => {
  // Mock notifications data
  const notifications = [
    { id: 1, color: '#b91c1c', text: 'Ateneo MOA expires in 12 days', time: 'Today', read: false },
    { id: 2, color: '#d97706', text: 'Osaka MOU — 21 days remaining', time: 'Today', read: false },
    { id: 3, color: '#1e40af', text: 'REQ-2026-011 submitted by Dr. Santos', time: 'Mar 8, 2026', read: false },
    { id: 4, color: '#15803d', text: 'REQ-2026-009 approved by Admin Rivera', time: 'Mar 2, 2026', read: true },
    { id: 5, color: '#b91c1c', text: 'TESDA Region V MOA has expired', time: 'Jan 2, 2025', read: true },
  ];
  res.json(notifications);
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    res.render('admin_dashboard', { activePage: 'dashboard' }); // view: admin_dashboard.ejs
});

app.get('/registry', (req, res) => {
    res.render('registry', { activePage: 'registry' });
});

app.get('/requests', (req, res) => {
    res.render('requests', { activePage: 'requests' });
});

app.get('/lifecycle', (req, res) => {
    res.render('lifecycle', { activePage: 'lifecycle' });
});

app.get('/notifications', (req, res) => {
    res.render('notifications', { activePage: 'notifications' });
});

app.get('/calendar', (req, res) => {
    res.render('calendar', { activePage: 'calendar' });
});

app.get('/reports', (req, res) => {
    res.render('reports', { activePage: 'reports' });
});

app.get('/users', (req, res) => {
    res.render('users', { activePage: 'users' });
});

// ── FORM POSTS ────────────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log('Login attempt:', username);
    // TODO: validate credentials
    res.redirect('/dashboard');
});

app.post('/signup', (req, res) => {
    const { username, password, confirm } = req.body;
    if (password !== confirm) {
        return res.render('signup', { activePage: '', error: 'Passwords do not match.' });
    }
    console.log('New user:', username);
    res.redirect('/login');
});

// ── INSTITUTION API PROXY ─────────────────────────────────────────────────────
// Proxies requests to the Hipolabs Universities API (server-to-server)
// to avoid CORS/mixed-content issues in the browser.
app.get('/api/institutions', async (req, res) => {
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
                    res.json(parsed.slice(0, 15)); // return up to 15 results
                } catch {
                    res.json([]);
                }
            });
        }).on('error', () => res.json([]));
    } catch {
        res.json([]);
    }
});

// ── LOGOUT ────────────────────────────────────────────────────────────────────
app.get('/logout', (req, res) => {
    // Destroy session if one exists (future-proofing for express-session)
    if (req.session && typeof req.session.destroy === 'function') {
        req.session.destroy(() => res.redirect('/login'));
    } else {
        res.redirect('/login');
    }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).send('<h2>404 — Page not found</h2><a href="/">Go home</a>');
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`CIPRMS server running → ${url}`);
    // Auto-open browser for localhost testing
    try {
      const { default: open } = await import('open');
      open(url);
    } catch (err) {
      console.log('Could not auto-open browser, but server is running');
    }
});