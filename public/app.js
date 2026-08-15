'use strict';

// ────────────────────────────────────────────────────────────────
// STATE & DOM ELEMENTS
// ────────────────────────────────────────────────────────────────
let socket;
let myPlayerId = null;
let myName = '';
let currentRoom = null;
let activeChallenge = null;
let challengeVoteTimer = null;
let challengeSecsLeft = 10;
let lastValidationState = null;
let currentValidationChallenges = [];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CATEGORIES = [
  { key: 'nombre',   label: 'Nombre' },
  { key: 'apellido', label: 'Apellido' },
  { key: 'cosa',     label: 'Cosa' },
  { key: 'color',    label: 'Color' },
  { key: 'animal',   label: 'Animal' },
  { key: 'ciudad',   label: 'Ciudad o País' },
  { key: 'pelicula', label: 'Película o Serie' },
];

// Screen Elements
const screens = {
  welcome:          document.getElementById('screen-welcome'),
  lobby:            document.getElementById('screen-lobby'),
  room:             document.getElementById('screen-room'),
  roulette:         document.getElementById('screen-roulette'),
  game:             document.getElementById('screen-game'),
  validation:       document.getElementById('screen-validation'),
  validationReveal: document.getElementById('screen-validation-reveal'),
  scores:           document.getElementById('screen-scores'),
  gameover:         document.getElementById('screen-gameover'),
};

function showScreen(name) {
  Object.keys(screens).forEach(key => {
    if (screens[key]) {
      screens[key].classList.toggle('active', key === name);
    }
  });
}

// ────────────────────────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(100%)';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// ────────────────────────────────────────────────────────────────
// INITIALIZATION & SOCKET SETUP
// ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  socket = io();

  setupSocketListeners();
  setupUIEventListeners();
  renderAlphabetGrid();

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW error:', err));
  }

  // Check saved name in localStorage
  const savedName = localStorage.getItem('stop_player_name');
  if (savedName) {
    document.getElementById('inp-name').value = savedName;
  }
});

function setupSocketListeners() {
  socket.on('connect', () => {
    console.log('Conectado al servidor Socket.IO');
  });

  socket.on('disconnect', () => {
    showToast('Desconectado del servidor', 'error');
  });

  socket.on('room_state', (room) => {
    currentRoom = room;
    updateRoomUI();
  });

  socket.on('player_joined', ({ name }) => {
    showToast(`${name} se ha unido a la sala`, 'info');
  });

  socket.on('player_disconnected', ({ playerName }) => {
    showToast(`${playerName} se ha desconectado`, 'warn');
  });

  socket.on('host_changed', ({ newHostId }) => {
    if (newHostId === socket.id) {
      showToast('¡Ahora eres el anfitrión de la sala!', 'success');
    } else {
      showToast('El anfitrión ha cambiado', 'info');
    }
  });

  socket.on('letters_updated', (letters) => {
    if (currentRoom) {
      currentRoom.selectedLetters = letters;
      renderSelectedLetters();
    }
  });

  socket.on('player_ready_changed', ({ playerId, ready }) => {
    if (currentRoom) {
      const p = currentRoom.players.find(x => x.id === playerId);
      if (p) p.ready = ready;
      renderPlayersList();
      updateHostStartButton();
    }
  });

  // ── ROULETTE / SPIN ──────────────────────────────────────
  socket.on('start_spin', ({ letter, round, duration }) => {
    showScreen('roulette');
    runRouletteAnimation(letter, round, duration);
  });

  // ── GAME PLAYING ─────────────────────────────────────────
  socket.on('round_started', ({ letter, round, duration }) => {
    showScreen('game');
    startTimerRing(duration);
    document.getElementById('game-letter').textContent = letter;
    document.getElementById('game-rnd').textContent = `Ronda ${round}`;
    renderCategoryForm();
  });

  socket.on('timer_tick', (secondsLeft) => {
    updateTimerDisplay(secondsLeft);
  });

  socket.on('someone_stopped', ({ playerName }) => {
    showToast(`¡${playerName} ha presionado STOP!`, 'warn', 4000);
  });

  socket.on('time_up', () => {
    showToast('¡Tiempo agotado!', 'warn', 4000);
  });

  socket.on('collect_answers', () => {
    sendMyAnswers();
  });

  // ── ANONYMOUS CATEGORY VALIDATION ──────────────────────────
  socket.on('category_step_started', (data) => {
    hideVoteModal();
    renderAnonymousCategoryStep(data);
  });

  socket.on('category_timer_tick', (secondsLeft) => {
    updateCategoryTimerBar(secondsLeft, 10);
  });

  socket.on('category_challenge_started', (challenge) => {
    activeChallenge = challenge;
    highlightChallengedCard(challenge.targetPlayerId, challenge.category);
    updateVoteTrackerDots(challenge.votedCount, challenge.totalVoters);

    // Only show vote modal if socket.id is ELIGIBLE (not challenger and NOT target owner)
    const isEligible = challenge.eligibleVoters?.includes(socket.id);
    if (isEligible) {
      showVoteModal(challenge);
    } else {
      hideVoteModal();
    }
  });

  socket.on('category_vote_progress', (challenge) => {
    if (activeChallenge && activeChallenge.id === challenge.id) {
      activeChallenge = challenge;
      updateVoteTrackerDots(challenge.votedCount, challenge.totalVoters);
      updateVoteModalBars(challenge);
    }
  });

  socket.on('category_challenge_resolved', (challenge) => {
    hideVoteModal();
    resetChallengedCards();

    // Mark card as invalidated/validated
    const cards = document.querySelectorAll('.anon-card');
    cards.forEach(card => {
      if (card.dataset.targetId === challenge.targetPlayerId) {
        if (challenge.result === false) {
          card.classList.add('invalidated');
        } else {
          card.classList.add('validated');
        }
      }
    });

    showToast(`Respuesta "${challenge.word}": ${challenge.result ? 'VÁLIDA ✅' : 'INVÁLIDA ❌ (0 pts)'}`, challenge.result ? 'success' : 'error');
  });

  socket.on('validation_reveal_phase', ({ answers, initialScores, finalScores, challenges, players, categories, letter }) => {
    hideVoteModal();
    showScreen('validationReveal');
    document.getElementById('val-letter').textContent = letter;
    renderValidationRevealGrid(answers, initialScores, finalScores, challenges, players, categories);
    updateValidationReadyStatus([]);
  });

  socket.on('validation_ready_update', ({ readyPlayers }) => {
    updateValidationReadyStatus(readyPlayers);
  });

  // ── SCORES PHASE ─────────────────────────────────────────
  socket.on('round_scores', ({ letter, round, finalScores, totalScores, leaderboard, gameIsOver }) => {
    showScreen('scores');
    document.getElementById('sc-round').textContent = round;
    document.getElementById('sc-letter').textContent = letter;
    renderLeaderboard('leaderboard', leaderboard, finalScores);

    const isHost = currentRoom && currentRoom.hostId === socket.id;
    document.getElementById('btn-next-round').style.display = (isHost && !gameIsOver) ? 'inline-flex' : 'none';
    document.getElementById('btn-end-game').style.display = (isHost && gameIsOver) ? 'inline-flex' : 'none';
    document.getElementById('sc-waiting').style.display = (!isHost) ? 'inline' : 'none';
  });

  // ── GAME OVER ────────────────────────────────────────────
  socket.on('game_over', ({ leaderboard, winner }) => {
    showScreen('gameover');
    if (winner) {
      document.getElementById('winner-name').textContent = winner.name;
      document.getElementById('winner-score').textContent = `${winner.totalScore} pts`;
    }
    renderLeaderboard('final-lb', leaderboard);

    const isHost = currentRoom && currentRoom.hostId === socket.id;
    document.getElementById('btn-lobby').style.display = isHost ? 'inline-flex' : 'none';
  });
}

// ────────────────────────────────────────────────────────────────
// UI EVENT HANDLERS
let pendingChallenge = null;

function openReasonModal(targetPlayerId, targetPlayerName, category, word) {
  pendingChallenge = { targetPlayerId, category, word };
  document.getElementById('rm-target-word').innerHTML = `Impugnar <b>"${escapeHtml(word)}"</b> de <b>${escapeHtml(targetPlayerName)}</b>`;
  document.getElementById('inp-custom-reason').value = '';
  document.getElementById('reason-modal').style.display = 'flex';
}

function closeReasonModal() {
  document.getElementById('reason-modal').style.display = 'none';
  pendingChallenge = null;
}

function setupUIEventListeners() {
  // Enter welcome
  document.getElementById('btn-enter').addEventListener('click', handleEnterName);
  document.getElementById('inp-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleEnterName();
  });

  // Lobby actions
  document.getElementById('btn-create').addEventListener('click', handleCreateRoom);
  document.getElementById('btn-join').addEventListener('click', handleJoinRoom);
  document.getElementById('inp-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  });

  // Room actions
  document.getElementById('btn-copy').addEventListener('click', () => {
    if (currentRoom) {
      navigator.clipboard.writeText(currentRoom.id);
      showToast('Código de sala copiado', 'success');
    }
  });

  document.getElementById('btn-ready').addEventListener('click', handleToggleReady);
  document.getElementById('btn-start').addEventListener('click', handleStartGame);
  document.getElementById('btn-leave').addEventListener('click', handleLeaveRoom);

  // Game actions
  document.getElementById('btn-stop').addEventListener('click', () => {
    socket.emit('submit_stop');
  });

  // Reason modal actions
  document.querySelectorAll('.quick-reason-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const reason = e.target.dataset.reason;
      document.getElementById('inp-custom-reason').value = reason;
    });
  });
  document.getElementById('btn-reason-close').addEventListener('click', closeReasonModal);
  document.getElementById('btn-submit-challenge').addEventListener('click', () => {
    if (!pendingChallenge) return;
    const reason = document.getElementById('inp-custom-reason').value.trim() || 'Palabra dudosa';
    const { targetPlayerId, category } = pendingChallenge;
    closeReasonModal();

    socket.emit('challenge_word', { targetPlayerId, category, reason }, (res) => {
      if (res?.error) showToast(res.error, 'warn');
    });
  });

  // Validation actions
  document.getElementById('btn-val-ready').addEventListener('click', () => {
    socket.emit('validation_ready', (res) => {
      if (res?.ok) {
        document.getElementById('btn-val-ready').disabled = true;
        document.getElementById('btn-val-ready').textContent = '✅ Esperando al resto...';
      }
    });
  });

  // Vote modal
  document.getElementById('btn-vote-valid').addEventListener('click', () => submitVote(true));
  document.getElementById('btn-vote-invalid').addEventListener('click', () => submitVote(false));

  // Score navigation
  document.getElementById('btn-next-round').addEventListener('click', () => {
    socket.emit('next_round', (res) => {
      if (res?.error) showToast(res.error, 'error');
    });
  });

  document.getElementById('btn-end-game').addEventListener('click', () => {
    socket.emit('end_game');
  });

  document.getElementById('btn-lobby').addEventListener('click', () => {
    socket.emit('return_to_lobby');
  });
}

// ────────────────────────────────────────────────────────────────
// WELCOME & LOBBY LOGIC
// ────────────────────────────────────────────────────────────────
function handleEnterName() {
  const input = document.getElementById('inp-name');
  const name = (input.value || '').trim();
  if (!name) {
    showToast('Por favor escribe tu apodo', 'warn');
    return;
  }
  socket.emit('set_name', name, (res) => {
    if (res?.error) {
      showToast(res.error, 'error');
      return;
    }
    myPlayerId = res.playerId;
    myName = res.name;
    localStorage.setItem('stop_player_name', myName);
    document.getElementById('lobby-badge').textContent = myName;
    showScreen('lobby');
  });
}

function handleCreateRoom() {
  socket.emit('create_room', (res) => {
    if (res?.error) {
      showToast(res.error, 'error');
      return;
    }
    currentRoom = res.room;
    showScreen('room');
    updateRoomUI();
  });
}

function handleJoinRoom() {
  const codeInp = document.getElementById('inp-code');
  const code = (codeInp.value || '').trim().toUpperCase();
  if (!code) {
    showToast('Ingresa el código de la sala', 'warn');
    return;
  }
  socket.emit('join_room', code, (res) => {
    if (res?.error) {
      showToast(res.error, 'error');
      return;
    }
    currentRoom = res.room;
    showScreen('room');
    updateRoomUI();
  });
}

// ────────────────────────────────────────────────────────────────
// ROOM WAITING SCREEN
// ────────────────────────────────────────────────────────────────
function updateRoomUI() {
  if (!currentRoom) return;

  document.getElementById('room-code').textContent = currentRoom.id;
  document.getElementById('player-count').textContent = `(${currentRoom.players.length}/10)`;

  const isHost = currentRoom.hostId === socket.id;

  // Controls visibility
  document.getElementById('host-letter-area').style.display = isHost ? 'block' : 'none';
  document.getElementById('ctrl-host-start').style.display = isHost ? 'block' : 'none';
  document.getElementById('ctrl-guest-ready').style.display = !isHost ? 'block' : 'none';

  const myPlayer = currentRoom.players.find(p => p.id === socket.id);
  const isReady = Boolean(myPlayer?.ready);
  const btnReady = document.getElementById('btn-ready');
  if (btnReady) {
    btnReady.textContent = isReady ? '✅ Listo' : '⏳ Marcar como Listo';
    btnReady.className = `btn ${isReady ? 'btn-success' : 'btn-secondary'}`;
  }

  renderPlayersList();
  renderSelectedLetters();
  updateAlphaButtons();
  updateHostStartButton();
}

function renderPlayersList() {
  const container = document.getElementById('players-list');
  if (!container || !currentRoom) return;

  container.innerHTML = '';
  currentRoom.players.forEach((p, idx) => {
    const isMe = p.id === socket.id;
    const isHost = p.id === currentRoom.hostId;
    const isReady = isHost ? true : p.ready;

    const div = document.createElement('div');
    div.className = `player-item ${isReady ? 'ready' : ''}`;

    const colors = ['#7c3aed', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6'];
    const bg = colors[idx % colors.length];

    div.innerHTML = `
      <div class="p-avatar" style="background:${bg}">${p.name.charAt(0).toUpperCase()}</div>
      <span class="p-name">${escapeHtml(p.name)} ${isMe ? '(Tú)' : ''} ${isHost ? '👑' : ''}</span>
      <span class="p-ready">${isReady ? '✅' : '⏳'}</span>
    `;
    container.appendChild(div);
  });
}

function renderAlphabetGrid() {
  const grid = document.getElementById('alpha-grid');
  if (!grid) return;
  grid.innerHTML = '';
  ALPHABET.forEach(letra => {
    const btn = document.createElement('button');
    btn.className = 'alpha-btn';
    btn.textContent = letra;
    btn.dataset.letter = letra;
    btn.addEventListener('click', () => {
      socket.emit('toggle_letter', letra);
    });
    grid.appendChild(btn);
  });
}

function updateAlphaButtons() {
  if (!currentRoom) return;
  const grid = document.getElementById('alpha-grid');
  if (!grid) return;

  const sel = currentRoom.selectedLetters || [];
  const used = currentRoom.usedLetters || [];

  grid.querySelectorAll('.alpha-btn').forEach(btn => {
    const l = btn.dataset.letter;
    btn.classList.toggle('sel', sel.includes(l));
    btn.disabled = used.includes(l);
  });
}

function renderSelectedLetters() {
  const container = document.getElementById('selected-letters');
  if (!container || !currentRoom) return;

  const sel = currentRoom.selectedLetters || [];
  if (sel.length === 0) {
    container.innerHTML = '<span class="muted">El anfitrión aún no eligió letras</span>';
    return;
  }

  container.innerHTML = '';
  sel.forEach(l => {
    const isUsed = (currentRoom.usedLetters || []).includes(l);
    const chip = document.createElement('span');
    chip.className = `letter-chip ${isUsed ? 'used' : ''}`;
    chip.textContent = l;
    container.appendChild(chip);
  });
}

function handleToggleReady() {
  if (!currentRoom) return;
  const myPlayer = currentRoom.players.find(p => p.id === socket.id);
  const nextState = !(myPlayer?.ready);
  socket.emit('player_ready', nextState);
}

function updateHostStartButton() {
  if (!currentRoom || currentRoom.hostId !== socket.id) return;

  const btn = document.getElementById('btn-start');
  if (!btn) return;

  const conn = currentRoom.players.filter(p => p.connected);
  const allReady = conn.every(p => p.id === currentRoom.hostId || p.ready);
  const hasLetters = (currentRoom.selectedLetters || []).length > 0;
  const enoughPlayers = conn.length >= 2;

  btn.disabled = !(allReady && hasLetters && enoughPlayers);
}

function handleStartGame() {
  socket.emit('start_game', (res) => {
    if (res?.error) {
      showToast(res.error, 'error');
    }
  });
}

function handleLeaveRoom() {
  location.reload();
}

// ────────────────────────────────────────────────────────────────
// ROULETTE ANIMATION
// ────────────────────────────────────────────────────────────────
function runRouletteAnimation(targetLetter, round, duration) {
  document.getElementById('roulette-round').textContent = `Ronda ${round}`;
  document.getElementById('roulette-title').style.display = 'block';
  document.getElementById('slot-machine').style.display = 'block';
  document.getElementById('letter-reveal').style.display = 'none';

  const reel = document.getElementById('slot-reel');
  reel.innerHTML = '';

  // Generate 25 random lines (bars / slots)
  const symbols = ['█', '▓', '▒', '░', '◼', '◼', '◼', '◼'];
  for (let i = 0; i < 30; i++) {
    const item = document.createElement('div');
    item.className = 'slot-item';
    item.textContent = symbols[i % symbols.length];
    reel.appendChild(item);
  }

  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0px)';

  // Force reflow
  reel.offsetHeight;

  const itemHeight = 65;
  const targetOffset = -(20 * itemHeight);

  reel.style.transition = `transform ${duration - 400}ms cubic-bezier(0.15, 0.85, 0.35, 1)`;
  reel.style.transform = `translateY(${targetOffset}px)`;

  setTimeout(() => {
    document.getElementById('slot-machine').style.display = 'none';
    document.getElementById('roulette-title').style.display = 'none';

    const reveal = document.getElementById('letter-reveal');
    document.getElementById('reveal-letter').textContent = targetLetter;
    reveal.style.display = 'flex';
  }, duration - 300);
}

// ────────────────────────────────────────────────────────────────
// GAME FORM & TIMER
// ────────────────────────────────────────────────────────────────
function renderCategoryForm() {
  const form = document.getElementById('cat-form');
  if (!form) return;

  form.innerHTML = '';
  CATEGORIES.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <label class="cat-label" for="inp-cat-${cat.key}">${escapeHtml(cat.label)}</label>
      <input type="text" id="inp-cat-${cat.key}" class="cat-input" data-category="${cat.key}" placeholder="Escribe aquí..." autocomplete="off" autocapitalize="words">
    `;
    form.appendChild(row);
  });

  // Focus first input
  setTimeout(() => {
    const first = form.querySelector('input');
    if (first) first.focus();
  }, 300);
}

function startTimerRing(totalSeconds) {
  const arc = document.getElementById('tr-arc');
  const maxDash = 169.6; // 2 * PI * r (r=27)

  if (arc) {
    arc.style.strokeDashoffset = '0';
    arc.classList.remove('urgent');
  }
}

function updateTimerDisplay(secondsLeft) {
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const text = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

  document.getElementById('timer-text').textContent = text;

  const arc = document.getElementById('tr-arc');
  if (arc) {
    const total = 120;
    const fraction = (total - secondsLeft) / total;
    const offset = fraction * 169.6;
    arc.style.strokeDashoffset = `${offset}`;

    if (secondsLeft <= 15) {
      arc.classList.add('urgent');
    }
  }
}

function sendMyAnswers() {
  const answers = {};
  CATEGORIES.forEach(cat => {
    const inp = document.getElementById(`inp-cat-${cat.key}`);
    answers[cat.key] = inp ? inp.value : '';
  });
  socket.emit('submit_answers', answers);
}

// ────────────────────────────────────────────────────────────────
// ANONYMOUS CATEGORY VALIDATION & REVEAL GRID
// ────────────────────────────────────────────────────────────────
let currentCategoryStepData = null;

function renderAnonymousCategoryStep(data) {
  currentCategoryStepData = data;
  showScreen('validation');

  document.getElementById('val-cat-step-num').textContent = `Categoría ${data.categoryIndex + 1} de ${data.totalCategories}`;
  document.getElementById('val-cat-title').textContent = data.categoryLabel.toUpperCase();
  document.getElementById('val-cat-sub').textContent = 'Toca cualquier respuesta sospechosa para impugnarla (Anónimo)';

  // Reset timer bar
  const bar = document.getElementById('cat-timer-bar');
  if (bar) bar.style.width = '100%';

  // Hide vote tracker
  document.getElementById('val-vote-tracker').style.display = 'none';

  // Render cards
  const container = document.getElementById('anon-cards-wrap');
  if (!container) return;

  container.innerHTML = '';
  data.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'anon-card';
    cardEl.id = `card-${card.cardId}`;
    cardEl.dataset.targetId = card.targetPlayerId;
    cardEl.dataset.category = data.categoryKey;
    cardEl.dataset.word = card.word;

    cardEl.innerHTML = `
      <div class="ac-word">${escapeHtml(card.word)}</div>
      <div class="ac-status">${card.hasWord && card.word !== '—' ? 'Respuesta enviada' : 'Sin respuesta'}</div>
    `;

    if (card.hasWord && card.word !== '—') {
      const isMine = card.targetPlayerId === socket.id;
      if (!isMine) {
        cardEl.addEventListener('click', () => {
          openReasonModal(card.targetPlayerId, 'Jugador Anónimo', data.categoryKey, card.word);
        });
      }
    }

    container.appendChild(cardEl);
  });
}

function updateCategoryTimerBar(secondsLeft, total = 10) {
  const bar = document.getElementById('cat-timer-bar');
  if (bar) {
    const pct = Math.max(0, (secondsLeft / total) * 100);
    bar.style.width = `${pct}%`;
  }
}

function updateVoteTrackerDots(votedCount, totalVoters) {
  const tracker = document.getElementById('val-vote-tracker');
  const container = document.getElementById('vtr-dots');
  if (!tracker || !container) return;

  tracker.style.display = 'flex';
  container.innerHTML = '';

  for (let i = 0; i < totalVoters; i++) {
    const dot = document.createElement('div');
    dot.className = `vtr-dot ${i < votedCount ? 'active' : ''}`;
    container.appendChild(dot);
  }
}

function highlightChallengedCard(targetPlayerId, categoryKey) {
  const cards = document.querySelectorAll('.anon-card');
  cards.forEach(card => {
    if (card.dataset.targetId === targetPlayerId) {
      card.classList.add('challenged');
      card.classList.remove('dimmed');
    } else {
      card.classList.add('dimmed');
      card.classList.remove('challenged');
    }
  });
}

function resetChallengedCards() {
  const cards = document.querySelectorAll('.anon-card');
  cards.forEach(card => {
    card.classList.remove('challenged', 'dimmed');
  });
}

function renderValidationRevealGrid(answers, initialScores, finalScores, challenges, players, categories) {
  const container = document.getElementById('ans-grid');
  if (!container) return;

  // Order players so MY column comes FIRST
  const sortedPlayers = [...players].sort((a, b) => {
    if (a.id === socket.id) return -1;
    if (b.id === socket.id) return 1;
    return 0;
  });

  container.style.gridTemplateColumns = `125px repeat(${sortedPlayers.length}, minmax(115px, 1fr))`;
  container.innerHTML = '';

  // Header row
  const corner = document.createElement('div');
  corner.className = 'gh';
  corner.textContent = 'Categoría';
  container.appendChild(corner);

  sortedPlayers.forEach(p => {
    const gh = document.createElement('div');
    const isMe = p.id === socket.id;
    gh.className = `gh ${isMe ? 'gh-me' : ''}`;
    gh.textContent = isMe ? `${p.name} (Tú)` : p.name;
    container.appendChild(gh);
  });

  // Category rows
  categories.forEach(cat => {
    const catCell = document.createElement('div');
    catCell.className = 'gc gc-cat';
    catCell.textContent = cat.label;
    container.appendChild(catCell);

    sortedPlayers.forEach(p => {
      const cell = document.createElement('div');
      const isOwn = p.id === socket.id;
      const word = ((answers[p.id] || {})[cat.key] || '').trim();
      const scoreObj = finalScores[p.id] || {};
      const score = scoreObj[cat.key] !== undefined ? scoreObj[cat.key] : (((initialScores[p.id] || {})[cat.key]) || 0);

      // Check if this word was challenged
      const ch = (challenges || []).find(
        c => c.targetPlayerId === p.id && c.category === cat.key
      );

      let scoreClass = score === 100 ? 'ok' : (score === 50 ? 'dup' : '');
      let scoreText = word ? `${score} pts` : '0 pts';
      let cellStatusClass = '';

      if (ch) {
        if (ch.result === false) {
          cellStatusClass = 'invalidated';
          scoreText = '❌ 0 pts';
        } else if (ch.result === true) {
          cellStatusClass = 'validated';
          scoreText = `✅ ${scoreText}`;
        }
      }

      cell.className = `gc ${isOwn ? 'own' : ''} ${cellStatusClass}`;
      cell.innerHTML = `
        <div class="gc-word">${escapeHtml(word || '—')}</div>
        <div class="gc-score ${scoreClass}">${scoreText}</div>
      `;

      container.appendChild(cell);
    });
  });

  // Reset ready button
  const btnVal = document.getElementById('btn-val-ready');
  if (btnVal) {
    btnVal.disabled = false;
    btnVal.textContent = '✅ Listo';
  }
}

function updateValidationReadyStatus(readyPlayers) {
  const connCount = currentRoom ? currentRoom.players.filter(p => p.connected).length : readyPlayers.length;
  document.getElementById('val-ready-count').textContent = `${readyPlayers.length}/${connCount} listos`;
}

function renderActiveChallengeNotif(challenge) {
  const bar = document.getElementById('challenges-bar');
  if (!bar) return;

  const targetPlayer = currentRoom?.players.find(p => p.id === challenge.targetPlayerId);

  const notif = document.createElement('div');
  notif.className = 'ch-notif';
  notif.id = `notif-ch-${challenge.id}`;
  notif.innerHTML = `
    <span>⚖️ Impugnación: <b>"${escapeHtml(challenge.word)}"</b> (${escapeHtml(targetPlayer?.name || 'Jugador')})</span>
    <span class="hint">En votación...</span>
  `;
  bar.appendChild(notif);
}

function removeChallengeNotif(id) {
  const notif = document.getElementById(`notif-ch-${id}`);
  if (notif) notif.remove();
}

// ────────────────────────────────────────────────────────────────
// VOTE MODAL
// ────────────────────────────────────────────────────────────────
function showVoteModal(challenge) {
  const modal = document.getElementById('vote-modal');
  if (!modal) return;

  const targetPlayer = currentRoom?.players.find(p => p.id === challenge.targetPlayerId);
  const challenger = currentRoom?.players.find(p => p.id === challenge.challengerId);

  document.getElementById('vm-info').innerHTML = `
    <div class="ch-word">"${escapeHtml(challenge.word)}"</div>
    <div class="ch-reason-badge">Motivo: <b>${escapeHtml(challenge.reason || 'Palabra dudosa')}</b></div>
    <div class="ch-meta">Categoría: <b>${escapeHtml(challenge.category)}</b></div>
    <div class="ch-meta">Jugador: <b>${escapeHtml(targetPlayer?.name || '')}</b> | Impugnado por: <b>${escapeHtml(challenger?.name || '')}</b></div>
  `;

  updateVoteModalBars(challenge);

  const isEligible = challenge.eligibleVoters.includes(socket.id);
  const hasVoted = challenge.voters.includes(socket.id);

  document.getElementById('vm-btns').style.display = (isEligible && !hasVoted) ? 'flex' : 'none';
  document.getElementById('vm-wait').style.display = (isEligible && hasVoted) ? 'block' : 'none';

  modal.style.display = 'flex';

  // Timer countdown: 10s
  challengeSecsLeft = 10;
  document.getElementById('vm-timer').textContent = `${challengeSecsLeft}s`;
  if (challengeVoteTimer) clearInterval(challengeVoteTimer);

  challengeVoteTimer = setInterval(() => {
    challengeSecsLeft--;
    document.getElementById('vm-timer').textContent = `${challengeSecsLeft}s`;
    if (challengeSecsLeft <= 0) {
      clearInterval(challengeVoteTimer);
    }
  }, 1000);
}

function updateVoteModalBars(challenge) {
  const container = document.getElementById('vm-bars');
  if (!container) return;

  container.innerHTML = `
    <div class="vote-bar">
      <div class="vote-bar-n" style="color:var(--success)">${challenge.votesTrue}</div>
      <div class="vote-bar-l">Válida</div>
    </div>
    <div class="vote-bar">
      <div class="vote-bar-n" style="color:var(--danger)">${challenge.votesFalse}</div>
      <div class="vote-bar-l">Inválida</div>
    </div>
  `;
}

function submitVote(vote) {
  if (!activeChallenge) return;
  socket.emit('vote_challenge', { challengeId: activeChallenge.id, vote }, (res) => {
    if (res?.ok) {
      document.getElementById('vm-btns').style.display = 'none';
      document.getElementById('vm-wait').style.display = 'block';
    }
  });
}

function hideVoteModal() {
  const modal = document.getElementById('vote-modal');
  if (modal) modal.style.display = 'none';
  if (challengeVoteTimer) clearInterval(challengeVoteTimer);
  activeChallenge = null;
}

// ────────────────────────────────────────────────────────────────
// LEADERBOARD RENDER
// ────────────────────────────────────────────────────────────────
function renderLeaderboard(containerId, leaderboard, roundScores = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  leaderboard.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = `lb-item ${p.connected ? '' : 'disc'}`;

    const rndPts = roundScores && roundScores[p.id] ? roundScores[p.id].total : null;

    item.innerHTML = `
      <div class="lb-rank">#${idx + 1}</div>
      <div class="lb-name">${escapeHtml(p.name)} ${p.connected ? '' : '(Desconectado)'}</div>
      <div class="lb-scores">
        <span class="lb-total">${p.totalScore} pts</span>
        ${rndPts !== null ? `<span class="lb-rnd">+${rndPts} esta ronda</span>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

// Helper: Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
