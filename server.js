// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();

// Create a PostgreSQL connection pool using the DATABASE_URL environment variable.
// For production on Render, you might need to enable SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});


// Initialize the database schema.
async function initDB() {
  try {
    // Create team_assignments table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_assignments (
        id SERIAL PRIMARY KEY,
        athlete_id TEXT UNIQUE NOT NULL,
        team_name TEXT NOT NULL
      )
    `);

    // Create athletes table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS athletes (
        id TEXT PRIMARY KEY,
        name TEXT,
        team TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT
      )
    `);

    // Create athlete_scores table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS athlete_scores (
        id SERIAL PRIMARY KEY,
        athlete_id TEXT REFERENCES athletes(id),
        week TEXT,
        swim NUMERIC,
        bike NUMERIC,
        run NUMERIC,
        total NUMERIC
      )
    `);
    console.log('Database initialized.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

initDB();

// Session setup.
app.use(session({
  secret: 'your_session_secret', // Replace with a strong secret in production
  resave: false,
  saveUninitialized: true,
}));

// Serve static files.
app.use(express.static(path.join(__dirname, 'public')));

// STRAVA OAuth credentials.
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/strava/callback';

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Initiate Strava OAuth.
app.get('/auth/strava', (req, res) => {
  const scope = 'activity:read_all,profile:read_all';
  const stravaAuthUrl = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}`;
  res.redirect(stravaAuthUrl);
});

// OAUTH CALLBACK: Upsert athlete and update scores.
app.get('/auth/strava/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided from Strava.');
  }
  try {
    const tokenResponse = await axios.post('https://www.strava.com/api/v3/oauth/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });
    const { access_token, refresh_token, expires_at, athlete } = tokenResponse.data;
    const athleteId = athlete.id.toString();

    // Lookup team assignment.
    const assignmentRes = await pool.query(
      `SELECT team_name FROM team_assignments WHERE athlete_id = $1`,
      [athleteId]
    );
    if (assignmentRes.rowCount === 0) {
      console.warn(`Athlete ${athleteId} is not assigned to any team.`);
      return res.status(400).send('Athlete does not have a predefined team assignment.');
    }
    const teamName = assignmentRes.rows[0].team_name;

    // Upsert athlete.
    const existingRes = await pool.query(`SELECT * FROM athletes WHERE id = $1`, [athleteId]);
    if (existingRes.rowCount === 0) {
      await pool.query(
        `INSERT INTO athletes (id, name, team, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [athleteId, `${athlete.firstname} ${athlete.lastname}`, teamName, access_token, refresh_token, expires_at]
      );
      // Fetch initial weekly scores.
      await updateAthleteScore(athleteId);
    } else {
      await pool.query(
        `UPDATE athletes SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE id = $4`,
        [access_token, refresh_token, expires_at, athleteId]
      );
    }

    // Set session.
    req.session.access_token = access_token;
    req.session.athlete = athlete;
    res.redirect('/leaderboard');
  } catch (error) {
    console.error('Error during OAuth callback:', error.response?.data || error.message);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

// Helper: Refresh token for an athlete using the DB.
async function refreshAthleteTokenDB(athlete) {
  const now = Math.floor(Date.now() / 1000);
  if (athlete.expires_at && athlete.expires_at > now) {
    return athlete.access_token;
  }
  try {
    const response = await axios.post('https://www.strava.com/api/v3/oauth/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: athlete.refresh_token
    });
    await pool.query(
      `UPDATE athletes SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE id = $4`,
      [response.data.access_token, response.data.refresh_token, response.data.expires_at, athlete.id]
    );
    return response.data.access_token;
  } catch (err) {
    console.error(`Error refreshing token for athlete ${athlete.id}:`, err.response?.data || err.message);
    throw new Error('Unable to refresh athlete token');
  }
}

// Function: Update athlete score (weekly breakdown) using PostgreSQL.
async function updateAthleteScore(athleteId) {
  const athleteRes = await pool.query(`SELECT * FROM athletes WHERE id = $1`, [athleteId]);
  if (athleteRes.rowCount === 0) {
    console.error(`Athlete ${athleteId} not found in athletes table.`);
    return;
  }
  const athlete = athleteRes.rows[0];
  const token = await refreshAthleteTokenDB(athlete);

  const weeks = [
    {
      label: 'Week 1 (10-16 March 2025)',
      after: Math.floor(new Date('2025-03-10T00:00:00Z').getTime() / 1000),
      before: Math.floor(new Date('2025-03-16T23:59:59Z').getTime() / 1000)
    },
    {
      label: 'Week 2 (17-23 March 2025)',
      after: Math.floor(new Date('2025-03-17T00:00:00Z').getTime() / 1000),
      before: Math.floor(new Date('2025-03-23T23:59:59Z').getTime() / 1000)
    },
    {
      label: 'Week 3 (24-30 March 2025)',
      after: Math.floor(new Date('2025-03-24T00:00:00Z').getTime() / 1000),
      before: Math.floor(new Date('2025-03-30T23:59:59Z').getTime() / 1000)
    },
    {
      label: 'Week 4 (31 March - 6 April 2025)',
      after: Math.floor(new Date('2025-03-31T00:00:00Z').getTime() / 1000),
      before: Math.floor(new Date('2025-04-06T23:59:59Z').getTime() / 1000)
    }
  ];

  // Delete existing scores for this athlete.
  await pool.query(`DELETE FROM athlete_scores WHERE athlete_id = $1`, [athleteId]);
  const now = Math.floor(Date.now() / 1000);
  for (const w of weeks) {
    let swimHours = 0, bikeHours = 0, runHours = 0;
    if (w.after <= now) {
      try {
        const response = await axios.get(
          `https://www.strava.com/api/v3/athlete/activities?after=${w.after}&before=${w.before}&per_page=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        response.data.forEach(activity => {
          const hours = activity.moving_time / 3600;
          if (activity.type === 'Swim') {
            swimHours += hours;
          } else if (activity.type === 'Ride' || activity.type === 'VirtualRide') {
            bikeHours += hours;
          } else if (activity.type === 'Run') {
            runHours += hours;
          }
        });
      } catch (error) {
        console.error(`Error fetching activities for ${w.label}:`, error.response?.data || error.message);
      }
    }
    const weightedSwim = swimHours * 2;
    const weightedBike = bikeHours * 0.65;
    const weightedRun = runHours;
    const weightedTotal = weightedSwim + weightedBike + weightedRun;
    await pool.query(
      `INSERT INTO athlete_scores (athlete_id, week, swim, bike, run, total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [athleteId, w.label, weightedSwim, weightedBike, weightedRun, weightedTotal]
    );
  }
  console.log(`Weekly scores updated for athlete ${athlete.name} (${athleteId}).`);
}

// ====================================
// API ENDPOINTS
// ====================================

// (A) Logged-in user's weekly totals.
app.get('/api/weekly-totals', async (req, res) => {
  if (!req.session.athlete) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const athleteId = req.session.athlete.id.toString();
  try {
    const result = await pool.query(
      `SELECT week, ROUND(swim, 2) AS swim, ROUND(bike, 2) AS bike, ROUND(run, 2) AS run, ROUND(total, 2) AS total
       FROM athlete_scores
       WHERE athlete_id = $1
       ORDER BY id ASC`,
      [athleteId]
    );
    if (result.rowCount > 0) {
      res.json(result.rows);
    } else {
      res.json({ message: 'No weekly stats available for this athlete.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving weekly totals.');
  }
});

// (B) Team details: Weekly breakdown for each athlete in a team.
app.get('/api/team/:teamName', async (req, res) => {
  const teamName = req.params.teamName;
  try {
    const athletesRes = await pool.query(`SELECT * FROM athletes WHERE team = $1`, [teamName]);
    const result = [];
    for (const athlete of athletesRes.rows) {
      const scoresRes = await pool.query(
        `SELECT week, ROUND(swim, 2) AS swim, ROUND(bike, 2) AS bike, ROUND(run, 2) AS run, ROUND(total, 2) AS total
         FROM athlete_scores
         WHERE athlete_id = $1
         ORDER BY id ASC`,
        [athlete.id]
      );
      let totalSwim = 0, totalBike = 0, totalRun = 0, totalOverall = 0;
      scoresRes.rows.forEach(row => {
        totalSwim += parseFloat(row.swim);
        totalBike += parseFloat(row.bike);
        totalRun += parseFloat(row.run);
        totalOverall += parseFloat(row.total);
      });
      result.push({
        name: athlete.name,
        weeks: scoresRes.rows,
        total: {
          swim: totalSwim.toFixed(2),
          bike: totalBike.toFixed(2),
          run: totalRun.toFixed(2),
          total: totalOverall.toFixed(2)
        }
      });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving team details.');
  }
});

// (C) Team leaderboard: Retrieve all teams from team_assignments, group them, and show how many are left to connect per team.
app.get('/api/leaderboard', async (req, res) => {
  try {
    // Total assigned per team.
    const teamTotalsRes = await pool.query(`
      SELECT team_name, COUNT(*) AS total_assigned
      FROM team_assignments
      GROUP BY team_name
    `);
    // Aggregated connected athletes per team.
    const connectedRes = await pool.query(`
      SELECT a.team AS team,
             COUNT(DISTINCT s.athlete_id) AS total_connected,
             ROUND(SUM(s.swim), 2) AS swim,
             ROUND(SUM(s.bike), 2) AS bike,
             ROUND(SUM(s.run), 2) AS run,
             ROUND(SUM(s.total), 2) AS total
      FROM athlete_scores s
      JOIN athletes a ON s.athlete_id = a.id
      GROUP BY a.team
    `);
    const teamTotals = teamTotalsRes.rows;
    const connected = connectedRes.rows;
    const connectedMap = {};
    connected.forEach(row => {
      connectedMap[row.team] = row;
    });
    const leaderboard = teamTotals.map(tt => {
      const teamName = tt.team_name;
      const connectedData = connectedMap[teamName] || { total_connected: 0, swim: 0, bike: 0, run: 0, total: 0 };
      const leftToConnect = tt.total_assigned - connectedData.total_connected;
      return {
        team: teamName,
        swim: parseFloat(connectedData.swim).toFixed(2),
        bike: parseFloat(connectedData.bike).toFixed(2),
        run: parseFloat(connectedData.run).toFixed(2),
        total: parseFloat(connectedData.total).toFixed(2),
        left_to_connect: leftToConnect
      };
    });
    // Sort leaderboard highest to lowest by total.
    leaderboard.sort((a, b) => parseFloat(b.total) - parseFloat(a.total));
    res.json({ leaderboard });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving leaderboard.');
  }
});

// ====================================
// 10) SERVE THE LEADERBOARD HTML PAGE
// ====================================
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'leaderboard.html'));
});

// Temporary endpoint for manual update of all athletes
app.get('/updateAllAthletes', async (req, res) => {
  try {
    const athletes = db.prepare('SELECT id FROM athletes').all();
    for (const athlete of athletes) {
      try {
        await updateAthleteScore(athlete.id);
        console.log(`Updated athlete ${athlete.id}`);
      } catch (err) {
        console.error(`Error updating athlete ${athlete.id}:`, err);
      }
    }
    res.send('All athletes updated successfully.');
  } catch (err) {
    console.error('Error during manual update:', err);
    res.status(500).send('Error updating athletes.');
  }
});

// ====================================
// 11) START THE SERVER
// ====================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



// Schedule the job to run every hour (at minute 0)
cron.schedule('0 * * * *', async () => {
  console.log('Cron job started: updating all athletes scores...');
  try {
    // Get all athletes from the database
    const athletes = db.prepare('SELECT id FROM athletes').all();
    for (const athlete of athletes) {
      try {
        await updateAthleteScore(athlete.id);
        console.log(`Updated athlete ${athlete.id}`);
      } catch (err) {
        console.error(`Error updating athlete ${athlete.id}:`, err);
      }
    }
    console.log('Cron job finished: all athletes updated.');
  } catch (err) {
    console.error('Error in cron job:', err);
  }
});