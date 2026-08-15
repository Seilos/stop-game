'use strict';

const { normalize, containsNumbers } = require('./utils');

const CATEGORIES = [
  { key: 'nombre',   label: 'Nombre' },
  { key: 'apellido', label: 'Apellido' },
  { key: 'cosa',     label: 'Cosa' },
  { key: 'color',    label: 'Color' },
  { key: 'animal',   label: 'Animal' },
  { key: 'ciudad',   label: 'Ciudad o Pa\u00eds' },
  { key: 'pelicula', label: 'Pel\u00edcula o Serie' },
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);

const MAX_PLAYERS              = 10;
const ROUND_DURATION_SEC       = 120;
const SPIN_DURATION_MS         = 5000;
const VOTE_DURATION_SEC        = 10;
const VALIDATION_INACTIVITY_SEC = 30;

const rooms = new Map();

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ────────────────────────────────────────────────────────────────
// ROOM LIFECYCLE
// ────────────────────────────────────────────────────────────────

function createRoom(hostId, hostName) {
  let roomCode;
  do { roomCode = genCode(); } while (rooms.has(roomCode));

  const room = {
    id: roomCode,
    hostId,
    players: [],
    selectedLetters: [],
    usedLetters: [],
    currentLetter: null,
    currentRound: 0,
    state: 'waiting',
    answers: {},
    initialScores: {},
    challenges: {},
    challengeQueue: [],
    activeChallengeId: null,
    validationReadyPlayers: new Set(),
    validationInactivityTimer: null,
    roundTimerRef: null,
    timerTickRef: null,
    answerCollectionTimer: null,
    secondsLeft: ROUND_DURATION_SEC,
    totalScores: {},
    currentRoundScores: {},
    roundHistory: [],
    answersReceived: 0,
    answersExpected: 0,
  };

  addPlayer(room, hostId, hostName);
  rooms.set(roomCode, room);
  return room;
}

function addPlayer(room, playerId, playerName) {
  const isHost = playerId === room.hostId;
  room.players.push({ id: playerId, name: playerName, ready: isHost, connected: true });
  room.totalScores[playerId] = 0;
}

function markDisconnected(room, playerId) {
  const p = room.players.find(p => p.id === playerId);
  if (p) { p.connected = false; p.ready = false; }
  room.validationReadyPlayers.delete(playerId);
}

function getRoom(id)         { return rooms.get(id) || null; }
function deleteRoom(id)      { clearTimers(rooms.get(id)); rooms.delete(id); }

function findRoomOf(playerId) {
  for (const room of rooms.values())
    if (room.players.some(p => p.id === playerId)) return room;
  return null;
}

function clearTimers(room) {
  if (!room) return;
  if (room.roundTimerRef)            { clearTimeout(room.roundTimerRef);    room.roundTimerRef = null; }
  if (room.timerTickRef)             { clearInterval(room.timerTickRef);    room.timerTickRef = null; }
  if (room.answerCollectionTimer)    { clearTimeout(room.answerCollectionTimer); room.answerCollectionTimer = null; }
  if (room.validationInactivityTimer){ clearTimeout(room.validationInactivityTimer); room.validationInactivityTimer = null; }
  for (const c of Object.values(room.challenges || {}))
    if (c.timerRef) { clearTimeout(c.timerRef); c.timerRef = null; }
}

// ────────────────────────────────────────────────────────────────
// PUBLIC STATE
// ────────────────────────────────────────────────────────────────

function publicState(room) {
  return {
    id:              room.id,
    hostId:          room.hostId,
    players:         room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      ready:      p.id === room.hostId ? true : p.ready,
      connected:  p.connected,
      totalScore: room.totalScores[p.id] || 0,
    })),
    selectedLetters: room.selectedLetters,
    usedLetters:     room.usedLetters,
    currentLetter:   room.currentLetter,
    currentRound:    room.currentRound,
    state:           room.state,
    totalScores:     room.totalScores,
    secondsLeft:     room.secondsLeft,
  };
}

// ────────────────────────────────────────────────────────────────
// WAITING PHASE
// ────────────────────────────────────────────────────────────────

function toggleLetter(room, letter) {
  const idx = room.selectedLetters.indexOf(letter);
  if (idx === -1) room.selectedLetters.push(letter);
  else room.selectedLetters.splice(idx, 1);
  room.selectedLetters.sort();
}

function setReady(room, playerId, ready) {
  const p = room.players.find(p => p.id === playerId);
  if (p) p.ready = ready;
}

function canStart(room) {
  const conn = room.players.filter(p => p.connected);
  if (conn.length < 2)                         return { ok: false, reason: 'Se necesitan al menos 2 jugadores.' };
  if (room.selectedLetters.length === 0)       return { ok: false, reason: 'Selecciona al menos una letra.' };
  if (availableLetters(room).length === 0)     return { ok: false, reason: 'No quedan letras disponibles.' };
  if (!conn.every(p => p.id === room.hostId || p.ready)) return { ok: false, reason: 'Todos los jugadores invitados deben estar listos.' };
  if (room.state !== 'waiting')                return { ok: false, reason: 'La partida ya está en curso.' };
  return { ok: true };
}

function availableLetters(room) {
  return room.selectedLetters.filter(l => !room.usedLetters.includes(l));
}

function pickLetter(room) {
  const av = availableLetters(room);
  if (!av.length) return null;
  return av[Math.floor(Math.random() * av.length)];
}

function isGameOver(room) {
  return availableLetters(room).length === 0;
}

// ────────────────────────────────────────────────────────────────
// SCORING
// ────────────────────────────────────────────────────────────────

function calcInitialScores(room) {
  const letter = room.currentLetter.toLowerCase();
  const ids = room.players.map(p => p.id);
  const scores = {};
  ids.forEach(id => {
    scores[id] = {};
    CATEGORY_KEYS.forEach(cat => { scores[id][cat] = 0; });
    scores[id].total = 0;
  });

  CATEGORY_KEYS.forEach(cat => {
    const wordMap = {};
    ids.forEach(id => {
      const raw = ((room.answers[id] || {})[cat] || '').trim();
      if (!raw || containsNumbers(raw)) return;
      const norm = normalize(raw);
      if (!norm || norm[0] !== letter) return;
      if (!wordMap[norm]) wordMap[norm] = [];
      wordMap[norm].push(id);
    });
    for (const playerIds of Object.values(wordMap)) {
      const pts = playerIds.length === 1 ? 100 : 50;
      playerIds.forEach(id => { scores[id][cat] = pts; scores[id].total += pts; });
    }
  });
  return scores;
}

function applyChallengesToScores(room) {
  const final = {};
  room.players.forEach(p => { final[p.id] = { ...room.initialScores[p.id] }; });
  for (const c of Object.values(room.challenges)) {
    if (!c.resolved || c.result !== false) continue;
    const s = final[c.targetPlayerId];
    if (s) { s.total -= (s[c.category] || 0); s[c.category] = 0; }
  }
  return final;
}

function updateTotalScores(room, finalScores) {
  room.currentRoundScores = finalScores;
  for (const [id, s] of Object.entries(finalScores))
    if (room.totalScores[id] !== undefined) room.totalScores[id] += (s.total || 0);
  room.roundHistory.push({ letter: room.currentLetter, round: room.currentRound, scores: finalScores });
}

function leaderboard(room) {
  return room.players
    .map(p => ({
      id:         p.id,
      name:       p.name,
      connected:  p.connected,
      totalScore: room.totalScores[p.id] || 0,
      roundScore: (room.currentRoundScores?.[p.id]?.total) || 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore);
}

// ────────────────────────────────────────────────────────────────
// CHALLENGES / VOTING
// ────────────────────────────────────────────────────────────────

function createChallenge(room, challengerId, targetPlayerId, category, reason = '') {
  const id = genId();
  const raw = ((room.answers[targetPlayerId] || {})[category] || '').trim();
  // Eligible voters: EVERY connected player EXCEPT challenger and EXCEPT target player (owner)
  const eligible = room.players
    .filter(p => p.connected && p.id !== challengerId && p.id !== targetPlayerId)
    .map(p => p.id);

  const challenge = {
    id,
    challengerId,
    targetPlayerId,
    category,
    word: raw,
    reason: (reason || '').trim().substring(0, 120),
    votes: { [challengerId]: false }, // Challenger automatically votes false (invalid)
    eligibleVoters: eligible,
    resolved: false,
    result: null,
    timerRef: null,
  };
  room.challenges[id] = challenge;
  return challenge;
}

function voteOnChallenge(room, challengeId, voterId, vote) {
  const c = room.challenges[challengeId];
  if (!c || c.resolved) return null;
  if (!c.eligibleVoters.includes(voterId)) return null;
  c.votes[voterId] = Boolean(vote);
  _checkMajority(c);
  return c;
}

function _checkMajority(c) {
  if (c.resolved) return;
  const totalNeeded = c.eligibleVoters.length + 1; // +1 for challenger
  const votedCount  = Object.keys(c.votes).length;
  const vF = Object.values(c.votes).filter(v => v === false).length;
  const vT = Object.values(c.votes).filter(v => v === true).length;
  const majority = Math.floor(totalNeeded / 2) + 1;

  if (vF >= majority || vT >= majority || votedCount >= totalNeeded) {
    resolveChallenge(c);
  }
}

function resolveChallenge(c) {
  if (c.resolved) return;
  // Fill non-voted eligible voters with false (timeout / default)
  c.eligibleVoters.forEach(id => {
    if (c.votes[id] === undefined) c.votes[id] = false;
  });
  const vF = Object.values(c.votes).filter(v => v === false).length;
  const vT = Object.values(c.votes).filter(v => v === true).length;
  c.result   = vT >= vF;
  c.resolved = true;
  if (c.timerRef) { clearTimeout(c.timerRef); c.timerRef = null; }
}

function resolvePending(room) {
  for (const c of Object.values(room.challenges))
    if (!c.resolved) resolveChallenge(c);
}

function checkValidationDone(room) {
  const conn = room.players.filter(p => p.connected);
  const allReady    = conn.every(p => room.validationReadyPlayers.has(p.id));
  const allResolved = Object.values(room.challenges).every(c => c.resolved);
  return allReady && allResolved;
}

function publicChallenge(c) {
  return {
    id:             c.id,
    challengerId:   c.challengerId,
    targetPlayerId: c.targetPlayerId,
    category:       c.category,
    word:           c.word,
    reason:         c.reason || 'Palabra dudosa',
    votesFalse:     Object.values(c.votes).filter(v => v === false).length,
    votesTrue:      Object.values(c.votes).filter(v => v === true).length,
    totalEligible:  c.eligibleVoters.length + 1, // total voters including challenger
    voters:         Object.keys(c.votes),
    eligibleVoters: c.eligibleVoters,
    resolved:       c.resolved,
    result:         c.result,
  };
}

function publicAnonymousChallenge(c, room) {
  const totalVoters = c.eligibleVoters.length + 1;
  const votedCount  = Object.keys(c.votes).length;

  return {
    id:             c.id,
    targetPlayerId: c.targetPlayerId,
    category:       c.category,
    word:           c.word,
    reason:         c.reason || 'Palabra dudosa',
    votedCount,
    totalVoters,
    resolved:       c.resolved,
    result:         c.result,
  };
}

function publicCategoryStep(room, categoryIndex) {
  const cat = CATEGORIES[categoryIndex];
  if (!cat) return null;

  const cards = room.players
    .filter(p => p.connected)
    .map((p, idx) => {
      const word = ((room.answers[p.id] || {})[cat.key] || '').trim();
      return {
        cardId: `${cat.key}-${idx}`,
        targetPlayerId: p.id,
        word: word || '—',
        hasWord: Boolean(word),
      };
    });

  return {
    categoryIndex,
    categoryKey: cat.key,
    categoryLabel: cat.label,
    totalCategories: CATEGORIES.length,
    cards,
  };
}

// ────────────────────────────────────────────────────────────────
// RESET
// ────────────────────────────────────────────────────────────────

function resetRoom(room) {
  clearTimers(room);
  room.players         = room.players.filter(p => p.connected);
  room.state           = 'waiting';
  room.selectedLetters = [];
  room.usedLetters     = [];
  room.currentLetter   = null;
  room.currentRound    = 0;
  room.answers         = {};
  room.initialScores   = {};
  room.challenges      = {};
  room.challengeQueue  = [];
  room.activeChallengeId = null;
  room.validationReadyPlayers = new Set();
  room.totalScores     = {};
  room.currentRoundScores    = {};
  room.roundHistory    = [];
  room.players.forEach(p => { room.totalScores[p.id] = 0; p.ready = false; });
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS,
  MAX_PLAYERS, ROUND_DURATION_SEC, SPIN_DURATION_MS, VOTE_DURATION_SEC, VALIDATION_INACTIVITY_SEC,
  createRoom, addPlayer, markDisconnected,
  getRoom, deleteRoom, findRoomOf, clearTimers,
  publicState, publicChallenge, publicAnonymousChallenge, publicCategoryStep,
  toggleLetter, setReady, canStart, pickLetter, isGameOver,
  calcInitialScores, applyChallengesToScores, updateTotalScores, leaderboard,
  createChallenge, voteOnChallenge, resolveChallenge, resolvePending,
  checkValidationDone, resetRoom,
};
