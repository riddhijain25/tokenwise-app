import * as scoring from './scoring.js';
import * as telemetry from './telemetry.js';

(function () {
  const modelSelect = document.getElementById('modelSelect');
  const sessionTotalEl = document.getElementById('sessionTotal');
  const messageList = document.getElementById('messageList');
  const composerForm = document.getElementById('composerForm');
  const promptInput = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const liveTokenCount = document.getElementById('liveTokenCount');
  const scoreBadge = document.getElementById('scoreBadge');
  const scoreIssues = document.getElementById('scoreIssues');
  const optimizeBtn = document.getElementById('optimizeBtn');
  const routeBadge = document.getElementById('routeBadge');
  const chatList = document.getElementById('chatList');
  const newChatBtn = document.getElementById('newChatBtn');

  const CHATS_KEY = 'tokenwise_chats';

  let sessionTokens = 0;
  let isRequestInFlight = false;
  let scoreTimer = null;
  const modelsMap = new Map();
  let rawModelsList = [];

  let chats = [];
  let activeChatId = null;

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatParagraphs(text) {
    if (!text) return '<p></p>';
    return text.trim().split(/\n{2,}/)
      .map(b => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function adjustTextareaHeight() {
    promptInput.style.height = 'auto';
    const min = 88, max = 260;
    const h = promptInput.scrollHeight;
    if (h <= min) {
      promptInput.style.height = `${min}px`;
      promptInput.style.overflowY = 'hidden';
    } else if (h >= max) {
      promptInput.style.height = `${max}px`;
      promptInput.style.overflowY = 'auto';
    } else {
      promptInput.style.height = `${h}px`;
      promptInput.style.overflowY = 'hidden';
    }
  }

  function scrollToBottom() {
    messageList.scrollTop = messageList.scrollHeight;
  }

  /* ---------- chats ---------- */

  function loadChats() {
    try { chats = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]'); }
    catch (e) { chats = []; }
  }

  function persistChats() {
    try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); }
    catch (e) { console.warn('Chat save failed', e); }
  }

  function activeChat() {
    return chats.find(c => c.id === activeChatId) || null;
  }

  function showEmptyState() {
    messageList.innerHTML =
      '<div class="empty-state">Send a prompt to inspect token consumption.</div>';
  }

  function newChat() {
    activeChatId = crypto.randomUUID();
    chats.unshift({
      id: activeChatId,
      title: 'New chat',
      created_at: new Date().toISOString(),
      tokens: 0,
      exchanges: []
    });
    persistChats();
    renderChatList();
    showEmptyState();
    sessionTokens = 0;
    sessionTotalEl.textContent = '0';
  }

  function renderChatList() {
    chatList.innerHTML = '';
    chats.forEach(c => {
      const el = document.createElement('div');
      el.className = 'chat-item' + (c.id === activeChatId ? ' is-active' : '');

      const row = document.createElement('div');
      row.className = 'chat-item-row';

      const title = document.createElement('div');
      title.className = 'chat-item-title';
      title.textContent = c.title;

      const rename = document.createElement('button');
      rename.className = 'chat-icon-btn';
      rename.type = 'button';
      rename.textContent = '✎';
      rename.title = 'Rename';
      // Without stopPropagation the click would also open the chat
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(c, title);
      });

      const del = document.createElement('button');
      del.className = 'chat-icon-btn is-delete';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });

      row.append(title, rename, del);

      const meta = document.createElement('div');
      meta.className = 'chat-item-meta';
      meta.textContent =
        `${c.exchanges.length} turns · ${c.tokens.toLocaleString()} tokens`;

      el.append(row, meta);
      el.addEventListener('click', () => openChat(c.id));
      chatList.appendChild(el);
    });
  }

  // Swaps the title for an input in place. Enter or blur commits,
  // Escape reverts.
  function startRename(chat, titleEl) {
    const input = document.createElement('input');
    input.className = 'chat-rename-input';
    input.value = chat.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name) chat.title = name;
      persistChats();
      renderChatList();
    };

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; renderChatList(); }
    });
  }

  function deleteChat(id) {
    const chat = chats.find(c => c.id === id);
    if (!chat) return;

    // Only confirm when there is something to lose
    if (chat.exchanges.length > 0 &&
      !confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;

    chats = chats.filter(c => c.id !== id);
    persistChats();

    if (activeChatId === id) {
      if (chats.length) openChat(chats[0].id);
      else newChat();
    } else {
      renderChatList();
    }
  }

  // Replayed from storage. Nothing is re-sent to the model, so revisiting
  // a conversation costs nothing.
  function openChat(id) {
    const chat = chats.find(c => c.id === id);
    if (!chat) return;
    activeChatId = id;

    if (chat.exchanges.length === 0) {
      showEmptyState();
    } else {
      messageList.innerHTML = '';
      chat.exchanges.forEach(x => {
        const wrap = document.createElement('div');
        wrap.className = 'exchange';
        wrap.innerHTML =
          `<div class="user-row"><div class="user-bubble">${escapeHtml(x.prompt)}</div></div>` +
          `<div class="model-row"><div class="model-content">${formatParagraphs(x.reply)}</div></div>` +
          `<div class="token-figures">${x.figures}</div>`;
        messageList.appendChild(wrap);
      });
    }

    sessionTokens = chat.tokens;
    sessionTotalEl.textContent = sessionTokens.toLocaleString();
    renderChatList();
    scrollToBottom();
  }

  function recordExchange(prompt, reply, figuresHtml, total) {
    const chat = activeChat();
    if (!chat) return;
    // Only auto-title on the first exchange, so a manual rename survives
    if (chat.exchanges.length === 0 && chat.title === 'New chat') {
      chat.title = prompt.slice(0, 42) + (prompt.length > 42 ? '…' : '');
    }
    chat.exchanges.push({ prompt, reply, figures: figuresHtml });
    chat.tokens += total;
    persistChats();
    renderChatList();
  }

  /* ---------- models ---------- */

  async function loadModels() {
    try {
      const response = await fetch('/models');
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch models');
      }

      const payload = await response.json();
      const models = Array.isArray(payload) ? payload : (payload.models || []);

      rawModelsList = models;
      modelSelect.innerHTML = '';
      modelsMap.clear();

      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models available</option>';
        promptInput.disabled = false;
        return;
      }

      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = 'Auto (Smart Router)';
      modelSelect.appendChild(autoOpt);

      models.forEach((m) => {
        modelsMap.set(m.name, m.displayName);
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.displayName + (m.preview ? ' (preview)' : '');
        modelSelect.appendChild(opt);
      });

      modelSelect.selectedIndex = 0;
      modelSelect.disabled = false;
      promptInput.disabled = false;
      sendBtn.disabled = false;
      promptInput.focus();
      updateScore();
    } catch (err) {
      console.error('Model loading error:', err);
      modelSelect.innerHTML = '<option value="">Error loading models</option>';
      promptInput.disabled = false;
      updateScore();
    }
  }

  /* ---------- send ---------- */

  async function handleSend() {
    if (isRequestInFlight) return;
    const prompt = promptInput.value.trim();
    let model = modelSelect.value;
    if (!prompt || !model) return;

    if (!activeChat()) newChat();
    const chat = activeChat();

    // Captured before the composer is cleared
    const scoreAtSend = scoring.scorePrompt(prompt);

    const empty = messageList.querySelector('.empty-state');
    if (empty) empty.remove();

    let routeReason = null;
    if (model === 'auto') {
      const route = scoring.routeModel(prompt, rawModelsList);
      model = route.modelName;
      routeReason = route.reason;
    }

    const displayName = modelsMap.get(model) || model;

    // Prior turns are resent so the model has context. This is what makes
    // promptTokenCount grow through a conversation.
    const history = chat.exchanges.flatMap(x => ([
      { role: 'user', parts: [{ text: x.prompt }] },
      { role: 'model', parts: [{ text: x.reply }] }
    ]));

    const turnIndex = chat.exchanges.length;

    const exchangeEl = document.createElement('div');
    exchangeEl.className = 'exchange';

    const userRow = document.createElement('div');
    userRow.className = 'user-row';
    const userBubble = document.createElement('div');
    userBubble.className = 'user-bubble';
    userBubble.textContent = prompt;
    userRow.appendChild(userBubble);
    exchangeEl.appendChild(userRow);

    const modelRow = document.createElement('div');
    modelRow.className = 'model-row';
    const modelContent = document.createElement('div');
    modelContent.className = 'model-content';
    modelContent.innerHTML =
      '<div class="loading-dots" aria-label="Waiting for reply">' +
      '<span class="loading-dot"></span><span class="loading-dot"></span>' +
      '<span class="loading-dot"></span></div>';
    modelRow.appendChild(modelContent);
    exchangeEl.appendChild(modelRow);

    messageList.appendChild(exchangeEl);
    scrollToBottom();

    isRequestInFlight = true;
    promptInput.value = '';
    adjustTextareaHeight();
    updateScore();
    promptInput.disabled = true;
    sendBtn.disabled = true;
    optimizeBtn.disabled = true;

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model, history })
      });

      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Request failed');

      modelContent.innerHTML = formatParagraphs(data.reply || '');

      const usage = data.usage || {};
      const inTok = usage.promptTokenCount ?? 0;
      const outTok = usage.candidatesTokenCount ?? 0;
      const totalTok = usage.totalTokenCount ?? 0;
      const thinkTok = usage.thoughtsTokenCount;

      // promptTokenCount covers history and the new prompt together. The
      // server counts the new prompt alone so the two can be separated.
      const newTok = data.newPromptTokens;
      const histTok = (typeof newTok === 'number') ? Math.max(0, inTok - newTok) : null;

      const figuresEl = document.createElement('div');
      figuresEl.className = 'token-figures';

      let html = `<span class="token-model">${escapeHtml(displayName)}</span>`;
      if (routeReason) {
        html += `<span class="token-route">routed: ${escapeHtml(routeReason)}</span>`;
      }
      html += `<span>in ${inTok}`;
      if (histTok !== null && histTok > 0) {
        html += ` <span class="token-split">(${newTok} new, ${histTok} history)</span>`;
      }
      html += `</span>`;
      html += `<span>out ${outTok}</span>`;
      if (typeof thinkTok === 'number') html += `<span>think ${thinkTok}</span>`;
      html += `<span class="token-total">total ${totalTok}</span>`;

      figuresEl.innerHTML = html;
      exchangeEl.appendChild(figuresEl);

      sessionTokens += totalTok;
      sessionTotalEl.textContent = sessionTokens.toLocaleString();

      recordExchange(prompt, data.reply || '', html, totalTok);

      telemetry.recordSend({
        chat_id: chat.id,
        turn_index: turnIndex,
        model_requested: modelSelect.value,
        model_used: model,
        route_reason: routeReason,
        final_score: scoreAtSend.scored ? scoreAtSend.score : null,
        final_tokens: scoreAtSend.tokens ?? null,
        prompt_chars: prompt.length,
        issues_at_send: scoreAtSend.issues || [],
        constraint_present: !!scoreAtSend.hasFormat,
        tokens_new: typeof newTok === 'number' ? newTok : null,
        tokens_history: histTok,
        tokens_in: inTok,
        tokens_out: outTok,
        tokens_thinking: typeof thinkTok === 'number' ? thinkTok : null,
        tokens_total: totalTok
      });
    } catch (err) {
      console.error('Chat request error:', err);
      modelContent.innerHTML =
        `<div class="model-error">Error: ${escapeHtml(err.message)}</div>`;
      // Nothing was consumed, so no record is written
      telemetry.discardPending();
    } finally {
      isRequestInFlight = false;
      promptInput.disabled = false;
      sendBtn.disabled = false;
      adjustTextareaHeight();
      promptInput.focus();
      scrollToBottom();
    }
  }

  /* ---------- scoring ---------- */

  function clearScoreUI() {
    liveTokenCount.style.display = 'none';
    liveTokenCount.textContent = '';
    scoreBadge.style.display = 'none';
    scoreBadge.className = 'score-badge';
    scoreBadge.textContent = '';
    scoreIssues.innerHTML = '';
    routeBadge.style.display = 'none';
    routeBadge.textContent = '';
    optimizeBtn.disabled = true;
  }

  function updateScore() {
    const text = promptInput.value.trim();
    if (!text) { clearScoreUI(); return; }

    const res = scoring.scorePrompt(text);
    telemetry.beginPrompt(res);

    liveTokenCount.style.display = 'inline-block';
    liveTokenCount.textContent = `~${res.tokens || 0} tokens`;

    // Show which tier Auto would pick, before sending rather than after.
    if (modelSelect.value === 'auto') {
      const r = scoring.routeModel(text, rawModelsList);
      routeBadge.style.display = 'inline-block';
      routeBadge.textContent = `→ ${r.displayName}`;
      routeBadge.title = r.reason;
    } else {
      routeBadge.style.display = 'none';
    }

    // Below the threshold there is nothing useful to say about a prompt.
    if (!res.scored) {
      scoreBadge.style.display = 'none';
      scoreBadge.className = 'score-badge';
      scoreBadge.textContent = '';
      scoreIssues.innerHTML = '';
      optimizeBtn.disabled = true;
      return;
    }

    scoreBadge.style.display = 'inline-block';
    scoreBadge.textContent = `Score ${res.score}`;
    scoreBadge.className = 'score-badge ' +
      (res.score >= 85 ? 'is-good' : res.score >= 60 ? 'is-mid' : 'is-warn');

    scoreIssues.innerHTML = (res.issues || [])
      .map(i => `<span class="issue-pill">${escapeHtml(i)}</span>`)
      .join('');

    const opt = scoring.optimise(text);
    optimizeBtn.disabled = !opt.changed;
  }

  /* ---------- events ---------- */

  promptInput.addEventListener('input', () => {
    adjustTextareaHeight();
    clearTimeout(scoreTimer);
    scoreTimer = setTimeout(updateScore, 400);
  });

  modelSelect.addEventListener('change', updateScore);
  newChatBtn.addEventListener('click', newChat);

  optimizeBtn.addEventListener('click', () => {
    if (isRequestInFlight) return;
    const text = promptInput.value.trim();
    if (!text) return;

    const opt = scoring.optimise(text);
    if (!opt.changed) return;

    telemetry.markOptimised();

    // Writing through execCommand preserves the browser's undo stack, so
    // Ctrl+Z restores the original. Assigning to .value directly wipes it.
    promptInput.focus();
    promptInput.select();
    if (!document.execCommand('insertText', false, opt.text)) {
      promptInput.value = opt.text;
    }

    adjustTextareaHeight();
    updateScore();

    if (opt.actions.length) {
      const note = document.createElement('span');
      note.className = 'optimise-note';
      note.textContent =
        `${opt.actions.join(', ')} · ~${opt.before} → ~${opt.after} tokens`;
      scoreIssues.appendChild(note);
    }
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  /* ---------- init ---------- */

  adjustTextareaHeight();
  clearScoreUI();
  telemetry.installConsoleHelpers();
  loadChats();
  if (chats.length) openChat(chats[0].id); else newChat();
  loadModels();
})();