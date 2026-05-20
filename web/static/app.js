// Giám sát TikTok Live — frontend
let ws = null;
const giftRanking = {};
let giftCatalog = {};
let statsGifts = 0, statsComments = 0, statsFollows = 0, statsLikes = 0;
let speechRecognition = null;
let speechSynth = window.speechSynthesis;
let isListening = false;
let autoVoiceEnabled = false;
let isProcessingVoice = false;
let voiceRestartTimer = null;
let ttsQueue = [];
let ttsBusy = false;
let commentAiQueue = [];
let lastJoinGreetAt = 0;
let lastCommentAiAt = 0;
let voiceRunToken = 0;
const JOIN_GREET_COOLDOWN_MS = 3500;
const MAX_TTS_QUEUE = 6;
const TTS_OVERLOAD_QUEUE = 3;
const TTS_LIVE_COOLDOWN_MS = 2500;
const COMMENT_AI_COOLDOWN_MS = 6500;
const MAX_COMMENT_AI_QUEUE = 5;
let lastLiveTtsAt = 0;

// Chống trùng — cửa sổ 5 giây theo loại+user+nội dung (tránh lặp batch TikTokLive)
const _seen = new Set();
function isDup(key) {
  if (_seen.has(key)) return true;
  _seen.add(key);
  if (_seen.size > 500) _seen.delete(_seen.values().next().value);
  return false;
}
function dupKey(type, user, extra) {
  const ts = Math.floor(Date.now() / 5000); // cửa sổ 5 giây
  return `${type}|${user}|${extra}|${ts}`;
}

// --- Web Audio ---
let audioCtx = null;
function getAC() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playGiftSound() {
  try {
    const ctx = getAC();
    [0, 0.15].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; o.type = 'sine';
      g.gain.setValueAtTime(0.35, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.22);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
    });
  } catch(e) {}
}
function playFollowSound() {
  try {
    const ctx = getAC();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 660; o.type = 'sine';
    g.gain.setValueAtTime(0.22, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    o.start(); o.stop(ctx.currentTime + 0.28);
  } catch(e) {}
}

// --- Thanh Euler ---
const EULER_MAX_PER_MIN = 30;
function updateEulerMeter(count) {
  const pct = Math.min(100, Math.round((count / EULER_MAX_PER_MIN) * 100));
  const bar = document.getElementById('euler-bar');
  const txt = document.getElementById('euler-count');
  if (!bar || !txt) return;
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? '#f44336' : pct > 50 ? '#ff9800' : '#4caf50';
  txt.textContent = `${count}/phút`;
}

// --- Voice assistant (free, browser-based STT/TTS + Groq chat API) ---
function updateVoiceStatus(msg) {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = msg;
}

function updateVoiceLast(msg) {
  const el = document.getElementById('voice-last');
  if (el) el.textContent = msg;
}

function setVoiceButtons(listening) {
  const startBtn = document.getElementById('voice-start-btn');
  const stopBtn = document.getElementById('voice-stop-btn');
  if (startBtn) startBtn.disabled = autoVoiceEnabled || listening;
  if (stopBtn) stopBtn.disabled = !(autoVoiceEnabled || listening || isProcessingVoice);
}

function clearVoiceRestartTimer() {
  if (!voiceRestartTimer) return;
  clearTimeout(voiceRestartTimer);
  voiceRestartTimer = null;
}

function scheduleNextListen(delayMs = 500) {
  if (!autoVoiceEnabled || isListening || isProcessingVoice) return;
  clearVoiceRestartTimer();
  voiceRestartTimer = setTimeout(() => {
    voiceRestartTimer = null;
    if (autoVoiceEnabled && !isListening && !isProcessingVoice) {
      startVoiceListen();
    }
  }, delayMs);
}

function _speakOnce(text, { interrupt = true } = {}) {
  return new Promise((resolve) => {
    if (!text || !speechSynth) {
      resolve();
      return;
    }
    try {
      if (interrupt) speechSynth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'vi-VN';
      u.rate = 1;
      u.pitch = 1;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynth.speak(u);
    } catch (_) {
      resolve();
    }
  });
}

async function ttsDrainQueue() {
  if (ttsBusy) return;
  ttsBusy = true;
  try {
    while (ttsQueue.length > 0) {
      if (autoVoiceEnabled || isListening || isProcessingVoice) {
        ttsQueue = [];
        break;
      }
      const item = ttsQueue.shift();
      if (!item || !item.text) continue;
      // Không interrupt khi đang phát hàng đợi, để nghe tự nhiên.
      await _speakOnce(item.text, { interrupt: false });
    }
  } finally {
    ttsBusy = false;
  }
}

function ttsEnqueue(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (autoVoiceEnabled || isListening || isProcessingVoice) return;

  const now = Date.now();
  const isOverload = ttsQueue.length >= TTS_OVERLOAD_QUEUE || now - lastLiveTtsAt < TTS_LIVE_COOLDOWN_MS;
  if (isOverload && Math.random() > 0.28) return;
  lastLiveTtsAt = now;

  // Khi live dồn dập, không đọc hết. Giữ hàng đợi ngắn và thay ngẫu nhiên
  // một câu cũ để âm thanh không bị kéo dài hoặc bị cắt ngang liên tục.
  if (ttsQueue.length >= MAX_TTS_QUEUE) {
    const replaceIndex = Math.floor(Math.random() * MAX_TTS_QUEUE);
    ttsQueue[replaceIndex] = { text: t };
    return;
  }
  ttsQueue.push({ text: t });
  ttsDrainQueue();
}

function ttsClearAll() {
  ttsQueue = [];
  try { if (speechSynth) speechSynth.cancel(); } catch (_) {}
}

// Dùng cho voice assistant: chỉ cancel tiếng cũ ở đầu lượt, không tự ngắt giữa comment và câu trả lời.
function speakText(text) {
  return _speakOnce(text, { interrupt: false });
}

async function askVoiceAI(text) {
  const response = await fetch('/api/voice/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Không gọi được trợ lý AI');
  return data.reply || '';
}

function enqueueCommentAI(profile, text) {
  if (!autoVoiceEnabled) return;
  const msg = String(text || '').replace(/\s+/g, ' ').trim();
  if (!msg || msg.length > 220) return;

  const now = Date.now();
  const busy = isProcessingVoice || commentAiQueue.length > 0 || now - lastCommentAiAt < COMMENT_AI_COOLDOWN_MS;
  if (busy && Math.random() > 0.35) return;

  const item = { profile, text: msg };
  if (commentAiQueue.length >= MAX_COMMENT_AI_QUEUE) {
    commentAiQueue[Math.floor(Math.random() * MAX_COMMENT_AI_QUEUE)] = item;
  } else {
    commentAiQueue.push(item);
  }
  processCommentAIQueue();
}

async function processCommentAIQueue() {
  if (!autoVoiceEnabled || isProcessingVoice || commentAiQueue.length === 0) return;
  const item = commentAiQueue.shift();
  if (!item) return;

  isProcessingVoice = true;
  lastCommentAiAt = Date.now();
  const runToken = voiceRunToken;
  ttsQueue = [];
  try { if (speechSynth) speechSynth.cancel(); } catch (_) {}
  setVoiceButtons(false);

  const name = displayName(item.profile);
  const question = `${name} bình luận: ${item.text}`;
  updateVoiceLast(question);
  updateVoiceStatus('Đang trả lời comment...');

  try {
    await speakText(question);
    if (!autoVoiceEnabled || runToken !== voiceRunToken) return;

    const reply = await askVoiceAI(`Trả lời comment TikTok Live của ${name}: ${item.text}`);
    if (!autoVoiceEnabled || runToken !== voiceRunToken) return;

    updateVoiceLast(`${question} | Bot: ${reply}`);
    await speakText(reply);
    if (!autoVoiceEnabled || runToken !== voiceRunToken) return;

    updateVoiceStatus(autoVoiceEnabled ? 'Đang chờ comment tiếp theo...' : 'Đã tắt trả lời comment');
  } catch (e) {
    updateVoiceStatus(`Lỗi AI: ${e.message || e}`);
  } finally {
    isProcessingVoice = false;
    setVoiceButtons(false);
    if (autoVoiceEnabled) {
      setTimeout(processCommentAIQueue, COMMENT_AI_COOLDOWN_MS);
    }
  }
}

function startVoiceListen() {
  autoVoiceEnabled = true;
  voiceRunToken++;
  isListening = false;
  clearVoiceRestartTimer();
  ttsClearAll();
  updateVoiceStatus('Đang bật AI trả lời comment...');
  updateVoiceLast('Bot sẽ chọn ngẫu nhiên comment để đọc và trả lời.');
  setVoiceButtons(false);
  processCommentAIQueue();
}

function stopVoiceListen() {
  autoVoiceEnabled = false;
  voiceRunToken++;
  isProcessingVoice = false;
  commentAiQueue = [];
  clearVoiceRestartTimer();
  ttsClearAll();
  updateVoiceStatus('Đã tắt AI trả lời comment');
  setVoiceButtons(false);
  if (!speechRecognition || !isListening) return;
  try {
    speechRecognition.stop();
  } catch (_) {}
}

// --- WebSocket ---
function connectLive() {
  const username = document.getElementById('username-input').value.trim();
  if (!username) return;
  getAC();
  const name = username.startsWith('@') ? username : '@' + username;
  setStatus('Đang kết nối...');

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'connect', username: name }));
    return;
  }
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ action: 'connect', username: name }));
  ws.onmessage = e => handleEvent(JSON.parse(e.data));
  ws.onclose = () => setStatus('Đã ngắt kết nối');
  ws.onerror = () => setStatus('Lỗi WebSocket');
}

function handleEvent(data) {
  switch (data.type) {
    case 'status':      setStatus(data.message); break;
    case 'error':       setStatus('\u274c ' + data.message); break;
    case 'connect':     setStatus(`\u2705 Đã kết nối tới ${data.username}`); break;
    case 'disconnect':  setStatus('\u26a0\ufe0f Đã ngắt kết nối'); break;
    case 'live_end':    setStatus('\ud83d\udd34 Live đã kết thúc'); break;
    case 'viewers':     document.getElementById('stat-viewers').textContent = fmtNum(data.count); break;
    case 'comment':     addComment(data); break;
    case 'gift':        addGift(data); break;
    case 'follow':      addFollow(data); break;
    case 'join':        addJoin(data); break;
    case 'share':       addEventFeed('đã chia sẻ', data.nickname, data.user, '\ud83d\udd17', getProfile(data)); break;
    case 'like':        addLike(data); break;
    case 'euler_stats': updateEulerMeter(data.count); break;
    case 'euler_limits': updateEulerLimits(data.limits); break;
    case 'room_info':    updateRoomInfo(data.room); break;
    case 'gift_catalog': updateGiftCatalog(data.catalog); break;
  }
}

function getProfile(d) {
  return d.profile || {
    username: d.user || '',
    nickname: d.nickname || '',
    avatar: d.avatar || '',
    verified: false,
    followers: 0,
    following: 0,
    user_id: '',
    sec_uid: ''
  };
}

function displayName(profile) {
  return profile.nickname || profile.username || 'Chưa có tên';
}

function userHandle(profile) {
  return profile.username ? '@' + profile.username : '';
}

function profileTitle(profile) {
  const parts = [
    `tên=${displayName(profile)}`,
    `user=${profile.username || '-'}`,
    `id=${profile.user_id || '-'}`,
    `xác minh=${profile.verified ? 'có' : 'không'}`,
    `người theo dõi=${profile.followers || 0}`,
    `đang theo=${profile.following || 0}`
  ];
  return parts.join(' | ');
}

function placeholderAvatar(name) {
  const letter = esc((displayName(name || {}).slice(0, 1) || '?').toUpperCase());
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='100%' height='100%' fill='#232323'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='#bbbbbb' font-family='Segoe UI, Arial, sans-serif' font-size='28'>${letter}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeUrl(url, fallback = '') {
  const value = String(url || '').trim();
  if (!value) return fallback;
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('data:image/')
  ) {
    return value;
  }
  return fallback;
}

function avatarMarkup(profile, cls = '') {
  const fallback = placeholderAvatar(profile);
  const safeSrc = safeUrl(profile && profile.avatar, fallback);
  const safeClass = escAttr(cls);
  const safeSrcAttr = escAttr(safeSrc);
  const fallbackAttr = escAttr(fallback);
  return `<img class="${safeClass}" src="${safeSrcAttr}" data-fallback="${fallbackAttr}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=this.dataset.fallback" alt="" />`;
}

function addComment(d) {
  const key = dupKey('comment', d.user, d.text);
  if (isDup(key)) return;
  const profile = getProfile(d);
  statsComments++;
  document.getElementById('stat-comments').textContent = statsComments;
  const feed = document.getElementById('comment-feed');
  const el = document.createElement('div');
  el.className = 'comment-item';
  el.title = profileTitle(profile);
  el.innerHTML = `
    ${avatarMarkup(profile)}
    <div class="comment-content">
      <div class="user-line">
        <span class="display-name">${esc(displayName(profile))}</span>
        ${profile.verified ? '<span class="verified">✓</span>' : ''}
        <span class="uname">${esc(userHandle(profile))}</span>
      </div>
      <div class="text">${esc(d.text)}</div>
    </div>`;
  feed.prepend(el);
  trim(feed, 120);

  if (autoVoiceEnabled) {
    enqueueCommentAI(profile, d.text);
  } else {
    const commentRead = buildCommentRead(profile, d.text);
    if (commentRead) ttsEnqueue(commentRead);
  }
}

function addGift(d) {
  const key = dupKey('gift', d.user, d.gift_name + d.gift_count);
  if (isDup(key)) return;
  const profile = getProfile(d);
  const giftMeta = giftCatalog[d.gift_name] || {};
  statsGifts++;
  document.getElementById('stat-gifts').textContent = statsGifts;
  playGiftSound();
  const feed = document.getElementById('gift-feed');
  const el = document.createElement('div');
  el.className = 'gift-item';
  el.title = profileTitle(profile);
  el.innerHTML = `
    ${avatarMarkup(profile)}
    <div>
      <div>
        <span class="gift-user">${esc(displayName(profile))}</span>
        <span class="muted-user">${esc(userHandle(profile))}</span>
        ${profile.verified ? '<span class="verified">✓</span>' : ''}
      </div>
      <div>
        ${giftMeta.image ? `<img class="gift-icon" src="${giftMeta.image}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : ''}
        <span class="gift-name">${esc(d.gift_name)}</span>
        ${giftMeta.diamond_count ? `<span class="gift-count">${giftMeta.diamond_count} 💎</span>` : ''}
        ${d.gift_count>1?` <span class="gift-count">x${d.gift_count}</span>`:''}
      </div>
    </div>`;
  feed.prepend(el);
  trim(feed, 60);
  if (!giftRanking[d.user]) giftRanking[d.user] = { nickname: d.nickname, avatar: d.avatar, count: 0, profile };
  giftRanking[d.user].count += d.gift_count || 1;
  giftRanking[d.user].profile = profile;
  renderRanking();

  // Đọc cảm ơn theo số xu (coin_value * số lượng)
  try {
    const coinEach = Number(d.coin_value || 0) || 0;
    const qty = Number(d.gift_count || 1) || 1;
    const total = Math.max(0, coinEach * qty);
    const name = displayName(profile);
    const giftName = String(d.gift_name || 'quà').trim() || 'quà';
    const thanks = buildGiftThanks({ name, giftName, qty, total });
    if (thanks) ttsEnqueue(thanks);
  } catch (_) {}
}

function pick(arr) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildGiftThanks({ name, giftName, qty, total }) {
  const n = String(name || '').trim() || 'bạn';
  const g = String(giftName || '').trim() || 'quà';
  const q = Number(qty || 1) || 1;
  const t = Number(total || 0) || 0;

  const giftPart = q > 1 ? `${q} ${g}` : g;
  const valuePart = t > 0 ? `, tổng ${fmtNum(t)} xu` : '';
  const giftDetail = `${giftPart}${valuePart}`;

  // Câu phải "giống thật": ngắn, tự nhiên, không quá khuôn mẫu
  if (t >= 1000) {
    return pick([
      `${n} chơi lớn quá, cảm ơn ${n} đã tặng ${giftDetail}.`,
      `Ui ${n}, ${giftDetail} VIP thật. Cảm ơn ${n} nha.`,
      `Cảm ơn ${n} nhiều lắm, phần quà ${giftDetail} quá xịn luôn.`,
      `${n} tặng ${giftDetail} mà đỉnh quá. Cảm ơn nha.`,
    ]);
  }
  if (t >= 200) {
    return pick([
      `Cảm ơn ${n} nha, ${giftDetail} xịn quá.`,
      `Đỉnh quá ${n}, cảm ơn nhiều vì ${giftDetail}.`,
      `${n} tặng ${giftDetail} là mình vui liền. Cảm ơn nha.`,
      `Cảm ơn ${n} nhiều nha, ${giftDetail} quá có tâm.`,
    ]);
  }
  if (t >= 50) {
    return pick([
      `Cảm ơn ${n} nha, mình nhận được ${giftDetail}.`,
      `Cảm ơn ${n} nhiều vì ${giftDetail}.`,
      `${n} dễ thương quá, cảm ơn vì ${giftDetail}.`,
      `Cảm ơn ${n} đã tặng ${giftDetail}.`,
    ]);
  }
  // xu ít: đơn giản, gọn
  return pick([
    `Cảm ơn ${n} đã tặng ${giftDetail}.`,
    `Cảm ơn ${n} nha, mình nhận được ${giftDetail}.`,
    `Cảm ơn ${n} tặng ${giftDetail}.`,
    `Cảm ơn nha ${n}, phần quà ${giftDetail} dễ thương quá.`,
  ]);
}

function addFollow(d) {
  const key = dupKey('follow', d.user, '');
  if (isDup(key)) return;
  const profile = getProfile(d);
  statsFollows++;
  document.getElementById('stat-follows').textContent = statsFollows;
  playFollowSound();
  addEventFeed('đã theo dõi', d.nickname, d.user, '\u2764\ufe0f', profile);
}

function addJoin(d) {
  const key = dupKey('join', d.user, '');
  if (isDup(key)) return;
  const profile = getProfile(d);
  addEventFeed('đã vào phòng', d.nickname, d.user, '\ud83d\udfe2', profile);
  if (autoVoiceEnabled || isProcessingVoice) return;

  // Chào người mới với cooldown để không bị spam khi phòng đông.
  const now = Date.now();
  if (now - lastJoinGreetAt < JOIN_GREET_COOLDOWN_MS) return;
  lastJoinGreetAt = now;
  const welcome = buildJoinWelcome(profile);
  if (welcome) ttsEnqueue(welcome);
}

function buildJoinWelcome(profile) {
  const n = displayName(profile);
  const hasUser = !!(profile && profile.username);

  const simple = [
    `Chào mừng ${n} vừa vào phòng nha.`,
    `Hello ${n}, vào chơi vui vẻ nha.`,
    `Welcome ${n}, cảm ơn bạn đã ghé live.`,
    `${n} mới vào room, chào bạn nha.`,
  ];
  const withHandle = [
    `Chào ${n}, @${profile.username} vào đúng lúc luôn.`,
    `Chào mừng ${n}, @${profile.username} ơi ở lại chơi nha.`,
    `${n} ghé live rồi, @${profile.username} thấy được thì chào mọi người nhé.`,
  ];
  return hasUser ? pick([...simple, ...withHandle]) : pick(simple);
}

function buildCommentRead(profile, text) {
  const msg = String(text || '').replace(/\s+/g, ' ').trim();
  if (!msg || msg.length > 120) return '';
  const n = displayName(profile);
  return pick([
    `${n} bình luận: ${msg}`,
    `${n} nói: ${msg}`,
    `Comment của ${n}: ${msg}`,
  ]);
}

function addLike(d) {
  const key = dupKey('like', d.user, '');
  if (isDup(key)) return;
  const profile = getProfile(d);
  statsLikes++;
  const el = document.getElementById('stat-likes');
  if (el) el.textContent = fmtNum(statsLikes);
  addEventFeed('đã thích', d.nickname, d.user, '\ud83d\udc4d', profile);
}

function addEventFeed(tipo, nickname, user, icon = '\u2022') {
  const feed = document.getElementById('event-feed');
  if (!feed) return;
  const profile = arguments[4] || { username: user || '', nickname: nickname || '', verified: false, followers: 0, following: 0, user_id: '' };
  const el = document.createElement('div');
  el.className = 'event-item';
  el.title = profileTitle(profile);
  el.innerHTML = `${avatarMarkup(profile, 'event-avatar')} ${icon} <span class="ev-name">${esc(displayName(profile))}</span> <span class="ev-user">${esc(userHandle(profile))}</span> ${tipo}`;
  feed.prepend(el);
  trim(feed, 80);
}

function renderRanking() {
  const sorted = Object.entries(giftRanking).sort((a,b)=>b[1].count-a[1].count).slice(0,10);
  document.getElementById('ranking').innerHTML = sorted.map(([user,info],i) => {
    const p = i+1, m = p===1?'\ud83e\udd47':p===2?'\ud83e\udd48':p===3?'\ud83e\udd49':p;
    const profile = info.profile || { username: user || '', nickname: info.nickname || '', avatar: info.avatar || '', verified: false, followers: 0, following: 0, user_id: '' };
    return `<div class="rank-item">
      <span class="rank-pos">${m}</span>
      ${avatarMarkup(profile)}
      <span class="rname">${esc(displayName(profile))} <span class="muted-user">${esc(userHandle(profile))}</span></span>
      <span class="rcount">${info.count} \ud83c\udf81</span>
    </div>`;
  }).join('');
}

function updateGiftCatalog(catalog) {
  giftCatalog = {};
  const gifts = (catalog && catalog.gifts) || [];
  gifts.forEach(gift => {
    if (gift && gift.name) giftCatalog[gift.name] = gift;
  });
}

function updateEulerLimits(limits) {
  const minute = limits && limits.minute ? limits.minute : {};
  const hour = limits && limits.hour ? limits.hour : {};
  const day = limits && limits.day ? limits.day : {};
  document.getElementById('limit-minute-remaining').textContent = minute.remaining ?? '-';
  document.getElementById('limit-minute-max').textContent = `/ ${minute.max ?? '-'}`;
  document.getElementById('limit-hour-remaining').textContent = hour.remaining ?? '-';
  document.getElementById('limit-hour-max').textContent = `/ ${hour.max ?? '-'}`;
  document.getElementById('limit-day-remaining').textContent = day.remaining ?? '-';
  document.getElementById('limit-day-max').textContent = `/ ${day.max ?? '-'}`;
}

function updateRoomInfo(room) {
  const creator = room && room.creator ? room.creator : {};
  const title = (room && room.title) || 'Live không có tiêu đề';
  const creatorLine = [
    displayName(creator),
    userHandle(creator),
    creator.verified ? 'đã xác minh' : '',
    room && room.current_viewers ? `${fmtNum(room.current_viewers)} đang xem` : ''
  ].filter(Boolean).join(' • ');
  document.getElementById('live-title').textContent = title;
  document.getElementById('creator-meta').textContent = creatorLine || 'Chưa có dữ liệu live';

  const avatar = document.getElementById('creator-avatar');
  avatar.src = safeUrl(creator.avatar, placeholderAvatar(creator));
  avatar.onerror = () => {
    avatar.onerror = null;
    avatar.src = placeholderAvatar(creator);
  };

  const cover = document.getElementById('live-cover');
  const coverUrl = safeUrl(room && room.cover, '');
  if (coverUrl) {
    cover.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.55)), url("${coverUrl}")`;
  } else {
    cover.style.backgroundImage = 'linear-gradient(135deg, #1b1b1b, #090909)';
  }
}

function setStatus(msg) { document.getElementById('status-text').textContent = msg; }
function trim(el, max) { while (el.children.length > max) el.removeChild(el.lastChild); }
function fmtNum(n) {
  if (n>=1e6) return (n/1e6).toFixed(1)+'M';
  if (n>=1000) return (n/1000).toFixed(1)+'K';
  return n;
}
function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('username-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') connectLive();
  });
  setVoiceButtons(false);
  updateVoiceStatus('Sẵn sàng');
});
