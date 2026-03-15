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
  secret: 'lu1b3g13lu1b3g13', // Replace with a secure secret in production
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// ── PASSPORT CONFIG ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
    clientID: '691339229131-mp940eb5f19qq1kocotp7i0uh650k0vv.apps.googleusercontent.com', // Replace with your Google Client ID
    clientSecret: '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', // Replace with your Google Client Secret
    callbackURL: 'http://localhost:3000/auth/google/callback'
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
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  function(req, res) {
    // Successful authentication, redirect to dashboard.
    res.redirect('/dashboard');
  }
);

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
app.listen(PORT, () => {
    console.log(`CIPRMS server running → http://localhost:${PORT}`);
});