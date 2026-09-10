import * as scoring from './scoring.js';
import * as telemetry from './telemetry.js';

// 1. Import Firebase Web SDK functions
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// 2. Import your config file
import { firebaseConfig } from "./firebase-config.js";

// 3. Initialize Firebase & export Auth instance
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

console.log("Firebase initialized successfully on frontend!");


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


  /* ============================================================
     TELEMETRY FLUSH
     ============================================================ */

  let isTelemetryFlushInProgress = false;

  const TELEMETRY_QUEUE_FLUSH_THRESHOLD = 20;


  /*
   * Send queued telemetry records to the backend.
   *
   * Important:
   * - Queue is NOT cleared before server confirmation.
   * - If request fails, records remain in localStorage.
   * - If request succeeds, only the sent records are removed.
   */
  async function flushTelemetryToServer() {

    /*
     * Prevent two flushes from running simultaneously.
     */
    if (isTelemetryFlushInProgress) {
      return;
    }

    const events = telemetry.getQueue();

    if (!events || events.length === 0) {
      return;
    }

    /*
     * Firebase authentication is required by /telemetry.
     */
    const user = auth.currentUser;

    if (!user) {
      console.warn(
        'User not logged in; telemetry remains in local storage.'
      );
      return;
    }

    isTelemetryFlushInProgress = true;

    try {

      /*
       * Get a Firebase ID token for backend authentication.
       */
      const token = await user.getIdToken();

      const response = await fetch('/telemetry', {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },

        body: JSON.stringify({
          events
        })
      });


      if (!response.ok) {

        const errorText =
          await response.text();

        console.error(
          'Telemetry flush failed:',
          errorText
        );

        /*
         * DO NOT remove events.
         *
         * They remain in localStorage and will be
         * retried on the next flush.
         */
        return;
      }


      const result = await response.json();

      console.log(
        `[Telemetry Flushed]: Successfully sent ${result.count} events to server/BigQuery.`
      );


      /*
       * Only now remove the events that were part of this
       * successful batch.
       */
      telemetry.removeSent(events);

    } catch (err) {

      console.error(
        'Failed to connect to /telemetry server:',
        err
      );

      /*
       * Queue remains untouched.
       */

    } finally {

      isTelemetryFlushInProgress = false;
    }
  }


  /*
   * Periodic flush every 30 seconds.
   */
  setInterval(
    flushTelemetryToServer,
    30 * 1000
  );


  /*
   * Attempt to flush when the page becomes hidden.
   */
  document.addEventListener(
    'visibilitychange',
    () => {

      if (
        document.visibilityState === 'hidden'
      ) {
        flushTelemetryToServer();
      }
    }
  );


  /* ---------- helpers ---------- */

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

    return text
      .trim()
      .split(/\n{2,}/)
      .map(
        b =>
          `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`
      )
      .join('');
  }


  function adjustTextareaHeight() {

    promptInput.style.height = 'auto';

    const min = 88;
    const max = 260;

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
    messageList.scrollTop =
      messageList.scrollHeight;
  }


  /* ---------- chats ---------- */

  function loadChats() {

    try {

      chats =
        JSON.parse(
          localStorage.getItem(CHATS_KEY) || '[]'
        );

    } catch (e) {

      chats = [];
    }
  }


  function persistChats() {

    try {

      localStorage.setItem(
        CHATS_KEY,
        JSON.stringify(chats)
      );

    } catch (e) {

      console.warn(
        'Chat save failed',
        e
      );
    }
  }


  function activeChat() {

    return chats.find(
      c => c.id === activeChatId
    ) || null;
  }


  function showEmptyState() {

    messageList.innerHTML =
      '<div class="empty-state">Send a prompt to inspect token consumption.</div>';
  }


  function newChat() {

    activeChatId =
      crypto.randomUUID();

    chats.unshift({

      id: activeChatId,

      title: 'New chat',

      created_at:
        new Date().toISOString(),

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

      const el =
        document.createElement('div');

      el.className =
        'chat-item' +
        (c.id === activeChatId
          ? ' is-active'
          : '');


      const row =
        document.createElement('div');

      row.className =
        'chat-item-row';


      const title =
        document.createElement('div');

      title.className =
        'chat-item-title';

      title.textContent =
        c.title;


      const rename =
        document.createElement('button');

      rename.className =
        'chat-icon-btn';

      rename.type =
        'button';

      rename.textContent =
        '✎';

      rename.title =
        'Rename';


      rename.addEventListener(
        'click',
        (e) => {

          e.stopPropagation();

          startRename(
            c,
            title
          );
        }
      );


      const del =
        document.createElement('button');

      del.className =
        'chat-icon-btn is-delete';

      del.type =
        'button';

      del.textContent =
        '×';

      del.title =
        'Delete';


      del.addEventListener(
        'click',
        (e) => {

          e.stopPropagation();

          deleteChat(c.id);
        }
      );


      row.append(
        title,
        rename,
        del
      );


      const meta =
        document.createElement('div');

      meta.className =
        'chat-item-meta';

      meta.textContent =
        `${c.exchanges.length} turns · ${c.tokens.toLocaleString()} tokens`;


      el.append(
        row,
        meta
      );


      el.addEventListener(
        'click',
        () => openChat(c.id)
      );


      chatList.appendChild(el);
    });
  }


  function startRename(
    chat,
    titleEl
  ) {

    const input =
      document.createElement('input');

    input.className =
      'chat-rename-input';

    input.value =
      chat.title;

    titleEl.replaceWith(input);

    input.focus();
    input.select();


    let done = false;


    const commit = () => {

      if (done) return;

      done = true;

      const name =
        input.value.trim();

      if (name) {
        chat.title = name;
      }

      persistChats();

      renderChatList();
    };


    input.addEventListener(
      'click',
      e => e.stopPropagation()
    );


    input.addEventListener(
      'blur',
      commit
    );


    input.addEventListener(
      'keydown',
      (e) => {

        e.stopPropagation();

        if (e.key === 'Enter') {

          e.preventDefault();

          commit();
        }

        if (e.key === 'Escape') {

          done = true;

          renderChatList();
        }
      }
    );
  }


  function deleteChat(id) {

    const chat =
      chats.find(c => c.id === id);

    if (!chat) return;


    if (
      chat.exchanges.length > 0 &&
      !confirm(
        `Delete "${chat.title}"? This cannot be undone.`
      )
    ) {
      return;
    }


    chats =
      chats.filter(
        c => c.id !== id
      );

    persistChats();


    if (activeChatId === id) {

      if (chats.length) {

        openChat(
          chats[0].id
        );

      } else {

        newChat();
      }

    } else {

      renderChatList();
    }
  }


  function openChat(id) {

    const chat =
      chats.find(c => c.id === id);

    if (!chat) return;

    activeChatId = id;


    if (chat.exchanges.length === 0) {

      showEmptyState();

    } else {

      messageList.innerHTML = '';

      chat.exchanges.forEach(x => {

        const wrap =
          document.createElement('div');

        wrap.className =
          'exchange';

        wrap.innerHTML =
          `<div class="user-row"><div class="user-bubble">${escapeHtml(x.prompt)}</div></div>` +
          `<div class="model-row"><div class="model-content">${formatParagraphs(x.reply)}</div></div>` +
          `<div class="token-figures">${x.figures}</div>`;

        messageList.appendChild(wrap);
      });
    }


    sessionTokens =
      chat.tokens;

    sessionTotalEl.textContent =
      sessionTokens.toLocaleString();

    renderChatList();

    scrollToBottom();
  }


  function recordExchange(
    prompt,
    reply,
    figuresHtml,
    total
  ) {

    const chat =
      activeChat();

    if (!chat) return;


    if (
      chat.exchanges.length === 0 &&
      chat.title === 'New chat'
    ) {

      chat.title =
        prompt.slice(0, 42) +
        (prompt.length > 42
          ? '…'
          : '');
    }


    chat.exchanges.push({
      prompt,
      reply,
      figures: figuresHtml
    });

    chat.tokens += total;

    persistChats();

    renderChatList();
  }


  /* ---------- models ---------- */

  async function loadModels() {

    try {

      const response =
        await fetch('/models');


      if (!response.ok) {

        const err =
          await response
            .json()
            .catch(() => ({}));

        throw new Error(
          err.error ||
          'Failed to fetch models'
        );
      }


      const payload =
        await response.json();

      const models =
        Array.isArray(payload)
          ? payload
          : (payload.models || []);


      rawModelsList =
        models;

      modelSelect.innerHTML =
        '';

      modelsMap.clear();


      if (models.length === 0) {

        modelSelect.innerHTML =
          '<option value="">No models available</option>';

        promptInput.disabled =
          false;

        return;
      }


      const autoOpt =
        document.createElement('option');

      autoOpt.value =
        'auto';

      autoOpt.textContent =
        'Auto (Smart Router)';

      modelSelect.appendChild(
        autoOpt
      );


      models.forEach((m) => {

        modelsMap.set(
          m.name,
          m.displayName
        );


        const opt =
          document.createElement('option');

        opt.value =
          m.name;

        opt.textContent =
          m.displayName +
          (m.preview
            ? ' (preview)'
            : '');

        modelSelect.appendChild(
          opt
        );
      });


      modelSelect.selectedIndex =
        0;

      modelSelect.disabled =
        false;

      promptInput.disabled =
        false;

      sendBtn.disabled =
        false;

      promptInput.focus();

      updateScore();

    } catch (err) {

      console.error(
        'Model loading error:',
        err
      );

      modelSelect.innerHTML =
        '<option value="">Error loading models</option>';

      promptInput.disabled =
        false;

      updateScore();
    }
  }


  /* ---------- send ---------- */

  async function handleSend() {

    if (isRequestInFlight) return;


    const prompt =
      promptInput.value.trim();

    let model =
      modelSelect.value;


    if (!prompt || !model) return;


    if (!activeChat()) {
      newChat();
    }


    const chat =
      activeChat();


    /*
     * Captured before the composer is cleared.
     */
    const scoreAtSend = scoring.scorePrompt(prompt);
    telemetry.beginPrompt(scoreAtSend);


    const empty =
      messageList.querySelector(
        '.empty-state'
      );

    if (empty) {
      empty.remove();
    }


    let routeReason = null;


    if (model === 'auto') {

      const route =
        scoring.routeModel(
          prompt,
          rawModelsList
        );

      model =
        route.modelName;

      routeReason =
        route.reason;
    }


    const displayName =
      modelsMap.get(model) ||
      model;


    /*
     * Prior turns are resent so the model has context.
     */
    const history =
      chat.exchanges.flatMap(
        x => ([
          {
            role: 'user',
            parts: [
              {
                text: x.prompt
              }
            ]
          },

          {
            role: 'model',
            parts: [
              {
                text: x.reply
              }
            ]
          }
        ])
      );


    const turnIndex =
      chat.exchanges.length;


    /* ---------- create UI exchange ---------- */

    const exchangeEl =
      document.createElement('div');

    exchangeEl.className =
      'exchange';


    const userRow =
      document.createElement('div');

    userRow.className =
      'user-row';


    const userBubble =
      document.createElement('div');

    userBubble.className =
      'user-bubble';

    userBubble.textContent =
      prompt;


    userRow.appendChild(
      userBubble
    );

    exchangeEl.appendChild(
      userRow
    );


    const modelRow =
      document.createElement('div');

    modelRow.className =
      'model-row';


    const modelContent =
      document.createElement('div');

    modelContent.className =
      'model-content';


    modelContent.innerHTML =
      '<div class="loading-dots" aria-label="Waiting for reply">' +
      '<span class="loading-dot"></span>' +
      '<span class="loading-dot"></span>' +
      '<span class="loading-dot"></span>' +
      '</div>';


    modelRow.appendChild(
      modelContent
    );

    exchangeEl.appendChild(
      modelRow
    );


    messageList.appendChild(
      exchangeEl
    );

    scrollToBottom();


    /* ---------- request state ---------- */

    isRequestInFlight =
      true;

    promptInput.value =
      '';

    adjustTextareaHeight();

    updateScore();

    promptInput.disabled =
      true;

    sendBtn.disabled =
      true;

    optimizeBtn.disabled =
      true;


    try {

      /*
       * Firebase authentication token.
       *
       * /chat is protected by verifyFirebaseToken()
       * on the server.
       */
      const user =
        auth.currentUser;

      if (!user) {
        throw new Error(
          'User is not authenticated.'
        );
      }


      const token =
        await user.getIdToken();


      const response =
        await fetch('/chat', {

          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'Authorization':
              `Bearer ${token}`
          },

          body: JSON.stringify({
            prompt,
            model,
            history
          })
        });


      const data =
        await response.json();


      if (
        !response.ok ||
        data.error
      ) {

        throw new Error(
          data.error ||
          'Request failed'
        );
      }


      modelContent.innerHTML =
        formatParagraphs(
          data.reply || ''
        );


      /* ---------- usage ---------- */

      const usage =
        data.usage || {};


      const inTok =
        usage.promptTokenCount ??
        0;


      const outTok =
        usage.candidatesTokenCount ??
        0;


      const totalTok =
        usage.totalTokenCount ??
        0;


      const thinkTok =
        usage.thoughtsTokenCount;


      /*
       * promptTokenCount covers both history and
       * the new prompt.
       */
      const newTok =
        data.newPromptTokens;


      const histTok =
        typeof newTok === 'number'
          ? Math.max(
            0,
            inTok - newTok
          )
          : null;


      /* ---------- token display ---------- */

      const figuresEl =
        document.createElement('div');

      figuresEl.className =
        'token-figures';


      let html =
        `<span class="token-model">${escapeHtml(displayName)}</span>`;


      if (routeReason) {

        html +=
          `<span class="token-route">routed: ${escapeHtml(routeReason)}</span>`;
      }


      html +=
        `<span>in ${inTok}`;


      if (
        histTok !== null &&
        histTok > 0
      ) {

        html +=
          ` <span class="token-split">(${newTok} new, ${histTok} history)</span>`;
      }


      html +=
        `</span>`;


      html +=
        `<span>out ${outTok}</span>`;


      if (
        typeof thinkTok === 'number'
      ) {

        html +=
          `<span>think ${thinkTok}</span>`;
      }


      html +=
        `<span class="token-total">total ${totalTok}</span>`;


      figuresEl.innerHTML =
        html;


      exchangeEl.appendChild(
        figuresEl
      );


      sessionTokens +=
        totalTok;


      sessionTotalEl.textContent =
        sessionTokens.toLocaleString();


      recordExchange(
        prompt,
        data.reply || '',
        html,
        totalTok
      );


      /* ---------- telemetry ---------- */

      telemetry.recordSend({

        chat_id:
          chat.id,

        turn_index:
          turnIndex,

        model_requested:
          modelSelect.value,

        model_used:
          model,

        route_reason:
          routeReason,

        final_score:
          scoreAtSend.scored
            ? scoreAtSend.score
            : null,

        final_tokens:
          scoreAtSend.tokens ??
          null,

        prompt_chars:
          prompt.length,

        issues_at_send:
          scoreAtSend.issues ||
          [],

        constraint_present:
          !!scoreAtSend.hasFormat,

        tokens_new:
          typeof newTok === 'number'
            ? newTok
            : null,

        tokens_history:
          histTok,

        tokens_in:
          inTok,

        tokens_out:
          outTok,

        tokens_thinking:
          typeof thinkTok === 'number'
            ? thinkTok
            : null,

        tokens_total:
          totalTok
      });


      /*
       * If the queue reaches 20 records, flush immediately.
       */
      if (
        telemetry.getQueue().length >=
        TELEMETRY_QUEUE_FLUSH_THRESHOLD
      ) {

        flushTelemetryToServer();
      }


    } catch (err) {

      console.error(
        'Chat request error:',
        err
      );


      modelContent.innerHTML =
        `<div class="model-error">Error: ${escapeHtml(err.message)}</div>`;


      /*
       * Nothing was consumed, so don't create
       * a telemetry record.
       */
      telemetry.discardPending();

    } finally {

      isRequestInFlight =
        false;

      promptInput.disabled =
        false;

      sendBtn.disabled =
        false;

      adjustTextareaHeight();

      promptInput.focus();

      scrollToBottom();
    }
  }


  /* ---------- scoring ---------- */

  function clearScoreUI() {

    liveTokenCount.style.display =
      'none';

    liveTokenCount.textContent =
      '';

    scoreBadge.style.display =
      'none';

    scoreBadge.className =
      'score-badge';

    scoreBadge.textContent =
      '';

    scoreIssues.innerHTML =
      '';

    routeBadge.style.display =
      'none';

    routeBadge.textContent =
      '';

    optimizeBtn.disabled =
      true;
  }


  function updateScore() {

    const text =
      promptInput.value.trim();


    if (!text) {

      clearScoreUI();

      return;
    }


    const res =
      scoring.scorePrompt(text);


    telemetry.beginPrompt(
      res
    );


    liveTokenCount.style.display =
      'inline-block';

    liveTokenCount.textContent =
      `~${res.tokens || 0} tokens`;


    /* ---------- route preview ---------- */

    if (
      modelSelect.value === 'auto'
    ) {

      const r =
        scoring.routeModel(
          text,
          rawModelsList
        );


      routeBadge.style.display =
        'inline-block';

      routeBadge.textContent =
        `→ ${r.displayName}`;

      routeBadge.title =
        r.reason;

    } else {

      routeBadge.style.display =
        'none';
    }


    /* ---------- scoring threshold ---------- */

    if (!res.scored) {

      scoreBadge.style.display =
        'none';

      scoreBadge.className =
        'score-badge';

      scoreBadge.textContent =
        '';

      scoreIssues.innerHTML =
        '';

      optimizeBtn.disabled =
        true;

      return;
    }


    scoreBadge.style.display =
      'inline-block';


    scoreBadge.textContent =
      `Score ${res.score}`;


    scoreBadge.className =
      'score-badge ' +
      (
        res.score >= 85
          ? 'is-good'
          : res.score >= 60
            ? 'is-mid'
            : 'is-warn'
      );


    scoreIssues.innerHTML =
      (res.issues || [])
        .map(
          i =>
            `<span class="issue-pill">${escapeHtml(i)}</span>`
        )
        .join('');


    const opt =
      scoring.optimise(text);


    optimizeBtn.disabled =
      !opt.changed;
  }


  /* ---------- events ---------- */

  promptInput.addEventListener(
    'input',
    () => {

      adjustTextareaHeight();

      clearTimeout(
        scoreTimer
      );

      scoreTimer =
        setTimeout(
          updateScore,
          400
        );
    }
  );


  modelSelect.addEventListener(
    'change',
    updateScore
  );


  newChatBtn.addEventListener(
    'click',
    newChat
  );


  optimizeBtn.addEventListener(
    'click',
    () => {

      if (isRequestInFlight) return;


      const text =
        promptInput.value.trim();


      if (!text) return;


      const opt =
        scoring.optimise(text);


      if (!opt.changed) return;

      const optimizedScore = scoring.scorePrompt(opt.text);
      telemetry.markOptimised();


      /*
       * Preserve browser undo stack.
       */
      promptInput.focus();

      promptInput.select();


      if (
        !document.execCommand(
          'insertText',
          false,
          opt.text
        )
      ) {

        promptInput.value =
          opt.text;
      }


      adjustTextareaHeight();

      updateScore();


      if (opt.actions.length) {

        const note =
          document.createElement('span');

        note.className =
          'optimise-note';

        note.textContent =
          `${opt.actions.join(', ')} · ~${opt.before} → ~${opt.after} tokens`;

        scoreIssues.appendChild(
          note
        );
      }
    }
  );


  promptInput.addEventListener(
    'keydown',
    (e) => {

      if (
        e.key === 'Enter' &&
        !e.shiftKey
      ) {

        e.preventDefault();

        handleSend();
      }
    }
  );


  composerForm.addEventListener(
    'submit',
    (e) => {

      e.preventDefault();

      handleSend();
    }
  );

  /* ============================================================
     USER PROFILE BADGE & TOOLTIP
     ============================================================ */

  async function loadUserProfile() {
    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();

      // Explicitly call the correct backend endpoint
      const res = await fetch('/get-current-user', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      // Safely check if the response is valid JSON before parsing
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.warn('Server did not return JSON for user profile.');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        const badge = document.getElementById('userProfileBadge');
        const tooltip = document.getElementById('usernameTooltip');

        if (badge && tooltip) {
          tooltip.textContent = `@${data.username} (${data.org_id} / ${data.dept_id})`;
          badge.style.display = 'flex';
        }
      } else {
        console.warn('Could not load user profile details. Status:', res.status);
      }
    } catch (e) {
      console.error('Failed to load user profile badge:', e);
    }
  }


  /* ---------- init ---------- */

  adjustTextareaHeight();

  clearScoreUI();

  telemetry.installConsoleHelpers();

  loadChats();

  // ADD THIS LINE TO LOAD THE USER PROFILE ON STARTUP:
  setTimeout(loadUserProfile, 800);

  if (chats.length) {

    openChat(
      chats[0].id
    );

  } else {

    newChat();
  }


  loadModels();

})();