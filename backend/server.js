const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const dbPath = path.join(__dirname, 'telemetry.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database.');
    db.run(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        action TEXT NOT NULL,
        problemsSynced INTEGER DEFAULT 0,
        version TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
});

// Telemetry collection endpoint
app.post('/api/telemetry', (req, res) => {
  const { owner, repo, action, problemsSynced, version } = req.body;

  if (!owner || !repo || !action) {
    return res.status(400).json({ error: 'Missing required telemetry fields.' });
  }

  const query = `
    INSERT INTO telemetry (owner, repo, action, problemsSynced, version)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(query, [owner, repo, action, problemsSynced || 0, version || 'unknown'], function(err) {
    if (err) {
      console.error('Database write error:', err);
      return res.status(500).json({ error: 'Database write error.' });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// Summary Stats Endpoint
app.get('/api/stats', (req, res) => {
  const statsQuery = `
    SELECT 
      COUNT(DISTINCT owner) as totalUsers,
      COUNT(id) as totalSyncs,
      SUM(problemsSynced) as totalProblemsSynced
    FROM telemetry
  `;
  db.get(statsQuery, (err, row) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Database query error.' });
    }
    res.json({
      totalUsers: row.totalUsers || 0,
      totalSyncs: row.totalSyncs || 0,
      totalProblemsSynced: row.totalProblemsSynced || 0
    });
  });
});

// List Logs Endpoint
app.get('/api/logs', (req, res) => {
  const query = `
    SELECT owner, repo, action, problemsSynced, version, timestamp 
    FROM telemetry 
    ORDER BY timestamp DESC 
    LIMIT 200
  `;
  db.all(query, (err, rows) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Database query error.' });
    }
    res.json(rows);
  });
});

app.listen(PORT, () => {
  console.log(`LeetSync telemetry server listening on http://localhost:${PORT}`);
});
