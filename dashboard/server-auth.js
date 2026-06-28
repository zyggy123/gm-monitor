// ============================================================================
// server-auth.js  —  GM Monitor with AC Account Authentication
//
// Same as server.js, but protected behind a login that validates against
// your AzerothCore auth database. Only GM level 3+ accounts can access.
//
// Install:  npm install express-session passport passport-local
// Run:      node server-auth.js
// ============================================================================

require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const path    = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DB_HOST      = process.env.DB_HOST      || '127.0.0.1';
const DB_USER      = process.env.DB_USER      || 'root';
const DB_PASS      = process.env.DB_PASSWORD  || '';
const DB_NAME      = process.env.DB_NAME      || 'auth';
const WORLD_DB     = process.env.WORLD_DB_NAME || 'acore_world';
const PORT         = parseInt(process.env.PORT, 10) || 3000;
const PAGE_SIZE    = parseInt(process.env.PAGE_SIZE, 10) || 25;
const REALM_ID     = parseInt(process.env.REALM_ID, 10) || 0;

const ALLOWED_ORDER_BY = new Set(['id', 'account_id', 'character_name', 'command_text', 'execution_time']);
const ALLOWED_ORDER_DIR = new Set(['ASC', 'DESC']);

// ---------------------------------------------------------------------------
// DB pools
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
    host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
    waitForConnections: true, connectionLimit: 5, queueLimit: 0, charset: 'utf8mb4'
});
const worldPool = mysql.createPool({
    host: DB_HOST, user: DB_USER, password: DB_PASS, database: WORLD_DB,
    waitForConnections: true, connectionLimit: 3, queueLimit: 0, charset: 'utf8mb4'
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// ---- CORS ----
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
    res.header('Access-Control-Allow-Methods', 'GET');
    next();
});

// ---- Rate limiter ----
const rateLimitMap = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (entry && now - entry.windowStart < 60_000) {
        entry.count++;
        if (entry.count > 100) return res.status(429).json({ error: 'Too many requests' });
    } else {
        rateLimitMap.set(ip, { windowStart: now, count: 1 });
    }
    next();
});

app.use(express.json());

// ===================================================================
// AUTHENTICATION — protect dashboard with AC accounts (GM level 3+)
// ===================================================================
const { initAuth, requireAdmin } = require('./auth');
initAuth(app, pool, { realmId: REALM_ID });
app.use(requireAdmin);

// ===================================================================
// API routes (protected)
// ===================================================================
app.get('/api/logs', async (req, res) => {
    try {
        const { search, type, page, sort, dir } = req.query;
        const searchTerm  = (search || '').trim();
        const typeFilter   = (type || '').trim();
        const pageNum      = Math.max(parseInt(page, 10) || 1, 1);
        const sortCol      = ALLOWED_ORDER_BY.has(sort) ? sort : 'execution_time';
        const sortDir      = ALLOWED_ORDER_DIR.has((dir || '').toUpperCase()) ? dir.toUpperCase() : 'DESC';
        const searchPattern = `%${searchTerm}%`;
        const typePattern   = typeFilter ? `${typeFilter}%` : '%';
        const offset        = (pageNum - 1) * PAGE_SIZE;

        const sqlData = `
            SELECT id, account_id, character_name, command_text, execution_time
            FROM custom_gm_action_logs
            WHERE (character_name LIKE ? OR command_text LIKE ?) AND command_text LIKE ?
            ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?
        `;
        const sqlCount = `
            SELECT COUNT(*) AS total FROM custom_gm_action_logs
            WHERE (character_name LIKE ? OR command_text LIKE ?) AND command_text LIKE ?
        `;
        const [rows, [countRow]] = await Promise.all([
            pool.query(sqlData,  [searchPattern, searchPattern, typePattern, PAGE_SIZE, offset]),
            pool.query(sqlCount, [searchPattern, searchPattern, typePattern])
        ]);
        res.json({
            data: rows[0], total: countRow[0].total, page: pageNum,
            pageSize: PAGE_SIZE, totalPages: Math.ceil(countRow[0].total / PAGE_SIZE),
            search: searchTerm, type: typeFilter, sort: sortCol, dir: sortDir
        });
    } catch (err) {
        console.error('/api/logs error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const QUERIES = {
            total: 'SELECT COUNT(*) AS cnt FROM custom_gm_action_logs',
            today: 'SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE execution_time >= CURDATE()',
            additem: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'additem%'",
            modifySpeed: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'modify speed%'",
            modifyMoney: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'modify money%'",
            sendItems: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'send items%'",
            learn: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'learn%'",
            setskill: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'setskill%'",
            npcAdd: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'npc add%'",
            tele: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'tele%'",
            revive: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'revive%'",
            level: "SELECT COUNT(*) AS cnt FROM custom_gm_action_logs WHERE command_text LIKE 'level%'"
        };
        const results = {};
        for (const [key, sql] of Object.entries(QUERIES)) {
            const [rows] = await pool.query(sql);
            results[key] = rows[0].cnt;
        }
        res.json(results);
    } catch (err) {
        console.error('/api/stats error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/items/batch', async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
        if (ids.length === 0) return res.json({});
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await worldPool.query(
            `SELECT entry, name FROM item_template WHERE entry IN (${placeholders})`, ids
        );
        const result = {};
        rows.forEach(r => { result[r.entry] = r.name; });
        res.json(result);
    } catch (err) {
        console.error('/api/items/batch error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ===================================================================
// Start
// ===================================================================
app.listen(PORT, () => {
    console.log(`[GM Monitor] Protected dashboard at http://localhost:${PORT}`);
});
