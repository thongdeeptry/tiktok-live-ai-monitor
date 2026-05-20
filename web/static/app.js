// Giám sát TikTok Live — frontend
let ws = null;
const giftRanking = {};
let giftCatalog = {};
let statsGifts = 0, statsComments = 0, statsFollows = 0, statsLikes = 0;
let speechRecognition = null;
let speechSynth = window.speechSynthesis;
let isListening = false;
let autoVoiceEnabled = true;
let isProcessingVoice = false;
let ttsQueue = [];
let ttsBusy = false;
let commentAiQueue = [];
let lastJoinGreetAt = 0;
let voiceRunToken = 0;
let preferredVoice = null;
let selectedVoiceURI = localStorage.getItem('ttsVoiceURI') || '';
const EDGE_TTS_VOICE = 'vi-VN-HoaiMyNeural';
const JOIN_GREET_COOLDOWN_MS = 3500;
const COMMENT_AI_COOLDOWN_MS = 6500;
let ttsOrder = 0;

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
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
}

function getPreferredVoice() {
  if (preferredVoice || !speechSynth) return preferredVoice;
  return refreshPreferredVoice();
}

function refreshPreferredVoice() {
  if (!speechSynth) return null;
  const voices = speechSynth.getVoices ? speechSynth.getVoices() : [];
  if (selectedVoiceURI) {
    preferredVoice = voices.find(voice => voice.voiceURI === selectedVoiceURI) || null;
    if (preferredVoice) {
      console.log('Selected TTS voice:', preferredVoice.name, preferredVoice.lang);
      populateVoiceSelect(voices);
      return preferredVoice;
    }
  }
  const scored = voices
    .map(voice => ({ voice, score: voiceScore(voice) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  preferredVoice = scored.length > 0 ? scored[0].voice : null;
  if (preferredVoice && !selectedVoiceURI) selectedVoiceURI = preferredVoice.voiceURI;
  populateVoiceSelect(voices);
  if (preferredVoice) console.log('Selected TTS voice:', preferredVoice.name, preferredVoice.lang);
  return preferredVoice;
}

function populateVoiceSelect(voices = []) {
  const select = document.getElementById('voice-select');
  if (!select) return;
  const current = selectedVoiceURI || (preferredVoice && preferredVoice.voiceURI) || '';
  select.innerHTML = voices
    .map(voice => {
      const label = `${voice.name} (${voice.lang})`;
      const selected = voice.voiceURI === current ? ' selected' : '';
      return `<option value="${escAttr(voice.voiceURI)}"${selected}>${esc(label)}</option>`;
    })
    .join('');
  select.disabled = voices.length === 0;
}

function onVoiceSelectChange() {
  const select = document.getElementById('voice-select');
  selectedVoiceURI = select ? select.value : '';
  if (selectedVoiceURI) localStorage.setItem('ttsVoiceURI', selectedVoiceURI);
  preferredVoice = null;
  refreshPreferredVoice();
}

function testSelectedVoice() {
  ttsEnqueue('Xin chào, đây là giọng đọc hiện tại.', { priority: 5 });
}

function voiceScore(voice) {
  const name = `${voice.name || ''} ${voice.lang || ''}`.toLowerCase();
  let score = 0;
  if (/^vi([-_]|$)/i.test(voice.lang || '')) score += 100;
  if (/vietnam|tiếng việt|vietnamese/.test(name)) score += 80;
  if (/female|woman|girl|nữ|nu|hoai|hoài|linh|mai|my|mỹ|an|google/.test(name)) score += 35;
  if (/natural|neural|online|premium|enhanced/.test(name)) score += 20;
  if (/male|man|nam\b/.test(name)) score -= 40;
  return score;
}

function playAudioUrl(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve();
      return;
    }
    try {
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function _speakOnce(text, { interrupt = true } = {}) {
  const cleanText = sanitizeTtsText(text);
  if (!cleanText) return;
  try {
    if (interrupt && speechSynth) speechSynth.cancel();
    const url = await fetchEdgeTtsUrl(cleanText);
    await playAudioUrl(url);
  } catch (e) {
    console.warn('Edge TTS skipped:', e.message || e);
  }
}

async function fetchEdgeTtsUrl(text) {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: EDGE_TTS_VOICE }),
  });
  const data = await response.json();
  if (!data.ok || !data.url) throw new Error(data.error || 'TTS lỗi');
  return data.url;
}

async function ttsDrainQueue() {
  if (ttsBusy) return;
  ttsBusy = true;
  try {
    while (ttsQueue.length > 0) {
      ttsQueue.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
      const item = ttsQueue.shift();
      if (!item || !item.parts || item.parts.length === 0) continue;
      try {
        const urls = await Promise.all(item.parts.map(fetchEdgeTtsUrl));
        for (const url of urls) {
          await playAudioUrl(url);
        }
      } catch (e) {
        console.warn('Edge TTS item skipped:', e.message || e);
      }
      if (item.resolve) item.resolve();
    }
  } finally {
    ttsBusy = false;
  }
}

function ttsEnqueue(text, { priority = 0 } = {}) {
  const parts = Array.isArray(text)
    ? text.map(sanitizeTtsText).filter(Boolean)
    : [sanitizeTtsText(text)].filter(Boolean);
  if (parts.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    ttsQueue.push({ parts, priority, order: ttsOrder++, resolve });
    ttsDrainQueue();
  });
}

function sanitizeTtsText(text) {
  return String(text || '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, ' ')
    .replace(/[\u200D\u20E3]/g, ' ')
    .replace(/[*_`~#>|[\]{}()]/g, ' ')
    .replace(/[!?]{2,}/g, '!')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAiReply(text) {
  return sanitizeTtsText(text)
    .replace(/^(câu\s*)?(trả\s*lời|reply|bot|ai)\s*[:：\-–]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function ttsClearAll() {
  ttsQueue.forEach(item => { if (item && item.resolve) item.resolve(); });
  ttsQueue = [];
  try { if (speechSynth) speechSynth.cancel(); } catch (_) {}
}

// Dùng cho voice assistant: đi qua hàng đợi chung, đọc comment và reply thành một lượt liền mạch.
function speakText(text) {
  return ttsEnqueue(text, { priority: 2 });
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

  const item = { profile, text: msg };
  commentAiQueue.push(item);
  processCommentAIQueue();
}

async function processCommentAIQueue() {
  if (!autoVoiceEnabled || isProcessingVoice || commentAiQueue.length === 0) return;
  const item = commentAiQueue.shift();
  if (!item) return;

  isProcessingVoice = true;
  const runToken = voiceRunToken;
  setVoiceButtons(false);

  const name = displayName(item.profile);
  const question = `${name} bình luận: ${item.text}`;
  updateVoiceLast(question);
  updateVoiceStatus('Đang trả lời comment...');

  try {
    const reply = await askVoiceAI(`Trả lời comment TikTok Live của ${name}: ${item.text}. Trả lời cực ngắn, vui vui, troll nhẹ kiểu Gen Z Việt Nam, không toxic, không dùng emoji hoặc biểu tượng cảm xúc.`);
    if (!autoVoiceEnabled || runToken !== voiceRunToken) return;

    const spokenReply = cleanAiReply(reply);
    updateVoiceLast(`${question} | Bot: ${spokenReply}`);
    await speakText([question, spokenReply]);
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
  updateVoiceStatus('AI trả lời comment đang tự bật');
  updateVoiceLast('Bot sẽ tự đọc comment và trả lời ngắn gọn.');
  setVoiceButtons(false);
  processCommentAIQueue();
}

function stopVoiceListen() {
  autoVoiceEnabled = true;
  voiceRunToken++;
  isProcessingVoice = false;
  commentAiQueue = [];
  updateVoiceStatus('AI trả lời comment luôn bật');
  setVoiceButtons(false);
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
    if (thanks) ttsEnqueue(thanks, { priority: 3 });
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
  const giftDetail = `${giftPart}`;

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
    `Cảm ơn ${n} tặng ${giftDetail}.`,
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

  // Chào người mới với cooldown để không bị spam khi phòng đông.
  const now = Date.now();
  if (now - lastJoinGreetAt < JOIN_GREET_COOLDOWN_MS) return;
  lastJoinGreetAt = now;
  const welcome = buildJoinWelcome(profile);
  if (welcome) ttsEnqueue(welcome, { priority: 0 });
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
  const voiceSelect = document.getElementById('voice-select');
  if (voiceSelect) voiceSelect.addEventListener('change', onVoiceSelectChange);
  refreshPreferredVoice();
  if (speechSynth) speechSynth.onvoiceschanged = refreshPreferredVoice;
  startVoiceListen();
});
