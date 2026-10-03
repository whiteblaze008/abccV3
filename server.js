const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(express.static('public'));

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const UPI_ID = '9313467169@ptsbi';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const HOLD_TIME = 900; // 15 minutes in seconds

// Initialize database
let db = {
  match: {
    date: 'Saturday, 10 October',
    time: '9:00 PM – 11:00 PM',
    venue: 'Bopal Cricket Ground',
    maps: '',
    startsAt: '',
    price: 250,
    max: 16,
    open: true
  },
  bookings: [],
  history: []
};

// Load existing data
try {
  const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db = { ...db, ...existing };
} catch (e) {
  // First run, use defaults
}

// Save data to file
const saveDB = () => {
  try {
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2));
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (error) {
    console.error('Save error:', error.message);
  }
};

// Utilities
const getAge = (booking) => (Date.now() - new Date(booking.at).getTime()) / 1000;
const isLive = (booking) => {
  if (booking.status === 'confirmed' || booking.status === 'pending') return true;
  if (booking.status === 'held' && getAge(booking) < HOLD_TIME) return true;
  return false;
};

const countPlayers = (filter) => {
  return db.bookings.filter(filter).reduce((sum, b) => sum + b.players, 0);
};

const getMatchInfo = () => {
  const confirmed = countPlayers(b => b.status === 'confirmed');
  const reserved = countPlayers(isLive);
  return {
    ...db.match,
    confirmed,
    reserved,
    left: Math.max(0, db.match.max - reserved)
  };
};

const formatBooking = (booking) => {
  const secs = Math.max(0, Math.floor(HOLD_TIME - getAge(booking)));
  return {
    id: booking.id,
    status: booking.status === 'held' && !secs ? 'expired' : booking.status,
    players: booking.players,
    amount: booking.amount,
    mobile: booking.mobile,
    name: booking.name,
    secs
  };
};

// Rate limiting
const rateLimits = {};
const checkRateLimit = (ip) => {
  const now = Date.now();
  rateLimits[ip] = (rateLimits[ip] || []).filter(t => now - t < 600000); // 10 minutes
  rateLimits[ip].push(now);
  return rateLimits[ip].length > 10; // Max 10 requests per 10 minutes
};

// Routes

// Get match info for player page
app.get('/api/match', (req, res) => {
  const recent = [...new Set(
    db.bookings
      .filter(b => b.status === 'confirmed' && b.name && b.name !== 'Player')
      .map(b => b.name.split(' ')[0])
  )].slice(-3);

  const totalPlayed = db.history.reduce((sum, h) => sum + h.players, 0);

  res.json({
    ...getMatchInfo(),
    upi: UPI_ID,
    recent,
    totalPlayed
  });
});

// Get single booking status
app.get('/api/booking/:id', (req, res) => {
  const booking = db.bookings.find(b => b.id === req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json(formatBooking(booking));
});

// Create new booking
app.post('/api/book', (req, res) => {
  if (checkRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { mobile, players, name } = req.body;
  const mobile_clean = String(mobile || '').trim();
  const players_num = parseInt(players, 10);
  const name_clean = String(name || '').trim().slice(0, 60) || 'Player';

  // Validation
  if (!/^[6-9]\d{9}$/.test(mobile_clean)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  }

  if (isNaN(players_num) || players_num < 1 || players_num > 16) {
    return res.status(400).json({ error: 'Invalid number of players.' });
  }

  if (!db.match.open) {
    return res.status(400).json({ error: 'Bookings closed for this match.' });
  }

  const available = db.match.max - countPlayers(isLive);
  if (players_num > available) {
    return res.status(400).json({
      error: available > 0
        ? `Only ${available} slot(s) available.`
        : 'This match is full.'
    });
  }

  // Create booking
  const bookingId = 'ABCC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const booking = {
    id: bookingId,
    mobile: mobile_clean,
    players: players_num,
    amount: players_num * db.match.price,
    name: name_clean,
    status: 'held',
    at: new Date().toISOString()
  };

  db.bookings.push(booking);
  saveDB();

  res.json(formatBooking(booking));
});

// Mark booking as paid
app.post('/api/paid', (req, res) => {
  const { id } = req.body;
  const booking = db.bookings.find(b => b.id === id);

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.status === 'held') {
    // Check if hold still valid
    if (!isLive(booking) && countPlayers(isLive) + booking.players > db.match.max) {
      return res.status(400).json({
        error: 'Hold expired. Please book again.'
      });
    }
    booking.status = 'pending';
    booking.paidAt = new Date().toISOString();
    saveDB();
  }

  res.json(formatBooking(booking));
});

// Cancel booking
app.post('/api/cancel', (req, res) => {
  const { id } = req.body;
  const booking = db.bookings.find(b => b.id === id);
  if (booking && booking.status === 'held') {
    booking.status = 'cancelled';
    saveDB();
  }
  res.json({ ok: true });
});

// Admin routes
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin'] || '';
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Get admin dashboard data
app.get('/api/admin', adminAuth, (req, res) => {
  const info = getMatchInfo();
  const pending = db.bookings.filter(b => b.status === 'pending');
  const confirmed = db.bookings.filter(b => b.status === 'confirmed');

  res.json({
    match: info,
    bookings: db.bookings.filter(b => b.status !== 'cancelled'),
    history: db.history,
    stats: {
      confirmed: confirmed.length,
      pending: pending.length,
      revenue: confirmed.reduce((sum, b) => sum + b.amount, 0)
    },
    weak: ADMIN_PASSWORD === 'changeme'
  });
});

// Update booking status
app.post('/api/admin/booking/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  const booking = db.bookings.find(b => b.id === req.params.id);

  if (!booking || !['confirmed', 'pending', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  booking.status = status;
  saveDB();
  res.json({ ok: true });
});

// Update match settings
app.post('/api/admin/match', adminAuth, (req, res) => {
  const { date, time, venue, maps, startsAt, price, max, open } = req.body;

  db.match = {
    date: date || db.match.date,
    time: time || db.match.time,
    venue: venue || db.match.venue,
    maps: maps || '',
    startsAt: startsAt || '',
    price: parseInt(price, 10) || db.match.price,
    max: parseInt(max, 10) || 16,
    open: !!open
  };

  saveDB();
  res.json({ ok: true });
});

// Archive current match and start new one
app.post('/api/admin/next', adminAuth, (req, res) => {
  const info = getMatchInfo();
  db.history.unshift({
    date: db.match.date,
    players: info.confirmed,
    revenue: info.confirmed * db.match.price
  });
  db.bookings = [];
  saveDB();
  res.json({ ok: true });
});

// Backup
app.get('/api/admin/backup', adminAuth, (req, res) => {
  res.json(db);
});

// Restore from backup
app.post('/api/admin/restore', adminAuth, (req, res) => {
  const backup = req.body;
  if (!backup || !backup.match || !Array.isArray(backup.bookings)) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }

  db = { ...backup, history: backup.history || [] };
  saveDB();
  res.json({ ok: true });
});

// Delete booking (admin only)
app.post('/api/admin/booking/:id/delete', adminAuth, (req, res) => {
  const index = db.bookings.findIndex(b => b.id === req.params.id);
  if (index > -1) {
    db.bookings.splice(index, 1);
    saveDB();
  }
  res.json({ ok: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ABCC V3 running on port ${PORT}`);
});
