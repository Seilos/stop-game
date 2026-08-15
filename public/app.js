'use strict';

// ────────────────────────────────────────────────────────────────
// STATE & DOM ELEMENTS
// ────────────────────────────────────────────────────────────────
let socket;
let myPlayerId = null;
let myName = '';
let currentRoom = null;
let currentRoundLetter = 'A';
let activeChallenge = null;
let challengeVoteTimer = null;
let challengeSecsLeft = 10;
let lastValidationState = null;
let currentValidationChallenges = [];

// ── Voice state ──
const voicePeers   = {};        // peerId -> { pc, stream }
let   localStream  = null;
let   micMode      = 'muted';   // 'open' | 'ptt' | 'muted'
let   hostMuted    = false;
let   vadTimers    = {};        // peerId -> intervalId
let   inVoice      = false;

// ── Chat state ──
let chatOpen      = false;
let chatUnread    = 0;

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
  spectator:        document.getElementById('screen-spectator'),
};

const GAME_SCREENS = new Set(['room','roulette','game','validation','validationReveal','scores','gameover','spectator']);

function showScreen(name) {
  Object.keys(screens).forEach(key => {
    if (screens[key]) screens[key].classList.toggle('active', key === name);
  });
  // Show comm-widget on any game/room screen
  const widget = document.getElementById('comm-widget');
  if (widget) widget.style.display = GAME_SCREENS.has(name) ? 'block' : 'none';
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
    if (inVoice) leaveVoice();
  });

  // ── Chat listeners ──
  socket.on('chat_message', ({ senderId, senderName, text }) => {
    appendChatMessage(senderId, senderName, text);
    if (!chatOpen) {
      chatUnread++;
      ['chat-unread-badge', 'comm-bubble-badge'].forEach(id => {
        const badge = document.getElementById(id);
        if (badge) { badge.textContent = chatUnread; badge.style.display = 'inline'; }
      });
    }
  });

  // ── Voice listeners ──
  socket.on('voice_peers', async (peers) => {
    for (const peerId of peers) await createPeer(peerId, true);
  });

  socket.on('voice_user_joined', async ({ peerId, name }) => {
    showToast(`${name} se unió a voz 🎤`, 'info', 2000);
    await createPeer(peerId, false);
  });

  socket.on('voice_user_left', ({ peerId }) => {
    closePeer(peerId);
  });

  socket.on('voice_members_update', (members) => {
    renderVoiceParticipants(members);
  });

  socket.on('voice_signal', async ({ from, signal }) => {
    if (!voicePeers[from]) await createPeer(from, false);
    const pc = voicePeers[from]?.pc;
    if (!pc) return;
    try {
      if (signal.offer) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice_signal', { to: from, signal: { answer } });
      } else if (signal.answer) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      }
    } catch(e) { console.warn('voice_signal err', e); }
  });

  socket.on('host_muted_you', () => {
    hostMuted = true;
    applyMicMode('muted');
    showToast('El anfitrión silenció tu micrófono 🔇', 'warn', 4000);
    // Disable the open+ptt buttons visually
    ['btn-mic-open','btn-mic-ptt'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = true; b.title = 'Silenciado por el anfitrión'; }
    });
  });

  socket.on('player_host_muted', ({ targetId }) => {
    // Update indicator in voice panel (the members_update will come right after)
  });

  socket.on('room_state', (room) => {
    currentRoom = room;
    if (room.currentLetter) currentRoundLetter = room.currentLetter;
    updateRoomUI();
    // If room reset to lobby state (e.g. Host clicked "Volver a la sala" in Game Over), switch screen to room
    if (room.state === 'lobby') {
      showScreen('room');
    }
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
    if (currentRoom) currentRoom.currentLetter = letter;
    currentRoundLetter = letter;
    showScreen('roulette');
    runRouletteAnimation(letter, round, duration);
  });

  // ── GAME PLAYING ─────────────────────────────────────────
  socket.on('round_started', ({ letter, round, duration }) => {
    if (currentRoom) currentRoom.currentLetter = letter;
    currentRoundLetter = letter;
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

    // Show vote modal for ALL connected players so everyone sees the voting progress & 2s veredicto banner!
    showVoteModal(challenge);
  });

  socket.on('category_vote_progress', (challenge) => {
    if (activeChallenge && activeChallenge.id === challenge.id) {
      activeChallenge = challenge;
      updateVoteTrackerDots(challenge.votedCount, challenge.totalVoters);
      updateVoteModalBars(challenge);
    }
  });

  socket.on('category_challenge_resolved', (challenge) => {
    // Show 2-second result banner inside the vote modal before hiding
    const modal = document.getElementById('vote-modal');
    const modalVisible = modal && modal.style.display !== 'none';

    const applyResolvedChallengeToCards = () => {
      resetChallengedCards();
      const cards = document.querySelectorAll('.anon-card');
      cards.forEach(card => {
        if (card.dataset.targetId === challenge.targetPlayerId) {
          if (challenge.result === false) {
            if (challenge.challengeType === 'DISGUISED') {
              card.classList.add('downgraded');
            } else {
              card.classList.add('invalidated');
            }
          } else {
            card.classList.add('validated');
          }
        }
      });

      const toastMsg = challenge.result === true
        ? `"${challenge.word}" — VÁLIDA ✅`
        : challenge.challengeType === 'DISGUISED'
          ? `"${challenge.word}" — Rebajada a 50 pts 🎭`
          : `"${challenge.word}" — INVÁLIDA ❌ (0 pts)`;
      showToast(toastMsg, challenge.result ? 'success' : 'warn');
    };

    if (modalVisible) {
      // Replace modal content with result banner
      const isValid = challenge.result === true;
      const isDisguised = challenge.challengeType === 'DISGUISED';
      const [icon, label, cls] = isValid
        ? ['✅', 'PALABRA VÁLIDA', 'success']
        : isDisguised
          ? ['🎭', 'REBAJADA A 50 PTS', 'warn']
          : ['❌', 'PALABRA INVÁLIDA (0 pts)', 'error'];

      document.getElementById('vm-info').innerHTML = `
        <div class="vote-result-banner ${cls}">
          <div class="vrb-icon">${icon}</div>
          <div class="vrb-word">"${escapeHtml(challenge.word)}"</div>
          <div class="vrb-label">${label}</div>
        </div>
      `;
      document.getElementById('vm-bars').innerHTML = '';
      document.getElementById('vm-btns').style.display = 'none';
      document.getElementById('vm-wait').style.display = 'none';
      document.getElementById('vm-timer').textContent = '';
      if (challengeVoteTimer) { clearInterval(challengeVoteTimer); challengeVoteTimer = null; }

      setTimeout(() => {
        hideVoteModal();
        applyResolvedChallengeToCards();
      }, 2000);
    } else {
      hideVoteModal();
      applyResolvedChallengeToCards();
    }
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
let selectedChallengeType = null;
let reasonModalTimer = null;
let reasonSecsLeft = 10;

const CHALLENGE_TYPE_LABELS = {
  'INVALID':      '❌ Palabra no existe',
  'DISGUISED':    '🎭 Repetida disfrazada',
  'OFF_CATEGORY': '🚫 Fuera de categoría',
  'NOT_A_NAME':   '👤 Nombre/Apellido inválido',
};

function openReasonModal(targetPlayerId, targetPlayerName, category, word) {
  pendingChallenge = { targetPlayerId, category, word };
  selectedChallengeType = null;
  document.getElementById('rm-target-word').innerHTML = `Impugnar <b>"${escapeHtml(word)}"</b> de <b>${escapeHtml(targetPlayerName)}</b>`;
  document.getElementById('inp-custom-reason').value = '';

  // Reset type selection
  document.querySelectorAll('.ctype-card').forEach(c => c.classList.remove('selected'));
  const submitBtn = document.getElementById('btn-submit-challenge');
  if (submitBtn) submitBtn.disabled = true;

  socket.emit('intent_challenge_word', { targetPlayerId, category }, (res) => {
    if (res?.error) {
      showToast(res.error, 'warn');
      pendingChallenge = null;
      return;
    }

    document.getElementById('reason-modal').style.display = 'flex';

    reasonSecsLeft = 10;
    const timerEl = document.getElementById('rm-timer');
    if (timerEl) timerEl.textContent = `${reasonSecsLeft}s`;
    if (reasonModalTimer) clearInterval(reasonModalTimer);

    reasonModalTimer = setInterval(() => {
      reasonSecsLeft--;
      if (timerEl) timerEl.textContent = `${reasonSecsLeft}s`;
      if (reasonSecsLeft <= 0) {
        showToast('Tiempo agotado para ingresar el motivo', 'warn');
        closeReasonModal(true);
      }
    }, 1000);
  });
}

function closeReasonModal(emitCancel = true) {
  if (reasonModalTimer) { clearInterval(reasonModalTimer); reasonModalTimer = null; }
  document.getElementById('reason-modal').style.display = 'none';
  if (emitCancel && pendingChallenge) {
    socket.emit('cancel_intent_challenge');
  }
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

  // Reason modal — challenge type card selection
  document.querySelectorAll('.ctype-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.ctype-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedChallengeType = card.dataset.type;
      const submitBtn = document.getElementById('btn-submit-challenge');
      if (submitBtn) submitBtn.disabled = false;
    });
  });
  document.getElementById('btn-reason-close').addEventListener('click', () => closeReasonModal(true));
  document.getElementById('btn-submit-challenge').addEventListener('click', () => {
    if (!pendingChallenge || !selectedChallengeType) return;
    const reason = document.getElementById('inp-custom-reason').value.trim() || '';
    const { targetPlayerId, category } = pendingChallenge;
    const challengeType = selectedChallengeType;
    closeReasonModal(false);

    socket.emit('challenge_word', { targetPlayerId, category, reason, challengeType }, (res) => {
      if (res?.error) showToast(res.error, 'warn');
    });
  });

  // Validation actions
  const btnRevealReady = document.getElementById('btn-reveal-ready');
  if (btnRevealReady) {
    btnRevealReady.addEventListener('click', () => {
      socket.emit('validation_ready', (res) => {
        if (res?.ok) {
          btnRevealReady.disabled = true;
          btnRevealReady.textContent = '✅ Esperando al resto...';
        }
      });
    });
  }

  const btnRevealAdvance = document.getElementById('btn-reveal-advance');
  if (btnRevealAdvance) {
    btnRevealAdvance.addEventListener('click', () => {
      socket.emit('advance_reveal_phase', (res) => {
        if (res?.error) showToast(res.error, 'warn');
      });
    });
  }

  const btnSpecLeave = document.getElementById('btn-spec-leave');
  if (btnSpecLeave) {
    btnSpecLeave.addEventListener('click', () => location.reload());
  }

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

  // ── Comm-bar: Voice ──
  document.getElementById('btn-join-voice').addEventListener('click', joinVoice);
  document.getElementById('btn-leave-voice').addEventListener('click', leaveVoice);

  // Mic mode buttons
  document.querySelectorAll('.mic-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (hostMuted && mode !== 'muted') return; // host-muted: can't unmute
      applyMicMode(mode);
    });
  });

  // PTT: push-to-talk (hold)
  const pttBtn = document.getElementById('btn-mic-ptt');
  pttBtn.addEventListener('mousedown',  () => { if (micMode === 'ptt') setTrackEnabled(true); });
  pttBtn.addEventListener('mouseup',    () => { if (micMode === 'ptt') setTrackEnabled(false); });
  pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); if (micMode === 'ptt') setTrackEnabled(true); });
  pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); if (micMode === 'ptt') setTrackEnabled(false); });

  // Global PTT key (Space) when in PTT mode
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && micMode === 'ptt' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      setTrackEnabled(true);
      pttBtn.classList.add('ptt-active');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && micMode === 'ptt') {
      setTrackEnabled(false);
      pttBtn.classList.remove('ptt-active');
    }
  });

  // ── Comm-bar: Collapse & Drag ──
  setupDraggableCommWidget();

  // ── Comm-bar: Chat ──
  document.getElementById('btn-toggle-chat').addEventListener('click', toggleChat);
  document.getElementById('btn-close-chat').addEventListener('click', () => toggleChat(false));

  const chatInput = document.getElementById('inp-chat');
  document.getElementById('btn-send-chat').addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
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
    if (res.isSpectator) {
      showScreen('spectator');
      document.getElementById('spec-letter').textContent = res.room.currentLetter || '—';
      document.getElementById('spec-round').textContent = res.room.currentRound || 1;
      renderLeaderboard('spec-leaderboard', gmLeaderboardFromRoom(res.room));
      showToast('Te uniste como Espectador. La partida está en curso.', 'info', 5000);
    } else {
      showScreen('room');
      updateRoomUI();
    }
  });
}

function gmLeaderboardFromRoom(room) {
  return (room.players || [])
    .map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isKicked: p.isKicked,
      isSpectator: p.isSpectator,
      totalScore: room.totalScores?.[p.id] || 0,
      roundScore: (room.currentRoundScores?.[p.id]?.total) || 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore);
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
function checkStopButtonState() {
  const btnStop = document.getElementById('btn-stop');
  if (!btnStop) return;

  const allFilled = CATEGORIES.every(cat => {
    const inp = document.getElementById(`inp-cat-${cat.key}`);
    return inp && inp.value.trim().length > 0;
  });

  btnStop.disabled = !allFilled;
}

function renderCategoryForm() {
  const form = document.getElementById('cat-form');
  if (!form) return;

  form.innerHTML = '';
  const currentLetter = (currentRoom?.currentLetter || 'A').toUpperCase();

  CATEGORIES.forEach((cat, idx) => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const randomName = `stop_field_${Math.random().toString(36).substring(7)}`;

    row.innerHTML = `
      <label class="cat-label" for="inp-cat-${cat.key}">${escapeHtml(cat.label)}</label>
      <input type="text" id="inp-cat-${cat.key}" class="cat-input" data-category="${cat.key}"
        name="${randomName}"
        autocomplete="one-time-code"
        autocorrect="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder="${currentLetter}…"
        maxlength="60">
    `;

    const inp = row.querySelector('.cat-input');
    inp.addEventListener('input', () => {
      let val = inp.value;
      if (val.length > 0) {
        const firstChar = val[0].toUpperCase();
        const normFirst = firstChar.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const normTarget = currentLetter.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        if (normFirst !== normTarget) {
          showToast(`¡Debe comenzar con la letra "${currentLetter}"!`, 'warn', 2000);
          inp.value = '';
        }
      }
      checkStopButtonState();
    });

    form.appendChild(row);
  });

  // Initial check for stop button state (disabled initially)
  checkStopButtonState();

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
  document.getElementById('val-cat-sub').textContent = 'Toca cualquier respuesta sospechosa para impugnarla';

  // Reset timer bar
  const bar = document.getElementById('cat-timer-bar');
  if (bar) bar.style.width = '100%';

  // Hide vote tracker
  document.getElementById('val-vote-tracker').style.display = 'none';

  // Render cards: SORT MY CARD FIRST
  const container = document.getElementById('anon-cards-wrap');
  if (!container) return;

  container.innerHTML = '';

  const sortedCards = [...data.cards].sort((a, b) => {
    if (a.targetPlayerId === socket.id) return -1;
    if (b.targetPlayerId === socket.id) return 1;
    return 0;
  });

  sortedCards.forEach(card => {
    const isMine = card.targetPlayerId === socket.id;
    const cardEl = document.createElement('div');
    cardEl.className = `anon-card ${isMine ? 'own' : ''}`;
    cardEl.id = `card-${card.cardId}`;
    cardEl.dataset.targetId = card.targetPlayerId;
    cardEl.dataset.category = data.categoryKey;
    cardEl.dataset.word = card.word;

    const statusLabel = isMine
      ? '👤 Tu respuesta'
      : (card.hasWord && card.word !== '—' ? 'Respuesta enviada' : 'Sin respuesta');

    const score = card.initialScore !== undefined ? card.initialScore : 0;
    const scoreBadgeClass = score === 100 ? 'ok' : (score === 50 ? 'dup' : 'bad');
    const scoreLabel = card.hasWord && card.word !== '—' ? `${score} pts` : '0 pts';

    cardEl.innerHTML = `
      <div class="ac-word">${escapeHtml(card.word)}</div>
      <div class="ac-status ${isMine ? 'me' : ''}">${statusLabel}</div>
      <div class="gc-score ${scoreBadgeClass}" style="font-weight:800;margin-top:.2rem">${scoreLabel}</div>
    `;

    if (!isMine && card.hasWord && card.word !== '—') {
      cardEl.addEventListener('click', () => {
        openReasonModal(card.targetPlayerId, 'Jugador Anónimo', data.categoryKey, card.word);
      });
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

  const isHost = currentRoom && currentRoom.hostId === socket.id;
  const hostCtrl = document.getElementById('reveal-host-ctrl');
  if (hostCtrl) hostCtrl.style.display = isHost ? 'block' : 'none';

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

    let nameText = isMe ? `${p.name} (Tú)` : p.name;
    if (p.isKicked) nameText += ' (Expulsado)';
    gh.innerHTML = `<span>${escapeHtml(nameText)}</span>`;

    if (isHost && !isMe && p.connected && !p.isKicked) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'icon-btn';
      kickBtn.style.marginLeft = '.4rem';
      kickBtn.title = 'Expulsar de la sala';
      kickBtn.innerHTML = '❌';
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`¿Expulsar a ${p.name} de la sala?`)) {
          socket.emit('kick_player', { targetPlayerId: p.id }, (res) => {
            if (res?.error) showToast(res.error, 'warn');
          });
        }
      });
      gh.appendChild(kickBtn);
    }

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
  const btnVal = document.getElementById('btn-reveal-ready');
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

  const typeLabel = CHALLENGE_TYPE_LABELS[challenge.challengeType] || '⚖️ Impugnación';

  document.getElementById('vm-info').innerHTML = `
    <div class="ch-word">"${escapeHtml(challenge.word)}"</div>
    <span class="ctype-badge ${challenge.challengeType}">${typeLabel}</span>
    ${challenge.reason ? `<div class="ch-reason-badge">💬 <b>${escapeHtml(challenge.reason)}</b></div>` : ''}
    <div class="ch-meta">Categoría: <b>${escapeHtml(challenge.category)}</b> | Por: <b>${escapeHtml(challenger?.name || 'Jugador')}</b></div>
  `;

  updateVoteModalBars(challenge);

  const isEligible = challenge.eligibleVoters?.includes(socket.id);
  const hasVoted = challenge.voters?.includes(socket.id);
  const isTarget = challenge.targetPlayerId === socket.id;
  const isChallenger = challenge.challengerId === socket.id;

  const btnWrap = document.getElementById('vm-btns');
  const waitEl = document.getElementById('vm-wait');

  if (isEligible && !hasVoted) {
    btnWrap.style.display = 'flex';
    waitEl.style.display = 'none';
  } else {
    btnWrap.style.display = 'none';
    waitEl.style.display = 'block';
    if (isTarget) {
      waitEl.textContent = '⚠️ Tu palabra está siendo impugnada. Los demás están votando…';
    } else if (isChallenger) {
      waitEl.textContent = '⚖️ Impugnación enviada. Esperando votos del resto…';
    } else if (hasVoted) {
      waitEl.textContent = '✅ Tu voto fue registrado. Esperando a los demás…';
    } else {
      waitEl.textContent = 'Votación en curso…';
    }
  }

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

// ────────────────────────────────────────────────────────────────
// VOICE SYSTEM (WebRTC Mesh)
// ────────────────────────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

async function joinVoice() {
  if (inVoice) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    inVoice = true;

    document.getElementById('voice-idle').style.display   = 'none';
    document.getElementById('voice-active').style.display = 'flex';

    // Start muted by default
    applyMicMode('muted');

    // Attach local stream tracks to any existing peer connections
    Object.values(voicePeers).forEach(({ pc }) => {
      localStream.getAudioTracks().forEach(t => {
        const senders = pc.getSenders();
        if (!senders.some(s => s.track === t)) {
          pc.addTrack(t, localStream);
        }
      });
    });

    socket.emit('voice_join', (res) => {
      if (res?.error) {
        showToast('Error al unirse a voz: ' + res.error, 'error');
        leaveVoice();
      }
    });
  } catch (err) {
    showToast('No se pudo acceder al micrófono. Revisa los permisos del navegador.', 'error', 5000);
    console.error('getUserMedia error:', err);
  }
}

function leaveVoice() {
  if (!inVoice) return;
  inVoice = false;
  hostMuted = false;

  // Stop all tracks
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  // Close all peer connections
  Object.keys(voicePeers).forEach(id => closePeer(id));

  socket.emit('voice_leave');

  document.getElementById('voice-idle').style.display   = 'flex';
  document.getElementById('voice-active').style.display = 'none';
  document.getElementById('voice-participants').innerHTML = '';

  // Re-enable mic buttons
  ['btn-mic-open','btn-mic-ptt'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.disabled = false; b.title = ''; }
  });
  applyMicMode('muted');
}

async function createPeer(peerId, isInitiator) {
  if (voicePeers[peerId]) return voicePeers[peerId].pc; // already exists

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  voicePeers[peerId] = { pc };

  // Add local audio tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // ICE candidate handler
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('voice_signal', { to: peerId, signal: { candidate } });
  };

  // Remote stream handler
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = 1.0;
      document.getElementById('audio-container').appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(e => console.log('Autoplay deferred', e));
    startVAD(stream, peerId);
  };

  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice_signal', { to: peerId, signal: { offer } });
    } catch(e) { console.warn('createOffer err', e); }
  }

  return pc;
}

function closePeer(peerId) {
  if (vadTimers[peerId]) { clearInterval(vadTimers[peerId]); delete vadTimers[peerId]; }
  if (voicePeers[peerId]) { voicePeers[peerId].pc.close(); delete voicePeers[peerId]; }
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) audio.remove();
}

function setTrackEnabled(enabled) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
}

function applyMicMode(mode) {
  micMode = mode;
  if (!localStream) return;
  if (mode === 'open')  setTrackEnabled(true);
  if (mode === 'ptt')   setTrackEnabled(false); // track enables only on hold
  if (mode === 'muted') setTrackEnabled(false);

  // Update active button highlight
  document.querySelectorAll('.mic-btn').forEach(b => {
    b.classList.toggle('active-mode', b.dataset.mode === mode);
  });
}

// Voice Activity Detection — shows speaking ring around participant avatar
function startVAD(stream, peerId) {
  if (vadTimers[peerId]) clearInterval(vadTimers[peerId]);
  try {
    const ctx      = new AudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    vadTimers[peerId] = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const el  = document.getElementById(`vp-${peerId}`);
      if (el) el.classList.toggle('speaking', avg > 15);
    }, 120);
  } catch(e) { /* AudioContext may be blocked */ }
}

function renderVoiceParticipants(members) {
  const container = document.getElementById('voice-participants');
  if (!container) return;
  container.innerHTML = '';

  const isHost = currentRoom?.hostId === socket.id;

  members.forEach(({ peerId, name }) => {
    const isMe = peerId === socket.id;
    const initials = (name || '?').charAt(0).toUpperCase();
    const color = playerColor(peerId);

    const wrap = document.createElement('div');
    wrap.className = 'vp-wrap';
    wrap.innerHTML = `
      <div class="vp-avatar" id="vp-${peerId}" style="background:${color}" title="${escapeHtml(name)}${isMe ? ' (Tú)' : ''}">
        ${initials}
        ${isMe ? '<span class="vp-me-dot"></span>' : ''}
      </div>
      ${isHost && !isMe ? `<button class="vp-mute-btn" data-target="${peerId}" title="Silenciar a ${escapeHtml(name)}">🔇</button>` : ''}
    `;

    // Host mute button
    const muteBtn = wrap.querySelector('.vp-mute-btn');
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        socket.emit('host_mute_player', { targetId: peerId });
        showToast(`${name} fue silenciado`, 'warn', 2000);
      });
    }

    container.appendChild(wrap);
  });
}

// ────────────────────────────────────────────────────────────────
// CHAT SYSTEM
// ────────────────────────────────────────────────────────────────
function toggleChat(force) {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  chatOpen = typeof force === 'boolean' ? force : !chatOpen;
  panel.style.display = chatOpen ? 'flex' : 'none';

  if (chatOpen) {
    chatUnread = 0;
    ['chat-unread-badge', 'comm-bubble-badge'].forEach(id => {
      const badge = document.getElementById(id);
      if (badge) badge.style.display = 'none';
    });
    // Scroll to bottom
    const msgs = document.getElementById('chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    document.getElementById('inp-chat')?.focus();
  }
}

function sendChatMessage() {
  const inp = document.getElementById('inp-chat');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat_message', { text });
  inp.value = '';
}

function appendChatMessage(senderId, senderName, text) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const color = playerColor(senderId);
  const isMe  = senderId === socket.id;

  const msg = document.createElement('div');
  msg.className = `chat-msg ${isMe ? 'me' : ''}`;
  msg.innerHTML = `<span class="chat-nick" style="color:${color}">${escapeHtml(senderName)}</span><span class="chat-colon">:</span> <span class="chat-text">${escapeHtml(text)}</span>`;
  container.appendChild(msg);

  // Auto-scroll if near bottom
  const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (distFromBottom < 80) container.scrollTop = container.scrollHeight;
}

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────
// Generate a stable color from a player ID (for chat nick and voice avatar)
function playerColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 65%)`;
}

// ────────────────────────────────────────────────────────────────
// DRAGGABLE & COLLAPSIBLE COMM WIDGET
// ────────────────────────────────────────────────────────────────
let commCollapsed = false;

function setupDraggableCommWidget() {
  const widget = document.getElementById('comm-widget');
  const bar = document.getElementById('comm-bar');
  const bubble = document.getElementById('comm-bubble');
  const collapseBtn = document.getElementById('btn-collapse-comm');
  const dragHandle = document.getElementById('comm-drag-handle');

  if (!widget || !bar || !bubble) return;

  // Restore saved position if present
  const savedPos = localStorage.getItem('stop_comm_pos');
  if (savedPos) {
    try {
      const { left, top } = JSON.parse(savedPos);
      widget.style.right = 'auto';
      widget.style.bottom = 'auto';
      widget.style.left = `${Math.min(Math.max(0, left), window.innerWidth - 60)}px`;
      widget.style.top = `${Math.min(Math.max(0, top), window.innerHeight - 60)}px`;
    } catch(e) {}
  }

  // Toggle collapse/expand
  const setCollapsed = (collapsed) => {
    commCollapsed = collapsed;
    if (collapsed) {
      bar.style.display = 'none';
      bubble.style.display = 'flex';
    } else {
      bar.style.display = 'flex';
      bubble.style.display = 'none';
    }
  };

  if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(true));
  if (bubble) bubble.addEventListener('click', () => setCollapsed(false));

  // Make widget draggable by handle or bubble
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const startDrag = (e) => {
    // Only drag on handle or bubble
    const isHandle = dragHandle && dragHandle.contains(e.target);
    const isBub = bubble && bubble.contains(e.target) && commCollapsed;
    if (!isHandle && !isBub) return;

    isDragging = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const rect = widget.getBoundingClientRect();
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;

    e.preventDefault();
  };

  const moveDrag = (e) => {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    let newX = clientX - offsetX;
    let newY = clientY - offsetY;

    // Bounds checking
    const maxX = window.innerWidth - widget.offsetWidth;
    const maxY = window.innerHeight - widget.offsetHeight;
    newX = Math.max(10, Math.min(newX, maxX - 10));
    newY = Math.max(10, Math.min(newY, maxY - 10));

    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
    widget.style.left = `${newX}px`;
    widget.style.top = `${newY}px`;
  };

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    const rect = widget.getBoundingClientRect();
    localStorage.setItem('stop_comm_pos', JSON.stringify({ left: rect.left, top: rect.top }));
  };

  // Mouse events
  widget.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag);

  // Touch events for mobile
  widget.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('touchend', endDrag);
}


