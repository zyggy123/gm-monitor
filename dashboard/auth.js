// ============================================================================
// auth.js  —  AzerothCore Account Authentication
// Pluggable middleware for protecting the GM Monitor dashboard behind a login
// that requires an admin account (GM level >= 3).
//
// Usage (add to server.js):
//   const { initAuth, requireAdmin } = require('./auth');
//   initAuth(app);
//   app.use(requireAdmin);
//   // ...api routes...
//
// Dependencies:
//   npm install express-session passport passport-local
// ============================================================================

const crypto          = require('crypto');
const session         = require('express-session');
const passport        = require('passport');
const LocalStrategy   = require('passport-local').Strategy;
const mysql           = require('mysql2/promise');

// ---------------------------------------------------------------------------
// AzerothCore WotLK 3.3.5a password hashing
// sha_pass_hash = SHA1(UPPER(username) + ":" + UPPER(password))
// stored as uppercase hex in the `account` table
// ---------------------------------------------------------------------------
function acoreHash(username, password) {
    const input = username.toUpperCase() + ':' + password.toUpperCase();
    return crypto.createHash('sha1').update(input).digest('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// Check if an account has admin (gmlevel >= 3) on the given realm
// ---------------------------------------------------------------------------
async function isAdmin(pool, accountId, realmId) {
    const sql = `
        SELECT gmlevel FROM account_access
        WHERE id = ? AND (RealmID = ? OR RealmID = -1)
        ORDER BY RealmID DESC LIMIT 1
    `;
    const [rows] = await pool.query(sql, [accountId, realmId]);
    if (rows.length === 0) return false;

    // gmlevel values: 0=player, 1=moderator, 2=gm, 3=admin, 4=console
    return rows[0].gmlevel >= 3;
}

// ---------------------------------------------------------------------------
// Factory: creates and installs authentication middleware on an Express app
// ---------------------------------------------------------------------------
function initAuth(app, pool, opts = {}) {
    const realmId   = opts.realmId   || parseInt(process.env.REALM_ID, 10) || 0;
    const secret    = opts.secret    || process.env.SESSION_SECRET || 'change-me-' + Date.now();
    const loginPath = opts.loginPath || '/login';
    const homePath  = opts.homePath  || '/';

    // ---- Session ----
    app.use(session({
        secret,
        resave:            false,
        saveUninitialized: false,
        cookie:            { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
    }));

    // ---- Passport ----
    app.use(passport.initialize());
    app.use(passport.session());

    passport.use(new LocalStrategy(async function(username, password, done) {
        try {
            // 1. Look up the account by username
            const [rows] = await pool.query(
                'SELECT id, username, sha_pass_hash FROM account WHERE username = ?',
                [username]
            );
            if (rows.length === 0) return done(null, false, { message: 'Invalid account.' });

            const account = rows[0];

            // 2. Verify password against AzerothCore hash
            const hash = acoreHash(username, password);
            if (hash !== account.sha_pass_hash) {
                return done(null, false, { message: 'Wrong password.' });
            }

            // 3. Check admin rights (gmlevel >= 3)
            const admin = await isAdmin(pool, account.id, realmId);
            if (!admin) {
                return done(null, false, { message: 'This account does not have administrator access (requires GM level 3+).' });
            }

            return done(null, { id: account.id, username: account.username });
        } catch (err) {
            return done(err);
        }
    }));

    passport.serializeUser(function(user, done) {
        done(null, { id: user.id, username: user.username });
    });

    passport.deserializeUser(function(user, done) {
        done(null, user);
    });

    // ---- Login route (POST) ----
    app.post(loginPath, passport.authenticate('local', {
        successRedirect: homePath,
        failureRedirect: loginPath + '?error=1'
    }));

    // ---- Login page (GET) ----
    app.get(loginPath, (req, res) => {
        if (req.isAuthenticated()) return res.redirect(homePath);
        const error = req.query.error
            ? '<p style="color:#c41e3a;text-align:center;">Wrong credentials or insufficient rank (GM level 3+ required).</p>'
            : '';
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GM Monitor — Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0e0e10;color:#d4d4d4;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#1c1c24;border:1px solid #2a2a3a;border-top:3px solid #c41e3a;border-radius:8px;padding:36px 30px;width:360px;max-width:90vw}
.login-box h2{text-align:center;color:#c41e3a;margin-bottom:24px;font-size:1.2rem}
.login-box label{display:block;font-size:0.78rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px}
.login-box input{display:block;width:100%;padding:10px 12px;background:#0e0e10;border:1px solid #2a2a3a;border-radius:6px;color:#d4d4d4;font-size:0.95rem;margin-bottom:16px;transition:border-color 0.2s}
.login-box input:focus{outline:none;border-color:#c41e3a}
.login-box button{display:block;width:100%;padding:11px;background:#c41e3a;color:#fff;border:none;border-radius:6px;font-size:0.95rem;font-weight:600;cursor:pointer;transition:background 0.2s}
.login-box button:hover{background:#a01830}
.login-box .note{text-align:center;font-size:0.72rem;color:#555;margin-top:16px}
${error}
</style>
</head>
<body>
<div class="login-box">
<h2>GM Monitor</h2>
<form method="POST" action="${loginPath}">
<label>Username</label>
<input type="text" name="username" required autofocus>
<label>Password</label>
<input type="password" name="password" required>
<button type="submit">Login</button>
</form>
<div class="note">Admin account required (GM level 3+)</div>
${error}
</div>
</body>
</html>`);
    });

    // ---- Logout ----
    app.get('/logout', (req, res) => {
        req.logout(() => res.redirect(loginPath));
    });
}

// ---------------------------------------------------------------------------
// Middleware: blocks unauthenticated requests
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// ---------------------------------------------------------------------------
// Middleware: only protects API routes, leaves static pages open
// ---------------------------------------------------------------------------
function requireAdminAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Authentication required' });
}

module.exports = { initAuth, requireAdmin, requireAdminAPI, acoreHash, isAdmin };
