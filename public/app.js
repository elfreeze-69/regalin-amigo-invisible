'use strict';

const $ = id => document.getElementById(id);
const state = {
  code: null,
  token: null,
  me: null,
  room: null,
  tab: 'create',
  recipient: null,
  polling: null,
  refreshing: null,
};

function sessionKey(code) { return `regalin:session:${code}`; }

function saveSession(code, token) {
  try { localStorage.setItem(sessionKey(code), token); } catch (_) { /* Navegación privada */ }
}

function readSession(code) {
  try { return localStorage.getItem(sessionKey(code)); } catch (_) { return null; }
}

function forgetSession(code) {
  try { localStorage.removeItem(sessionKey(code)); } catch (_) { /* No disponible */ }
}

function setTab(tab) {
  state.tab = tab;
  const create = tab === 'create';
  $('tab-create').classList.toggle('active', create);
  $('tab-join').classList.toggle('active', !create);
  $('tab-create').setAttribute('aria-selected', String(create));
  $('tab-join').setAttribute('aria-selected', String(!create));
  $('create-form').classList.toggle('hidden', !create);
  $('join-form').classList.toggle('hidden', create);
}

function showHome(tab = 'create') {
  stopPolling();
  state.code = null;
  state.token = null;
  state.me = null;
  state.room = null;
  state.recipient = null;
  $('room-view').classList.add('hidden');
  $('home-view').classList.remove('hidden');
  setTab(tab);
}

let toastTimeout;
function toast(message, isError = false) {
  const item = $('toast');
  item.textContent = message;
  item.classList.toggle('error', isError);
  item.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => item.classList.remove('visible'), 4000);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(`/api${path}`, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, cache: 'no-store' });
  } catch (_) {
    throw new Error('No se pudo conectar. Comprueba tu conexión a Internet.');
  }
  let result;
  try { result = await response.json(); } catch (_) { result = {}; }
  if (!response.ok) {
    const error = new Error(result.error || `Error del servidor (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function setBusy(button, busy, loadingText) {
  const label = button.querySelector('span:first-child');
  if (!button.dataset.normalLabel) button.dataset.normalLabel = label.textContent;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  label.textContent = busy ? loadingText : button.dataset.normalLabel;
}

function urlForRoom(code) {
  return `${window.location.origin}/?sala=${encodeURIComponent(code)}`;
}

function openRoom(code, token) {
  state.code = code;
  state.token = token;
  state.recipient = null;
  saveSession(code, token);
  $('home-view').classList.add('hidden');
  $('room-view').classList.remove('hidden');
  history.pushState(null, '', `/?sala=${encodeURIComponent(code)}`);
  loadRoom();
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

function startPolling() {
  stopPolling();
  state.polling = setInterval(() => {
    if (document.visibilityState === 'visible') loadRoom(true);
  }, 5000);
}

async function loadRoom(silent = false) {
  if (!state.code || !state.token || state.refreshing === state.code) return;
  const code = state.code;
  const token = state.token;
  state.refreshing = code;
  try {
    const [roomResult, meResult] = await Promise.all([
      api(`/rooms/${code}`), api(`/rooms/${code}/me`, { token }),
    ]);
    if (code !== state.code || token !== state.token) return;
    state.room = roomResult.room;
    state.me = meResult.me;
    renderRoom();
    if (!state.polling) startPolling();
  } catch (error) {
    if (code !== state.code) return;
    if (error.status === 401 || error.status === 404) {
      forgetSession(code);
      showHome('join');
      $('join-code').value = code;
      toast(error.status === 401 ? 'Tu acceso ya no es válido. Necesitas volver a unirte.' : error.message, true);
    } else if (!silent) {
      toast(error.message, true);
    }
  } finally { if (state.refreshing === code) state.refreshing = null; }
}

function formattedDate(value) {
  if (!value) return '';
  try { return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)); }
  catch (_) { return value; }
}

function makeMember(member, index) {
  const item = document.createElement('div');
  const mine = member.name === state.me.name;
  item.className = `member${mine ? ' mine' : ''}`;
  const avatar = document.createElement('span');
  avatar.className = `avatar ${['a', 'b', 'c', 'd', 'e'][index % 5]}`;
  avatar.textContent = [...member.name][0]?.toLocaleUpperCase('es') || '?';
  const text = document.createElement('span');
  text.className = 'member-name';
  text.textContent = member.name;
  if (mine) {
    const badge = document.createElement('small');
    badge.textContent = state.me.isHost ? 'Tú · Organizador' : 'Tú';
    text.append(badge);
  }
  item.append(avatar, text);
  return item;
}

function renderRoom() {
  if (!state.room || !state.me) return;
  const room = state.room;
  const drawn = room.status === 'drawn';
  $('home-view').classList.add('hidden');
  $('room-view').classList.remove('hidden');
  $('room-heading-title').textContent = room.title;
  $('room-code').textContent = room.code;
  $('room-step-label').textContent = drawn ? 'EL SORTEO ESTÁ HECHO' : 'TU SALA ESTÁ LISTA';
  const details = [];
  if (room.budget != null) details.push(`Presupuesto: ${Number(room.budget).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`);
  if (room.gift_date) details.push(`Entrega: ${formattedDate(room.gift_date)}`);
  $('room-detail-text').textContent = details.join(' · ') || 'Comparte el código para que se una todo el grupo.';
  $('room-status').className = `room-status ${drawn ? 'done' : 'waiting'}`;
  $('room-status').replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $('room-status').append(dot, document.createTextNode(drawn ? ' Sorteo realizado' : ' Esperando al grupo'));
  $('member-count').textContent = `${room.count} / ${room.maxMembers}`;
  const memberList = $('member-list');
  memberList.replaceChildren(...room.members.map(makeMember));
  $('host-actions').classList.toggle('hidden', drawn || !state.me.isHost);
  $('guest-message').classList.toggle('hidden', drawn || state.me.isHost);
  $('result-section').classList.toggle('hidden', !drawn);

  if (state.me.isHost && !drawn) {
    $('draw-button').disabled = room.count < 2;
    $('host-note').textContent = room.count < 2
      ? 'Necesitas al menos 2 participantes para hacer el sorteo.'
      : '¿Ya está todo el mundo? El resultado será definitivo y nadie podrá entrar después.';
  }
  $('reveal-button').classList.toggle('hidden', !!state.recipient);
  $('revealed-name').classList.toggle('hidden', !state.recipient);
  if (state.recipient) $('recipient-name').textContent = state.recipient;
}

function launchConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#6859f6', '#f2bd71', '#a1d8bb', '#ff9fb8', '#9dbcf0'];
  for (let index = 0; index < 52; index++) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.backgroundColor = colors[index % colors.length];
    piece.style.setProperty('--falltime', `${2.2 + Math.random() * 2.1}s`);
    piece.style.animationDelay = `${Math.random() * .45}s`;
    document.body.append(piece);
    setTimeout(() => piece.remove(), 5100);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* Fallback */ }
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (_) { /* No permitido */ }
  input.remove();
  return copied;
}

$('tab-create').addEventListener('click', () => setTab('create'));
$('tab-join').addEventListener('click', () => setTab('join'));
$('join-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/\s/g, ''); });

$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('create-button');
  setBusy(button, true, 'Creando sala...');
  try {
    const result = await api('/rooms', { method: 'POST', body: {
      title: $('room-title').value,
      name: $('host-name').value,
      budget: $('budget').value,
      giftDate: $('gift-date').value,
    } });
    openRoom(result.code, result.token);
    toast('¡Sala creada! Comparte el código con tus amigos.');
  } catch (error) {
    toast(error.message, true);
  } finally { setBusy(button, false); }
});

$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('join-button');
  setBusy(button, true, 'Entrando...');
  const code = $('join-code').value.toUpperCase().trim();
  try {
    // Si ya perteneces a esa sala, reutiliza tu token personal.
    const previous = readSession(code);
    if (previous) {
      openRoom(code, previous);
    } else {
      const result = await api(`/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { name: $('join-name').value } });
      openRoom(result.code, result.token);
      toast('¡Ya formas parte del amigo invisible!');
    }
  } catch (error) {
    toast(error.message, true);
  } finally { setBusy(button, false); }
});

$('draw-button').addEventListener('click', async () => {
  if (!state.room || state.room.count < 2 || !state.me?.isHost) return;
  if (!window.confirm('¿Seguro que ya está todo el mundo? El sorteo será definitivo y no podrán entrar más personas.')) return;
  const button = $('draw-button');
  setBusy(button, true, 'Sorteando...');
  try {
    await api(`/rooms/${state.code}/draw`, { method: 'POST', token: state.token });
    await loadRoom();
    toast('¡Sorteo realizado! Cada persona ya puede abrir su sobre.');
    launchConfetti();
  } catch (error) {
    toast(error.message, true);
    await loadRoom(true);
  } finally { setBusy(button, false); }
});

$('reveal-button').addEventListener('click', async () => {
  const button = $('reveal-button');
  setBusy(button, true, 'Abriendo sobre...');
  try {
    const data = await api(`/rooms/${state.code}/reveal`, { token: state.token });
    state.recipient = data.recipient;
    renderRoom();
    launchConfetti();
    $('revealed-name').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    toast(error.message, true);
  } finally { setBusy(button, false); }
});

$('copy-code').addEventListener('click', async () => {
  const success = await copyText(state.code || '');
  toast(success ? '¡Código copiado!' : 'No se ha podido copiar. Selecciona el código manualmente.', !success);
});

$('share-link').addEventListener('click', async () => {
  if (!state.code) return;
  const url = urlForRoom(state.code);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Amigo invisible · Regalín', text: `Únete al amigo invisible «${state.room?.title || 'de nuestro grupo'}». Código: ${state.code}`, url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  const success = await copyText(url);
  toast(success ? '¡Enlace copiado! Envíalo al grupo.' : 'No se pudo copiar el enlace.', !success);
});

function returnHome(event) {
  event.preventDefault();
  history.pushState(null, '', '/');
  showHome('create');
}
$('brand-home').addEventListener('click', returnHome);
$('back-home').addEventListener('click', returnHome);

function restoreFromUrl() {
  stopPolling();
  const url = new URL(window.location.href);
  const code = (url.searchParams.get('sala') || '').toUpperCase().trim();
  if (!code) { showHome('create'); return; }
  const token = readSession(code);
  if (token) {
    state.code = code;
    state.token = token;
    state.room = null;
    state.me = null;
    state.recipient = null;
    $('home-view').classList.add('hidden');
    $('room-view').classList.remove('hidden');
    loadRoom();
  } else {
    showHome('join');
    $('join-code').value = code;
  }
}

window.addEventListener('popstate', restoreFromUrl);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.code) loadRoom(true);
});
restoreFromUrl();
