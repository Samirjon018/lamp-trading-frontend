const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = 'lamp_trading_super_secret_key_2026';

// 1. MONGODB SXEMASI (Foydalanuvchi, Pozitsiyalar va Tarix)
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 10000.00 },
  positions: [{
    id: String,
    pair: String,
    type: String, // 'BUY' yoki 'SELL'
    amount: Number,
    leverage: Number,
    entryPrice: Number,
    createdAt: { type: Date, default: Date.now }
  }],
  tradeHistory: [{
    pair: String,
    type: String,
    amount: Number,
    entryPrice: Number,
    closePrice: Number,
    pnl: Number,
    closedAt: { type: Date, default: Date.now }
  }]
});

const User = mongoose.model('User', UserSchema);

// MongoDB Ulanishi
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lamp_trading';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB bazasiga ulanish muvaffaqiyatli!'))
  .catch(err => console.log('⚠️ MongoDB ulanishida xatolik:', err.message));

// XAVFSIZLIK MIDDLEWARE (JWT Token tekshirish)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Token topilmadi, iltimos qayta kiring" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token yaroqsiz" });
    req.user = user;
    next();
  });
};

// 2. AUTHENTICATION & PROFIL API

// Ro'yxatdan o'tish
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Ma'lumotlar to'liq emas!" });

    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: "Bu nom allaqachon band!" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();

    res.json({ message: "Muvaffaqiyatli ro'yxatdan o'tildi!" });
  } catch (err) {
    res.status(500).json({ error: "Server xatosi" });
  }
});

// Kirish (Login)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: "Foydalanuvchi topilmadi!" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Parol noto'g'ri!" });

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);
    res.json({
      token,
      user: {
        username: user.username,
        balance: user.balance,
        positions: user.positions,
        tradeHistory: user.tradeHistory
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Server xatosi" });
  }
});

// Profil ma'lumotlarini olish
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Profilni yuklashda xatolik" });
  }
});

// Parolni o'zgartirish
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: "Eski parol noto'g'ri!" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Parol muvaffaqiyatli o'zgartirildi!" });
  } catch (err) {
    res.status(500).json({ error: "Server xatosi" });
  }
});

// 3. TRADING API (BUY, SELL & CLOSE POSITION)

let livePrices = { BTC: 65000.00, ETH: 3500.00, SOL: 145.00 };

// Pozitsiya ochish (BUY / SELL)
app.post('/api/trade/open', authenticateToken, async (req, res) => {
  try {
    const { pair, type, amount, leverage } = req.body;
    const user = await User.findById(req.user.id);

    if (user.balance < amount) {
      return res.status(400).json({ error: "Mablag' yetarli emas!" });
    }

    const currentPrice = livePrices[pair];
    if (!currentPrice) return res.status(400).json({ error: "Noto'g'ri juftlik!" });

    const newPosition = {
      id: Date.now().toString(),
      pair,
      type,
      amount,
      leverage,
      entryPrice: currentPrice,
      createdAt: new Date()
    };

    user.balance -= amount; // Garov summasini balansdan ayirish
    user.positions.push(newPosition);
    await user.save();

    res.json({ message: "Pozitsiya ochildi!", balance: user.balance, positions: user.positions });
  } catch (err) {
    res.status(500).json({ error: "Savdo amalga oshmadi" });
  }
});

// Pozitsiyani yopish
app.post('/api/trade/close', authenticateToken, async (req, res) => {
  try {
    const { positionId } = req.body;
    const user = await User.findById(req.user.id);

    const posIndex = user.positions.findIndex(p => p.id === positionId);
    if (posIndex === -1) return res.status(404).json({ error: "Pozitsiya topilmadi!" });

    const pos = user.positions[posIndex];
    const closePrice = livePrices[pos.pair];

    // PnL (Foyda/Zarar) hisoblash
    let pnl = 0;
    const priceChangeRatio = (closePrice - pos.entryPrice) / pos.entryPrice;
    
    if (pos.type === 'BUY') {
      pnl = pos.amount * pos.leverage * priceChangeRatio;
    } else {
      pnl = pos.amount * pos.leverage * (-priceChangeRatio);
    }

    const returnAmount = pos.amount + pnl;
    user.balance += (returnAmount > 0 ? returnAmount : 0); // Agar tugamagan bolsa qolganini qaytarish

    // Tarixga saqlash
    user.tradeHistory.push({
      pair: pos.pair,
      type: pos.type,
      amount: pos.amount,
      entryPrice: pos.entryPrice,
      closePrice: closePrice,
      pnl: pnl,
      closedAt: new Date()
    });

    // Active pozitsiyalardan o'chirish
    user.positions.splice(posIndex, 1);
    await user.save();

    res.json({ message: "Pozitsiya yopildi!", balance: user.balance, positions: user.positions, history: user.tradeHistory });
  } catch (err) {
    res.status(500).json({ error: "Pozitsiyani yopishda xatolik" });
  }
});

// 4. WEBSOCKET REAL-TIME TRADING ENGINE
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

setInterval(() => {
  Object.keys(livePrices).forEach(pair => {
    let delta = (Math.random() - 0.48) * (livePrices[pair] * 0.001);
    livePrices[pair] += delta;
  });

  const data = JSON.stringify({ type: 'PRICE_UPDATE', prices: livePrices });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}, 500);

wss.on('connection', (ws) => {
  console.log('⚡ Yangi foydalanuvchi WebSocket-ga ulandi');
  ws.send(JSON.stringify({ type: 'PRICE_UPDATE', prices: livePrices }));
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`🚀 Yangilangan Backend Server http://localhost:${PORT} portida tayyor!`);
});
