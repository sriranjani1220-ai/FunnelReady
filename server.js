require('dotenv').config({ path: '.env' });
const express = require('express');
const session = require('express-session');
const jsforce = require('jsforce');
const path = require('path');

const { runFullScan } = require('./scanner');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway (HTTPS behind reverse proxy)
app.set('trust proxy', 1);

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'funnel-ready-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// JSforce OAuth2 config
const oauth2 = new jsforce.OAuth2({
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_CALLBACK_URL
});

// Health check (no session needed)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' });
});

// --- Auth Routes ---

// Redirect user to Salesforce login
app.get('/oauth/login', (req, res) => {
  const authUrl = oauth2.getAuthorizationUrl({ scope: 'api refresh_token' });
  res.redirect(authUrl);
});

// Salesforce redirects back here with auth code
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const conn = new jsforce.Connection({ oauth2 });
    await conn.authorize(code);

    // Store credentials in session
    req.session.sf = {
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      instanceUrl: conn.instanceUrl
    };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// Logout - clear session
app.get('/oauth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// --- API Routes ---

// Check auth status
app.get('/api/status', (req, res) => {
  if (req.session.sf) {
    res.json({ connected: true, instanceUrl: req.session.sf.instanceUrl });
  } else {
    res.json({ connected: false });
  }
});

// Middleware: require Salesforce connection
function requireAuth(req, res, next) {
  if (!req.session.sf) {
    return res.status(401).json({ error: 'Not connected to Salesforce' });
  }
  // Rehydrate JSforce connection from session
  req.sfConn = new jsforce.Connection({
    oauth2,
    accessToken: req.session.sf.accessToken,
    refreshToken: req.session.sf.refreshToken,
    instanceUrl: req.session.sf.instanceUrl
  });
  next();
}

// Test endpoint: fetch org info
app.get('/api/org-info', requireAuth, async (req, res) => {
  try {
    const identity = await req.sfConn.identity();
    res.json({
      orgId: identity.organization_id,
      username: identity.username,
      displayName: identity.display_name
    });
  } catch (err) {
    console.error('Org info error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Scan endpoint — runs all 7 data quality checks
app.get('/api/scan', requireAuth, async (req, res) => {
  try {
    const results = await runFullScan(req.sfConn);
    res.json(results);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Scan failed: ' + err.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`FunnelReady running at http://localhost:${PORT}`);
});
