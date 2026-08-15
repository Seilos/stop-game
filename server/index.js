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

// ────────────────────────────────────────────────────────────────
// VALIDATION STATE MACHINE (ANONYMOUS SEQUENTIAL CATEGORIES)
// ────────────────────────────────────────────────────────────────

function proceedToValidation(room) {
  if (room.state !== 'collecting') return;
  gm.clearTimers(room);
  room.state = 'validating';
  room.currentCategoryIndex = 0;

  // Trim whitespace and fill missing answers
  room.players.forEach(p => {
    if (!room.answers[p.id]) {
      room.answers[p.id] = {};
      gm.CATEGORY_KEYS.forEach(cat => { room.answers[p.id][cat] = ''; });
    } else {
      gm.CATEGORY_KEYS.forEach(cat => {
        room.answers[p.id][cat] = (room.answers[p.id][cat] || '').trim();
      });
    }
  });

  room.initialScores = gm.calcInitialScores(room);

  // Start Category 0 (Nombre)
  startCategoryStep(room, 0);
}

function startCategoryStep(room, categoryIndex) {
  if (room.state !== 'validating') return;

  // If all categories (0 to 6) are finished -> Go to Reveal Grid
  if (categoryIndex >= gm.CATEGORIES.length) {
    showFinalRevealGrid(room);
    return;
  }

  clearCategoryTimers(room);

  room.currentCategoryIndex = categoryIndex;
  room.categoryState = 'reading'; // reading or voting
  room.categorySecondsLeft = 10;
  room.activeChallenge = null;

  const payload = gm.publicCategoryStep(room, categoryIndex);
  broadcast(room, 'category_step_started', {
    ...payload,
    duration: 10,
  });

  room.categoryTimerRef = setInterval(() => {
    room.categorySecondsLeft--;
    broadcast(room, 'category_timer_tick', room.categorySecondsLeft);

    if (room.categorySecondsLeft <= 0) {
      clearCategoryTimers(room);
      // Move to next category automatically
      startCategoryStep(room, room.currentCategoryIndex + 1);
    }
  }, 1000);
}

function clearCategoryTimers(room) {
  if (room.categoryTimerRef) { clearInterval(room.categoryTimerRef); room.categoryTimerRef = null; }
  if (room.intentTimerRef)   { clearTimeout(room.intentTimerRef);   room.intentTimerRef = null; }
  if (room.voteTimerRef)     { clearTimeout(room.voteTimerRef);     room.voteTimerRef = null; }
}

function resumeCategoryTimer(room) {
  if (room.intentTimerRef) { clearTimeout(room.intentTimerRef); room.intentTimerRef = null; }
  room.categoryState = 'reading';
  broadcast(room, 'category_timer_resumed', { secondsLeft: room.categorySecondsLeft });

  if (room.categoryTimerRef) clearInterval(room.categoryTimerRef);
  room.categoryTimerRef = setInterval(() => {
    room.categorySecondsLeft--;
    broadcast(room, 'category_timer_tick', room.categorySecondsLeft);

    if (room.categorySecondsLeft <= 0) {
      clearCategoryTimers(room);
      startCategoryStep(room, room.currentCategoryIndex + 1);
    }
  }, 1000);
}

function onCategoryChallengeResolved(room, challenge) {
  clearCategoryTimers(room);
  broadcast(room, 'category_challenge_resolved', gm.publicAnonymousChallenge(challenge, room));

  setTimeout(() => {
    // Advance to next category after exactly 2 seconds
    startCategoryStep(room, room.currentCategoryIndex + 1);
  }, 2000);
}

function showFinalRevealGrid(room) {
  clearCategoryTimers(room);
  room.state = 'validating_reveal';
  room.validationReadyPlayers = new Set();

  const finalScores = gm.applyChallengesToScores(room);

  broadcast(room, 'validation_reveal_phase', {
    answers:       room.answers,
    initialScores: room.initialScores,
    finalScores,
    challenges:    Object.values(room.challenges).map(c => gm.publicAnonymousChallenge(c, room)),
    players:       room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isKicked: p.isKicked, isSpectator: p.isSpectator })),
    categories:    gm.CATEGORIES,
    letter:        room.currentLetter,
    hostId:        room.hostId,
  });
}

function tryFinalizeValidation(room) {
  if (room.state !== 'validating_reveal') return;
  const conn = room.players.filter(p => p.connected && !p.isSpectator);
  if (conn.length > 0 && conn.every(p => room.validationReadyPlayers.has(p.id))) {
    finalizeValidation(room);
  }
}

function finalizeValidation(room) {
  if (room.revealTimerRef) { clearTimeout(room.revealTimerRef); room.revealTimerRef = null; }
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
    conn[0].ready = true;
    broadcast(room, 'host_changed', { newHostId: room.hostId });
  }

  switch (room.state) {
    case 'waiting':
      broadcastState(room);
      break;
    case 'playing':
      if (conn.filter(p => !p.isSpectator).length === 1) endRound(room, null);
      break;
    case 'collecting':
      room.answersExpected = conn.filter(p => !p.isSpectator).length;
      if (room.answersReceived >= room.answersExpected) proceedToValidation(room);
      break;
    case 'validating':
      if (room.activeChallenge) {
        gm._checkMajority(room.activeChallenge);
        if (room.activeChallenge.resolved) onCategoryChallengeResolved(room, room.activeChallenge);
      }
      break;
    case 'validating_reveal':
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
    if (!clean) return cb({ error: 'Nombre inválido.' });
    players.set(socket.id, { name: clean, roomId: null });
    cb({ ok: true, playerId: socket.id, name: clean });
  });

  // ── Create room ─────────────────────────────────────────
  socket.on('create_room', (cb) => {
    const player = players.get(socket.id);
    if (!player)        return cb({ error: 'Ingresa tu nombre primero.' });
    if (player.roomId)  return cb({ error: 'Ya estás en una sala.' });

    const room = gm.createRoom(socket.id, player.name);
    player.roomId = room.id;
    socket.join(room.id);
    console.log(`[Room] Created ${room.id} by ${player.name}`);
    cb({ ok: true, room: gm.publicState(room) });
  });

  // ── Join room (Allows Spectator mode if game in progress) ─
  socket.on('join_room', (code, cb) => {
    const player = players.get(socket.id);
    if (!player)       return cb({ error: 'Ingresa tu nombre primero.' });
    if (player.roomId) return cb({ error: 'Ya estás en una sala.' });

    const room = gm.getRoom((code || '').toUpperCase());
    if (!room) return cb({ error: 'Sala no encontrada.' });
    if (room.players.filter(p => p.connected).length >= gm.MAX_PLAYERS) return cb({ error: 'Sala llena.' });

    gm.addPlayer(room, socket.id, player.name);
    player.roomId = room.id;
    socket.join(room.id);

    broadcastState(room);
    socket.to(room.id).emit('player_joined', { id: socket.id, name: player.name });

    cb({ ok: true, room: gm.publicState(room), isSpectator: room.state !== 'waiting' });
  });

  // ── Toggle letter ───────────────────────────────────────
  socket.on('toggle_letter', (letter, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'waiting') return;
    if (!/^[A-Z]$/.test(letter)) return;

    gm.toggleLetter(room, letter);
    broadcastState(room);
    if (cb) cb({ ok: true });
  });

  // ── Player ready ────────────────────────────────────────
  socket.on('player_ready', (ready, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'waiting') return;

    gm.setReady(room, socket.id, Boolean(ready));
    broadcastState(room);
    if (cb) cb({ ok: true });
  });

  // ── Start game ──────────────────────────────────────────
  socket.on('start_game', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id) return cb?.({ error: 'Solo el anfitrión puede iniciar.' });

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

  // ── Intent challenge (pause timer while choosing reason) ────
  socket.on('intent_challenge_word', ({ targetPlayerId, category } = {}, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating' || room.categoryState !== 'reading') return;
    if (socket.id === targetPlayerId) return;

    const word = ((room.answers[targetPlayerId] || {})[category] || '').trim();
    if (!word) return cb?.({ error: 'Respuesta vacía.' });

    const alreadyChallenged = Object.values(room.challenges).some(
      c => c.targetPlayerId === targetPlayerId && c.category === category
    );
    if (alreadyChallenged) return cb?.({ error: 'Esta respuesta ya fue votada.' });

    // Pause category timer
    room.categoryState = 'selecting_reason';
    if (room.categoryTimerRef) { clearInterval(room.categoryTimerRef); room.categoryTimerRef = null; }

    broadcast(room, 'category_timer_paused', { challengerId: socket.id });

    // 10-second timeout to choose reason
    if (room.intentTimerRef) clearTimeout(room.intentTimerRef);
    room.intentTimerRef = setTimeout(() => {
      if (room.state === 'validating' && room.categoryState === 'selecting_reason') {
        resumeCategoryTimer(room);
      }
    }, 10000);

    cb?.({ ok: true, duration: 10 });
  });

  // ── Cancel intent challenge ─────────────────────────────
  socket.on('cancel_intent_challenge', () => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating' || room.categoryState !== 'selecting_reason') return;
    resumeCategoryTimer(room);
  });

  // ── Challenge word in category step ──────────────────────
  socket.on('challenge_word', ({ targetPlayerId, category, reason } = {}, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating') return;
    if (room.categoryState !== 'reading' && room.categoryState !== 'selecting_reason') return;
    if (socket.id === targetPlayerId) return;

    const word = ((room.answers[targetPlayerId] || {})[category] || '').trim();
    if (!word) return cb?.({ error: 'Respuesta vacía, no se puede impugnar.' });

    const alreadyChallenged = Object.values(room.challenges).some(
      c => c.targetPlayerId === targetPlayerId && c.category === category
    );
    if (alreadyChallenged) return cb?.({ error: 'Esta respuesta ya fue votada.' });

    clearCategoryTimers(room);
    room.categoryState = 'voting';

    const challenge = gm.createChallenge(room, socket.id, targetPlayerId, category, reason);
    room.activeChallenge = challenge;

    broadcast(room, 'category_challenge_started', gm.publicAnonymousChallenge(challenge, room));

    // 10-second voting timer
    challenge.timerRef = setTimeout(() => {
      if (!challenge.resolved) {
        gm.resolveChallenge(challenge);
        onCategoryChallengeResolved(room, challenge);
      }
    }, 10000);

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
      onChallengeResolved(room, challenge);
    }
    cb?.({ ok: true });
  });

  // ── Validation ready ────────────────────────────────────
  socket.on('validation_ready', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.state !== 'validating_reveal') return;

    room.validationReadyPlayers.add(socket.id);
    broadcast(room, 'validation_ready_update', {
      readyPlayers: Array.from(room.validationReadyPlayers),
    });
    tryFinalizeValidation(room);
    cb?.({ ok: true });
  });

  // ── Kick player (Host only) ──────────────────────────────
  socket.on('kick_player', ({ targetPlayerId } = {}, cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id) return cb?.({ error: 'Solo el anfitrión puede expulsar.' });
    if (targetPlayerId === socket.id) return cb?.({ error: 'No te puedes expulsar a ti mismo.' });

    const kicked = gm.kickPlayer(room, targetPlayerId);
    if (!kicked) return cb?.({ error: 'Jugador no encontrado.' });

    const targetSocket = io.sockets.sockets.get(targetPlayerId);
    if (targetSocket) {
      targetSocket.emit('kicked_from_room');
      targetSocket.leave(room.id);
    }

    broadcast(room, 'player_kicked', { targetPlayerId, name: kicked.name });
    broadcastState(room);

    if (room.state === 'validating_reveal') {
      const finalScores = gm.applyChallengesToScores(room);
      broadcast(room, 'validation_reveal_phase', {
        answers:       room.answers,
        initialScores: room.initialScores,
        finalScores,
        challenges:    Object.values(room.challenges).map(c => gm.publicAnonymousChallenge(c, room)),
        players:       room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isKicked: p.isKicked, isSpectator: p.isSpectator })),
        categories:    gm.CATEGORIES,
        letter:        room.currentLetter,
        hostId:        room.hostId,
      });
      tryFinalizeValidation(room);
    }

    cb?.({ ok: true });
  });

  // ── Host override advance reveal phase ───────────────────
  socket.on('advance_reveal_phase', (cb) => {
    const player = players.get(socket.id);
    if (!player?.roomId) return;
    const room = gm.getRoom(player.roomId);
    if (!room || room.hostId !== socket.id || room.state !== 'validating_reveal') return;

    finalizeValidation(room);
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
