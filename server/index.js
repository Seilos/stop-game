'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const gm         = require('./gameManager');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingTimeout: 60000 });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_, res) => res.json({ ok: true }));

// socketId -> { name, roomId }
const players = new Map();

// ────────────────────────────────────────────────────────────────
// BROADCAST HELPERS
// ────────────────────────────────────────────────────────────────

function broadcast(room, event, data) { io.to(room.id).emit(event, data); }
function broadcastState(room)         { broadcast(room, 'room_state', gm.publicState(room)); }

// ────────────────────────────────────────────────────────────────
// GAME FLOW
// ────────────────────────────────────────────────────────────────

function startRound(room) {
  gm.clearTimers(room);
  const letter = gm.pickLetter(room);
  if (!letter) { endGame(room); return; }

  room.currentLetter = letter;
  room.currentRound++;
  room.state         = 'spinning';
  room.answers       = {};
  room.challenges    = {};
  room.validationReadyPlayers = new Set();
  room.initialScores = {};
  room.currentRoundScores    = {};
  room.players.forEach(p => { p.ready = false; });

  broadcast(room, 'start_spin', {
    letter,
    round:    room.currentRound,
    duration: gm.SPIN_DURATION_MS,
  });

  room.roundTimerRef = setTimeout(() => {
    room.state        = 'playing';
    room.secondsLeft  = gm.ROUND_DURATION_SEC;

    broadcast(room, 'round_started', {
      letter,
      round:    room.currentRound,
      duration: gm.ROUND_DURATION_SEC,
    });

    room.timerTickRef = setInterval(() => {
      room.secondsLeft--;
      broadcast(room, 'timer_tick', room.secondsLeft);
      if (room.secondsLeft <= 0) endRound(room, null);
    }, 1000);
  }, gm.SPIN_DURATION_MS);
}

function endRound(room, stopperId) {
  if (room.state !== 'playing') return;
  gm.clearTimers(room);
  room.state = 'collecting';

  const conn = room.players.filter(p => p.connected);
  room.answersExpected = conn.length;
  room.answersReceived = 0;

  if (stopperId) {
    const stopper = room.players.find(p => p.id === stopperId);
    broadcast(room, 'someone_stopped', { playerName: stopper?.name || 'Alguien', playerId: stopperId });
  } else {
    broadcast(room, 'time_up');
  }
  broadcast(room, 'collect_answers');

  room.answerCollectionTimer = setTimeout(() => proceedToValidation(room), 3000);
}

function proceedToValidation(room) {
  if (room.state !== 'collecting') return;
  gm.clearTimers(room);
  room.state = 'validating';

  // Fill missing answers with empty strings
  room.players.forEach(p => {
    if (!room.answers[p.id]) {
      room.answers[p.id] = {};
      gm.CATEGORY_KEYS.forEach(cat => { room.answers[p.id][cat] = ''; });
    }
  });

  room.initialScores = gm.calcInitialScores(room);

  broadcast(room, 'validation_phase', {
    answers:       room.answers,
    initialScores: room.initialScores,
    players:       room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    categories:    gm.CATEGORIES,
    letter:        room.currentLetter,
  });
}

function tryFinalizeValidation(room) {
  if (room.state !== 'validating') return;
  if (!gm.checkValidationDone(room)) return;
  gm.resolvePending(room);
  finalizeValidation(room);
}

function finalizeValidation(room) {
  const finalScores = gm.applyChallengesToScores(room);
  gm.updateTotalScores(room, finalScores);
  if (!room.usedLetters.includes(room.currentLetter))
    room.usedLetters.push(room.currentLetter);
  room.state = 'scores';

  const lb = gm.leaderboard(room);
  broadcast(room, 'round_scores', {
    letter:      room.currentLetter,
    round:       room.currentRound,
    finalScores,
    totalScores: room.totalScores,
    leaderboard: lb,
    gameIsOver:  gm.isGameOver(room),
    answers:     room.answers,
    categories:  gm.CATEGORIES,
  });
}

function endGame(room) {
  gm.clearTimers(room);
  room.state = 'gameover';
  const lb = gm.leaderboard(room);
  broadcast(room, 'game_over', { leaderboard: lb, winner: lb[0], roundHistory: room.roundHistory });
}

// ────────────────────────────────────────────────────────────────
// DISCONNECT HANDLER
// ────────────────────────────────────────────────────────────────

function handleDisconnect(room, playerId, playerName) {
  gm.markDisconnected(room, playerId);
  broadcast(room, 'player_disconnected', { playerId, playerName });

  const conn = room.players.filter(p => p.connected);
  if (conn.length === 0) { gm.deleteRoom(room.id); return; }

  if (room.hostId === playerId) {
    room.hostId = conn[0].id;
    broadcast(room, 'host_changed', { newHostId: room.hostId });
  }

  switch (room.state) {
    case 'waiting':
      broadcastState(room);
      break;
    case 'playing':
      if (conn.length === 1) endRound(room, null);
      break;
    case 'collecting':
      room.answersExpected = conn.length;
      if (room.answersReceived >= room.answersExpected) proceedToValidation(room);
      break;
    case 'validating':
      tryFinalizeValidation(room);
      break;
  }
}

// ────────────────────────────────────────────────────────────────
// SOCKET EVENTS
// ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Set name ────────────────────────────────────────────
  socket.on('set_name', (name, cb) => {
    const clean = (name || '').trim().substring(0, 20);
    if (!clean) return cb({ error: 'Nombre inv\u00e1lido.' });
    players.set(socket.id, { name: clean, roomId: null });
    cb({ ok: true, playerId: socket.id, name: clean });
  });

  // ── Create room ─────────────────────────────────────────
  socket.on('create_room', (cb) => {
    const player = players.get(socket.id);
    if (!player)        return cb({ error: 'Ingresa tu nombre primero.' });
    if (player.roomId)  return cb({ error: 'Ya est\u00e1s en una sala.' });

    const room = gm.createRoom(socket.id, player.name);
    player.roomId = room.id;
    socket.join(room.id);
    console.log(`[Room] Created ${room.id} by ${player.name}`);
    cb({ ok: true, room: gm.publicState(room) });
  });

  // ── Join room ───────────────────────────────────────────
  socket.on('join_room', (code, cb) => {
    const player = players.get(socket.id);
    if (!player)       return cb({ error: 'Ingresa tu nombre primero.' });
    if (player.roomId) return cb({ error: 'Ya est\u00e1s en una sala.' });

    const room = gm.getRoom((code || '').toUpperCase());
    if (!room)                                                   return cb({ error: 'Sala no encontrada.' });
    if (room.state !== 'waiting')                                return cb({ error: 'La partida ya comenz\u00f3.' });
    if (room.players.filter(p => p.connected).length >= gm.MAX_PLAYERS) return cb({ error: 'Sala llena.' });

    gm.addPlayer(room, socket.id, player.name);
    player.roomId = room.id;
    socket.join(room.id);
    socket.to(room.id).emit('player_joined', { id: socket.id, name: player.name, ready: false, connected: true, totalScore: 0 });
    cb({ ok: true, room: gm.publicState(room) });
  });

  // ── Toggle letter ───────────────────────────────────────
  socket.on('toggle_letter', (letter, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'waiting') return;
    if (!/^[A-Z]$/.test(letter)) return;

    gm.toggleLetter(room, letter);
    broadcast(room, 'letters_updated', room.selectedLetters);
    if (cb) cb({ ok: true });
  });

  // ── Player ready ────────────────────────────────────────
  socket.on('player_ready', (ready, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'waiting') return;

    gm.setReady(room, socket.id, Boolean(ready));
    broadcast(room, 'player_ready_changed', { playerId: socket.id, ready: Boolean(ready) });
    if (cb) cb({ ok: true });
  });

  // ── Start game ──────────────────────────────────────────
  socket.on('start_game', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id) return cb?.({ error: 'Solo el anfitri\u00f3n puede iniciar.' });

    const check = gm.canStart(room);
    if (!check.ok) return cb?.({ error: check.reason });

    startRound(room);
    cb?.({ ok: true });
  });

  // ── STOP button ─────────────────────────────────────────
  socket.on('submit_stop', () => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'playing') return;
    endRound(room, socket.id);
  });

  // ── Submit answers ──────────────────────────────────────
  socket.on('submit_answers', (answers) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'collecting') return;

    const safe = {};
    gm.CATEGORY_KEYS.forEach(cat => {
      safe[cat] = (answers?.[cat] || '').trim().substring(0, 60);
    });
    room.answers[socket.id] = safe;
    room.answersReceived++;

    if (room.answersReceived >= room.answersExpected) proceedToValidation(room);
  });

  // ── Challenge word ──────────────────────────────────────
  socket.on('challenge_word', ({ targetPlayerId, category } = {}, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating') return;
    if (socket.id === targetPlayerId) return;

    const word = ((room.answers[targetPlayerId] || {})[category] || '').trim();
    if (!word) return cb?.({ error: 'Respuesta vac\u00eda, no se puede impugnar.' });

    const dup = Object.values(room.challenges).some(
      c => c.targetPlayerId === targetPlayerId && c.category === category && !c.resolved
    );
    if (dup) return cb?.({ error: 'Ya hay una impugnaci\u00f3n activa para esta respuesta.' });

    const challenge = gm.createChallenge(room, socket.id, targetPlayerId, category);

    // Check if immediately resolved (e.g. only 2 players)
    const totalEligible = challenge.eligibleVoters.length;
    const voted = Object.keys(challenge.votes).length;
    if (voted >= totalEligible) {
      gm.resolveChallenge(challenge);
      broadcast(room, 'challenge_started',  gm.publicChallenge(challenge));
      broadcast(room, 'challenge_resolved', gm.publicChallenge(challenge));
      tryFinalizeValidation(room);
    } else {
      challenge.timerRef = setTimeout(() => {
        if (!challenge.resolved) {
          gm.resolveChallenge(challenge);
          broadcast(room, 'challenge_resolved', gm.publicChallenge(challenge));
          tryFinalizeValidation(room);
        }
      }, gm.VOTE_DURATION_SEC * 1000);
      broadcast(room, 'challenge_started', gm.publicChallenge(challenge));
    }

    cb?.({ ok: true, challengeId: challenge.id });
  });

  // ── Vote on challenge ───────────────────────────────────
  socket.on('vote_challenge', ({ challengeId, vote } = {}, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating') return;

    const challenge = gm.voteOnChallenge(room, challengeId, socket.id, vote);
    if (!challenge) return;

    broadcast(room, 'challenge_vote_update', gm.publicChallenge(challenge));
    if (challenge.resolved) {
      broadcast(room, 'challenge_resolved', gm.publicChallenge(challenge));
      tryFinalizeValidation(room);
    }
    cb?.({ ok: true });
  });

  // ── Validation ready ────────────────────────────────────
  socket.on('validation_ready', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating') return;

    room.validationReadyPlayers.add(socket.id);
    broadcast(room, 'validation_ready_update', {
      readyPlayers: Array.from(room.validationReadyPlayers),
    });
    tryFinalizeValidation(room);
    cb?.({ ok: true });
  });

  // ── Next round ──────────────────────────────────────────
  socket.on('next_round', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'scores') return;
    gm.isGameOver(room) ? endGame(room) : startRound(room);
    cb?.({ ok: true });
  });

  // ── End game ────────────────────────────────────────────
  socket.on('end_game', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'scores') return;
    endGame(room);
    cb?.({ ok: true });
  });

  // ── Return to lobby ─────────────────────────────────────
  socket.on('return_to_lobby', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'gameover') return;
    gm.resetRoom(room);
    broadcastState(room);
    cb?.({ ok: true });
  });

  // ── Disconnect ──────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const player = players.get(socket.id);
    if (player?.roomId) {
      const room = gm.getRoom(player.roomId);
      if (room) handleDisconnect(room, socket.id, player.name);
    }
    players.delete(socket.id);
  });
});

server.listen(PORT, () => console.log(`\uD83C\uDFAE Stop! server -> http://localhost:${PORT}`));
