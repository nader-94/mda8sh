// =====================================================
// مداقش - خادم Render (يدعم CORS للاتصال من Netlify)
// =====================================================
'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const room = require('./game/room');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mda8sh-backend' });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>مداقش - الخادم</title></head>
<body style="font-family:sans-serif;text-align:center;padding:3rem;background:#0a0f1a;color:#f0e8d0">
  <h1 style="color:#c9a84c">🎮 خادم لعبة مداقش يعمل بنجاح</h1>
  <p style="color:#aaa">انسخ رابط هذا الخادم والصقه في واجهة اللعبة على Netlify.</p>
</body>
</html>`);
});

io.on('connection', (socket) => {
  console.log(`[+] اتصال: ${socket.id}`);

  const safeCb = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('create_room', (payload, cb) => {
    const reply = safeCb(cb);
    const { playerName, settings } = payload || {};
    if (!playerName || !String(playerName).trim()) return reply({ error: 'أدخل اسمك' });

    const r = room.createRoom(socket.id, String(playerName).trim(), settings || {});
    socket.join(r.code);
    reply({ success: true, code: r.code, state: room.buildStateForPlayer(r, socket.id) });
  });

  socket.on('join_room', (payload, cb) => {
    const reply = safeCb(cb);
    const { code, playerName } = payload || {};
    if (!playerName || !String(playerName).trim()) return reply({ error: 'أدخل اسمك' });
    if (!code || !String(code).trim()) return reply({ error: 'أدخل كود الغرفة' });

    const cleanCode = String(code).toUpperCase().trim();
    const cleanName = String(playerName).trim();
    const result = room.joinRoom(cleanCode, socket.id, cleanName);
    if (result.error) return reply({ error: result.error });

    socket.join(cleanCode);
    reply({ success: true, state: room.buildStateForPlayer(result.room, socket.id) });
    socket.to(cleanCode).emit('player_joined', {
      player: { id: socket.id, name: cleanName }
    });
    broadcastState(result.room);
  });

  socket.on('reconnect_room', (payload, cb) => {
    const reply = safeCb(cb);
    const { code, playerName, token } = payload || {};
    const cleanCode = String(code || '').toUpperCase().trim();
    const cleanName = String(playerName || '').trim();
    if (!cleanCode || !cleanName) return reply({ error: 'بيانات غير مكتملة' });

    const r = room.reconnectPlayer(cleanCode, cleanName, socket.id, token || null);
    if (!r) return reply({ error: 'تعذّرت إعادة الاتصال' });

    socket.join(cleanCode);
    reply({ success: true, state: room.buildStateForPlayer(r, socket.id) });
    broadcastState(r);
  });

  socket.on('start_game', (payload, cb) => {
    const reply = safeCb(cb);
    const cleanCode = String((payload || {}).code || '').toUpperCase().trim();
    const r = room.getRoom(cleanCode);
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.startGame(cleanCode, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(result.room);
    reply({ success: true });
  });

  socket.on('flip_perk', (payload, cb) => {
    const reply = safeCb(cb);
    const cleanCode = String((payload || {}).code || '').toUpperCase().trim();
    const r = room.getRoom(cleanCode);
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.flipPerk(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true, perk: result.perk });
  });

  socket.on('place_bid', (payload, cb) => {
    const reply = safeCb(cb);
    const { code, amount } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.placeBid(r, socket.id, Number(amount));
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true });
  });

  socket.on('call_bid', (payload, cb) => {
    const reply = safeCb(cb);
    const { code } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.callBid(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true, amount: result.amount });
  });

  socket.on('enter_with_bank', (payload, cb) => {
    const reply = safeCb(cb);
    const { code } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.enterWithBank(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true, amount: result.amount });
  });

  socket.on('fold_bid', (payload, cb) => {
    const reply = safeCb(cb);
    const { code } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.foldBid(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true });
  });

  socket.on('make_offer', (payload, cb) => {
    const reply = safeCb(cb);
    const { code, targetPlayerId, amount } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.makeOffer(r, socket.id, targetPlayerId, Number(amount));
    if (result.error) return reply({ error: result.error });

    const targetSocket = r.players.find(p => p.id === targetPlayerId)?.socketId;
    if (targetSocket) io.to(targetSocket).emit('offer_received', { amount: Number(amount) });

    broadcastState(r);
    reply({ success: true });
  });

  socket.on('accept_offer', (payload, cb) => {
    const reply = safeCb(cb);
    const { code } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.acceptOffer(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true });
  });

  socket.on('reject_offer', (payload, cb) => {
    const reply = safeCb(cb);
    const { code } = payload || {};
    const r = room.getRoom(String(code || '').toUpperCase().trim());
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.rejectOffer(r, socket.id);
    if (result.error) return reply({ error: result.error });

    broadcastState(r);
    reply({ success: true, rejections: result.rejections });
  });

  socket.on('boss_start_reveal', (payload, cb) => {
    const reply = safeCb(cb);
    const cleanCode = String((payload || {}).code || '').toUpperCase().trim();
    const r = room.getRoom(cleanCode);
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.bossStartReveal(r, socket.id);
    if (result.error) return reply({ error: result.error });

    io.to(cleanCode).emit('reveal_phase_started', {});
    broadcastState(r);
    reply({ success: true });
  });

  socket.on('reveal_card', (payload, cb) => {
    const reply = safeCb(cb);
    const { code, cardIndex } = payload || {};
    const cleanCode = String(code || '').toUpperCase().trim();
    const r = room.getRoom(cleanCode);
    if (!r) return reply({ error: 'الغرفة غير موجودة' });

    const result = room.revealCard(r, socket.id, Number(cardIndex));
    if (result.error) return reply({ error: result.error });

    io.to(cleanCode).emit('card_revealed', { playerId: socket.id, card: result.card });
    broadcastState(r);
    reply({ success: true });
  });

  socket.on('next_round', (payload, cb) => {
    const reply = safeCb(cb);
    const cleanCode = String((payload || {}).code || '').toUpperCase().trim();
    const r = room.getRoom(cleanCode);
    if (!r) return reply({ error: 'الغرفة غير موجودة' });
    if (r.hostId !== socket.id) return reply({ error: 'فقط المضيف يستطيع بدء جولة جديدة' });
    if (r.state !== 'playing' || !r.round || r.round.phase !== 'result') {
      return reply({ error: 'الجولة لم تنته بعد' });
    }

    room.startRound(r);
    broadcastState(r);
    reply({ success: true });
  });

  socket.on('disconnect', () => {
    const r = room.getRoomBySocketId(socket.id);
    if (r) {
      const player = r.players.find(p => p.socketId === socket.id);
      if (player) {
        player.connected = false;
        io.to(r.code).emit('player_disconnected', { playerName: player.name, playerId: player.id });
        broadcastState(r);
      }
    }
  });
});

function broadcastState(r) {
  for (const player of r.players) {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit('state_update', room.buildStateForPlayer(r, player.id));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 مداقش Backend يعمل على المنفذ ${PORT}`);
});
