import { initSidebar } from './sidebar.js';
import { ChatSessions } from './chat-sessions.js';

/**
 * PHANTOM — Main Application Controller
 * Handles WebSocket, conversation management, and UI orchestration
 * New: Image OSINT (drag & drop person image → AI web search)
 * Fixed: Auto-scroll
 */
(function() {
  'use strict';

  // ─── State ───
  let ws = null;
  let currentConversationId = null;
  let conversations = [];
  const chatSessions = new ChatSessions();
  let activeSession = chatSessions.create();
  chatSessions.activate(activeSession);
  let historyGeneration = 0;
  let reconnectAttempts = 0;

  // Pending image for OSINT (base64 data URL)
  let pendingImage = null;
  let pendingImageName = '';

  // ─── DOM References ───
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const convList = document.getElementById('conversation-list');
  const searchInput = document.getElementById('search-conversations');
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const connectionBadge = document.getElementById('connection-status');
  const sidebarNavigation = initSidebar({ document, window });

  // ─── Theme Initialization ───
  function initTheme() {
    const themeBtn = document.getElementById('theme-toggle-btn');
    const isLight = localStorage.getItem('phantom_theme') === 'light';
    if (isLight) {
      document.documentElement.classList.add('theme-light');
    }

    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const isCurrentlyLight = document.documentElement.classList.contains('theme-light');
        if (isCurrentlyLight) {
          document.documentElement.classList.remove('theme-light');
          localStorage.setItem('phantom_theme', 'dark');
        } else {
          document.documentElement.classList.add('theme-light');
          localStorage.setItem('phantom_theme', 'light');
        }
      });
    }
  }

  // ─── Initialize ───
  initTheme();

  Chat.init();
  Settings.init();
  Management.init();
  if (window.WorkspaceExplorer) window.WorkspaceExplorer.init();
  connectWebSocket();
  loadConversations();
  initImageDrop();

  document.querySelectorAll('.quick-start[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      messageInput.value = button.dataset.prompt || '';
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      messageInput.focus();
    });
  });

  // ─── WebSocket ───
  // ─── Preview Panel Logic ───
  let lastPreviewHtml = '';
  const previewPanel = document.getElementById('preview-panel');
  const previewIframe = document.getElementById('preview-iframe');
  const previewTitle = document.getElementById('preview-title');

  window.showPreview = function showPreview(htmlContent, title) {
    if (!previewPanel) return;
    lastPreviewHtml = htmlContent;

    if (title) previewTitle.textContent = title;

    // Instead of directly writing to the document (which gets blocked without allow-same-origin),
    // we use a Data URI or srcdoc to safely render the content in the sandboxed iframe.
    previewIframe.srcdoc = htmlContent;

    previewPanel.classList.remove('hidden');

    // Attempt to shrink chat width so they can be side-by-side on large screens
    if (window.innerWidth > 1000) {
      document.querySelector('.main-content').style.width = '55vw';
    }
  }

  function hidePreview() {
    if (!previewPanel) return;
    previewPanel.classList.add('hidden');
    document.querySelector('.main-content').style.width = '100%';
  }

  document.getElementById('preview-close-btn')?.addEventListener('click', hidePreview);
  document.getElementById('preview-refresh-btn')?.addEventListener('click', () => {
    if (lastPreviewHtml) showPreview(lastPreviewHtml, previewTitle.textContent);
  });
  document.getElementById('preview-popout-btn')?.addEventListener('click', () => {
    if (!lastPreviewHtml) return;
    const newWin = window.open('', '_blank');
    if (newWin) {
      const isFullHtml = lastPreviewHtml.trim().toLowerCase().startsWith('<!doctype html>') || lastPreviewHtml.trim().toLowerCase().startsWith('<html');

      if (isFullHtml) {
        newWin.document.write(lastPreviewHtml);
      } else {
        const title = previewTitle?.textContent || 'Preview';
        newWin.document.write(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; background: #0d0d0d; color: #fff; }
    /* Inject root vars to match dark theme loosely */
    :root { --bg-dark: #0d0d0d; --text-light: #f3f4f6; }
  </style>
</head>
<body>
  ${lastPreviewHtml}
</body>
</html>
        `);
      }
      newWin.document.close();
    }
  });

  // ─── WebSocket ───
  let pingTimer = null;
  let reconnectTimer = null;

  function startHeartbeat() {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
          console.error('[WebSocket] Ping failed:', e);
        }
      }
    }, 15000);
  }

  function stopHeartbeat() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      attemptReconnect();
      return;
    }

    ws.onopen = () => {
      setStatus(true);
      reconnectAttempts = 0;
      startHeartbeat();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') return;
        handleMessage(msg);
      } catch (err) {
        console.error('WebSocket parsing error:', err);
      }
    };

    ws.onclose = () => {
      stopHeartbeat();
      setStatus(false);
      chatSessions.disconnect();
      renderActiveSession();
      renderConversationList();
      updateButtons();
      attemptReconnect();
    };

    ws.onerror = (err) => {
      console.warn('WebSocket connection error:', err);
    };
  }

  function attemptReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    // Exponential backoff capped at 10 seconds, infinite retries
    const delay = Math.min(1000 * Math.pow(1.5, Math.min(reconnectAttempts, 10)), 10000);
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttempts = 0;
        connectWebSocket();
      }
    }
  });

  function setStatus(online) {
    if (online) {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Connected';
      connectionBadge.className = 'connection-badge online';
      connectionBadge.textContent = '● Online';
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Disconnected';
      connectionBadge.className = 'connection-badge offline';
      connectionBadge.textContent = '● Offline';
    }
  }

  // ─── Message Handler ───
  function handleMessage(msg) {
    if (msg.type === 'session_ready') {
      chatSessions.multiplexed = msg.protocolVersion >= 2;
      chatSessions.maxConcurrent = Math.max(1, Math.min(32, Number(msg.maxConcurrentChats) || 4));
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'title_updated') { loadConversations(); return; }
    if (msg.type === 'protocol_error') { window.Toast.show(msg.message, 'error'); return; }
    const session = chatSessions.route(msg);
    if (!session) return; // Never guess that an unscoped frame belongs to the visible chat.
    if (msg.type === 'conversation_created') {
      if (session === activeSession) currentConversationId = session.conversationId;
      loadConversations();
      return;
    }
    if (session === activeSession) {
      renderChatEvent({ ...msg });
      updateButtons();
    }
    if (['response_start', 'response_end', 'error'].includes(msg.type)) renderConversationList();
  }

  function renderChatEvent(msg, replay = false) {
    switch (msg.type) {
      case 'user_message':
        Chat.addUserMessage(msg.content, msg.image);
        break;
      case 'system_message':
        Chat.addSystemMessage(msg.content);
        break;

      case 'response_start':
        Chat.startAssistantMessage();
        break;

      case 'thinking':
        Chat.addThinkingChunk(msg.content);
        break;

      case 'chunk':
        Chat.appendChunk(msg.content || msg.data || '', replay);
        break;

      case 'tool_call':
        Chat.endAssistantMessage();
        Chat.addToolCall(msg);
        break;

      case 'tool_progress':
        Chat.updateToolProgress(msg);
        break;

      case 'tool_result':
        if (!replay && String(msg.result || '').includes('[SUDO_REQUIRED]')) {
          showSudoModal();
        }
        if (['show_preview_window', 'show_code_demo', 'analyze_target_graph'].includes(msg.name)) {
          try {
            const resObj = typeof msg.result === 'string' ? JSON.parse(msg.result) : msg.result;
            if (resObj && resObj.html_content) {
              if (!replay) {
              window.showPreview(resObj.html_content, resObj.title || 'Preview');

              if (resObj.open_new_window) {
                const previewSession = activeSession;
                // Wait a tick for the UI to update, then click the popout button automatically
                setTimeout(() => {
                  if (activeSession === previewSession) document.getElementById('preview-popout-btn')?.click();
                }, 100);
              }

              }
              // Keep transcript replay free of preview-window side effects.
              msg.result = resObj.message || 'Success';
            }
          } catch (e) {
            console.error(`Failed to parse ${msg.name} result:`, e);
          }
        }
        Chat.addToolResult(msg);
        break;

      case 'response_end':
        Chat.endAssistantMessage();
        break;

      case 'title_updated':
        loadConversations();
        break;

      case 'error':
        Chat.addErrorMessage(msg.message);
        if (msg.terminal) Chat.endAssistantMessage();
        break;

      case 'pong':
        break;
    }
  }

  // ─── Send Message ───
  function sendMessage() {
    const content = messageInput.value.trim();
    if ((!content && !pendingImage) || activeSession.processing || activeSession.loading) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      window.Toast.show('Not connected to server. Your draft has been kept.', 'warning');
      connectWebSocket();
      return;
    }
    let requestId;
    try { requestId = chatSessions.begin(activeSession); }
    catch (error) { window.Toast.show(error.message, 'warning'); return; }
    const finalContent = pendingImage
      ? `${content || 'Please analyze this image.'}\n\n[IMAGE ATTACHED: ${pendingImageName || 'image.png'}]\nImage data: ${pendingImage}`
      : content;
    const frame = { type: 'user_message', content: content || '🖼️ Image provided', image: pendingImage };
    chatSessions.record(activeSession, frame);
    renderChatEvent(frame);
    try {
      ws.send(JSON.stringify({ type: 'chat', content: finalContent, conversationId: currentConversationId, requestId }));
    } catch {
      handleMessage({ type: 'error', message: 'Could not send this message. Reconnect and retry.', requestId, conversationId: currentConversationId, terminal: true });
      return;
    }
    messageInput.value = '';
    messageInput.style.height = 'auto';
    activeSession.draft = '';
    activeSession.image = null;
    activeSession.imageName = '';
    clearPendingImage();
    updateButtons();
    renderConversationList();
  }

  // ─── Stop AI ───
  function stopAI() {
    if (activeSession.processing && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop', conversationId: activeSession.conversationId, requestId: activeSession.requestId }));
      const frame = { type: 'system_message', content: '⏹ Stop requested for this chat…' };
      chatSessions.record(activeSession, frame);
      renderChatEvent(frame);
    }
  }

  // ─── Button State Management ───
  function updateButtons() {
    messageInput.disabled = activeSession.loading;
    if (activeSession.processing) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      sendBtn.disabled = activeSession.loading || (!messageInput.value.trim() && !pendingImage);
    }
  }

  // ─── Image Drop / OSINT ───
  function initImageDrop() {
    const inputArea = document.getElementById('input-area');
    const inputContainer = document.querySelector('.input-container');

    // Create image preview area
    const previewEl = document.createElement('div');
    previewEl.id = 'image-preview-bar';
    previewEl.className = 'image-preview-bar hidden';
    previewEl.innerHTML = `
      <div class="image-preview-inner">
        <span class="image-preview-icon">🖼️</span>
        <img id="image-preview-thumb" src="" alt="preview" class="image-preview-thumb"/>
        <span id="image-preview-name" class="image-preview-name"></span>
        <span class="image-preview-badge">OSINT Ready</span>
        <button type="button" id="image-preview-remove" class="image-preview-remove" title="Remove image" aria-label="Remove image">✕</button>
      </div>
    `;
    inputArea.insertBefore(previewEl, inputArea.firstChild);

    document.getElementById('image-preview-remove').addEventListener('click', clearPendingImage);

    // ── Create hidden file input for click-to-upload ──
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.id = 'image-upload-input';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) loadImageFile(file);
      fileInput.value = '';
    });

    // ── Image button in input bar ──
    const imageBtn = document.createElement('button');
    imageBtn.type = 'button';
    imageBtn.id = 'image-upload-btn';
    imageBtn.className = 'image-upload-btn';
    imageBtn.title = 'Attach an image';
    imageBtn.setAttribute('aria-label', 'Attach an image');
    imageBtn.innerHTML = '🖼️';
    imageBtn.addEventListener('click', () => fileInput.click());
    inputContainer.insertBefore(imageBtn, inputContainer.querySelector('textarea'));

    // ── Drag and Drop on entire chat area & input ──
    const dropZone = document.getElementById('chat-area');

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
      if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
      }
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('image/')) {
        loadImageFile(files[0]);
      }
    });

    // Also allow paste of images
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) loadImageFile(file);
          break;
        }
      }
    });
  }

  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const session = activeSession;
    const generation = (session.imageGeneration || 0) + 1;
    session.imageGeneration = generation;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (session.imageGeneration !== generation) return;
      session.image = e.target.result;
      session.imageName = file.name;
      if (activeSession !== session) return;
      pendingImage = e.target.result;
      pendingImageName = file.name;
      showImagePreview(e.target.result, file.name);
      updateButtons();
      messageInput.focus();
    };
    reader.readAsDataURL(file);
  }

  function showImagePreview(dataUrl, name) {
    const bar = document.getElementById('image-preview-bar');
    const thumb = document.getElementById('image-preview-thumb');
    const nameEl = document.getElementById('image-preview-name');
    thumb.src = dataUrl;
    nameEl.textContent = name || 'image.png';
    bar.classList.remove('hidden');
  }

  function clearPendingImage() {
    activeSession.imageGeneration = (activeSession.imageGeneration || 0) + 1;
    activeSession.image = null;
    activeSession.imageName = '';
    pendingImage = null;
    pendingImageName = '';
    const bar = document.getElementById('image-preview-bar');
    if (bar) bar.classList.add('hidden');
    const thumb = document.getElementById('image-preview-thumb');
    if (thumb) thumb.src = '';
    updateButtons();
  }

  // ─── Conversations ───
  async function loadConversations() {
    try {
      const res = await fetch('/api/conversations');
      conversations = await res.json();
      renderConversationList();
    } catch (err) {
      console.error('Failed to load conversations:', err);
      window.Toast.show('Failed to load conversations', 'error');
    }
  }

  function renderConversationList(filter = searchInput.value) {
    convList.innerHTML = '';
    const filtered = filter
      ? conversations.filter(c => c.title.toLowerCase().includes(filter.toLowerCase()))
      : conversations;

    for (const conv of filtered) {
      const session = chatSessions.find(conv.id);
      const el = document.createElement('div');
      el.className = `conv-item${conv.id === currentConversationId ? ' active' : ''}`;
      el.innerHTML = `
        <button type="button" class="conv-select"${conv.id === currentConversationId ? ' aria-current="true"' : ''}>
          <span class="conv-icon" aria-hidden="true">💬</span>
          <span class="conv-title">${escapeHtml(conv.title)}</span>
          ${session?.processing ? '<span class="conv-activity running" aria-label="Generating reply" title="Generating reply">●</span>' : session?.unread ? '<span class="conv-activity" aria-label="Unread reply" title="Unread reply">●</span>' : ''}
        </button>
        <button type="button" class="conv-delete" title="Delete" aria-label="Delete conversation">✕</button>
      `;

      el.querySelector('.conv-delete').addEventListener('click', () => deleteConversation(conv.id));
      el.querySelector('.conv-select').addEventListener('click', () => selectConversation(conv.id));

      convList.appendChild(el);
    }
  }

  async function selectConversation(id) {
    const restoreListFocus = convList.contains(document.activeElement);
    const session = chatSessions.find(id) || chatSessions.create(id);
    activateSession(session);
    renderConversationList();
    if (restoreListFocus) convList.querySelector('[aria-current="true"]')?.focus();
    sidebarNavigation.closeMobile();

    if (session.processing) return;
    const generation = ++historyGeneration;
    const revision = session.revision;
    session.historyGeneration = generation;
    session.loading = true;
    updateButtons();
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (session.historyGeneration !== generation || session.revision !== revision || session.processing) return;
      session.history = data.messages || [];
      session.events = [];
      if (activeSession === session) renderActiveSession();
    } catch (err) {
      if (activeSession !== session || session.historyGeneration !== generation) return;
      console.error(err);
      window.Toast.show('Failed to load conversation', 'error');
      Chat.addErrorMessage('Failed to load conversation');
    } finally {
      if (session.historyGeneration === generation) session.loading = false;
      if (activeSession === session) updateButtons();
    }
  }

  async function deleteConversation(id) {
    const session = chatSessions.find(id);
    if (session?.processing) {
      window.Toast.show('Stop this chat before deleting it.', 'warning');
      return;
    }
    window.Toast.confirm('Are you sure you want to delete this conversation?', async () => {
      try {
        const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Delete failed');
        if (currentConversationId === id) {
          newChat();
        }
        if (session) chatSessions.sessions.delete(session.key);
        loadConversations();
      } catch (err) {
        console.error('Failed to delete conversation:', err);
        window.Toast.show('Failed to delete conversation', 'error');
      }
    });
  }

  function newChat() {
    sidebarNavigation.closeMobile();
    activateSession(chatSessions.create());
    renderConversationList();
    messageInput.focus();
  }

  function activateSession(session) {
    activeSession.draft = messageInput.value;
    activeSession.image = pendingImage;
    activeSession.imageName = pendingImageName;
    activeSession = session;
    currentConversationId = session.conversationId;
    chatSessions.activate(session);
    messageInput.value = session.draft;
    pendingImage = session.image;
    pendingImageName = session.imageName;
    if (pendingImage) showImagePreview(pendingImage, pendingImageName);
    else document.getElementById('image-preview-bar')?.classList.add('hidden');
    hidePreview();
    lastPreviewHtml = '';
    if (previewIframe) previewIframe.srcdoc = '';
    const sudoModal = document.getElementById('sudo-modal');
    if (sudoModal) sudoModal.style.display = 'none';
    const sudoInput = document.getElementById('sudo-modal-password');
    if (sudoInput) sudoInput.value = '';
    renderActiveSession();
    updateButtons();
    autoResize();
  }

  function renderActiveSession() {
    if (!activeSession.history.length && !activeSession.events.length) {
      Chat.clear();
      Chat.showWelcome();
      return;
    }
    Chat.renderHistory(activeSession.history);
    for (const frame of activeSession.events) renderChatEvent({ ...frame }, true);
  }

  // ─── Sudo Modal (opened only by an explicit privileged workflow) ───
  function showSudoModal() {
    const modal = document.getElementById('sudo-modal');
    modal.style.display = 'flex';

    const passInput = document.getElementById('sudo-modal-password');
    const validateBtn = document.getElementById('sudo-modal-validate');
    const skipBtn = document.getElementById('sudo-modal-skip');
    const toggleEye = document.getElementById('sudo-modal-toggle-eye');
    const feedback = document.getElementById('sudo-modal-feedback');

    setTimeout(() => passInput.focus(), 100);

    toggleEye.onclick = () => {
      passInput.type = passInput.type === 'password' ? 'text' : 'password';
    };

    passInput.onkeydown = (e) => {
      if (e.key === 'Enter') validateSudoPassword();
    };

    validateBtn.onclick = () => validateSudoPassword();

    skipBtn.onclick = () => {
      modal.style.display = 'none';
    };

    async function validateSudoPassword() {
      const password = passInput.value.trim();
      if (!password) {
        feedback.className = 'sudo-modal-feedback error';
        feedback.textContent = '❌ Please enter a password';
        return;
      }

      validateBtn.disabled = true;
      validateBtn.textContent = '⏳ Validating...';
      feedback.className = 'sudo-modal-feedback';
      feedback.textContent = '';

      try {
        const res = await fetch('/api/sudo/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();

        if (data.valid) {
          feedback.className = 'sudo-modal-feedback success';
          feedback.textContent = '✅ ' + data.message;
          setTimeout(() => {
            modal.style.display = 'none';
          }, 1000);
        } else {
          feedback.className = 'sudo-modal-feedback error';
          feedback.textContent = '❌ ' + data.message;
        }
      } catch (err) {
        feedback.className = 'sudo-modal-feedback error';
        feedback.textContent = '❌ Connection error: ' + err.message;
      }

      validateBtn.disabled = false;
      validateBtn.textContent = '🔓 Validate & Grant Access';
    }
  }

  // ─── Input Handling ───
  messageInput.addEventListener('input', () => {
    updateButtons();
    autoResize();
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const lines = messageInput.value.split('\n').length;
      if (lines <= 1) {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', stopAI);
  newChatBtn.addEventListener('click', newChat);

  const exportBtn = document.getElementById('export-chat-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (!currentConversationId) {
        window.Toast.show('No active conversation to export.', 'warning');
        return;
      }
      window.open(`/api/conversations/${currentConversationId}/export?format=html`, '_blank');
    });
  }

  searchInput.addEventListener('input', () => {
    renderConversationList(searchInput.value);
  });

  function autoResize() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  }

  // ─── Keepalive ───
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);


  // ─── System Update Logic ───
  async function checkSystemUpdate() {
    try {
      const res = await fetch('/api/system/check-update');
      const data = await res.json();
      if (data.updateAvailable) {
        showUpdateBanner(data);
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
    }
  }

  function showUpdateBanner(data) {
    const banner = document.getElementById('update-banner');
    const msg = document.getElementById('update-message');
    const btnNow = document.getElementById('btn-update-now');
    const btnDismiss = document.getElementById('btn-update-dismiss');

    if (!banner) return;

    if (data.message) {
      msg.textContent = `[${data.commitsBehind} commits behind] ${data.message.substring(0, 50)}` + (data.message.length > 50 ? '...' : '');
    }

    banner.classList.remove('hidden');

    btnDismiss.onclick = () => {
      banner.classList.add('hidden');
    };

    btnNow.onclick = () => {
      banner.classList.add('hidden');
      startSystemUpdate();
    };
  }

  function startSystemUpdate() {
    const modal = document.getElementById('update-progress-modal');
    const logEl = document.getElementById('update-log');
    if (!modal || !logEl) return;

    modal.classList.remove('hidden');
    logEl.textContent = 'Initializing update...\n';

    fetch('/api/system/update', { method: 'POST' })
      .then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function read() {
          reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // keep incomplete event in buffer
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.substring(6);
                if (dataStr === '[DONE]') {
                  logEl.textContent += '\n✓ Update complete! Reconnecting to PHANTOM server...';
                  logEl.scrollTop = logEl.scrollHeight;
                  let pollCount = 0;
                  const pollInterval = setInterval(() => {
                    pollCount++;
                    fetch('/api/system/info')
                      .then(r => {
                        if (r.ok) {
                          clearInterval(pollInterval);
                          logEl.textContent += '\n✓ Server online! Reloading interface...';
                          setTimeout(() => window.location.reload(), 600);
                        }
                      })
                      .catch(() => {
                        if (pollCount > 60) {
                          clearInterval(pollInterval);
                          window.location.reload();
                        }
                      });
                  }, 1000);
                  return;
                }
                try {
                  const data = JSON.parse(dataStr);
                  if (data.progress) {
                    logEl.textContent += data.progress + '\n';
                    logEl.scrollTop = logEl.scrollHeight;
                  }
                  if (data.error) {
                    logEl.textContent += '\nError: ' + data.error + '\n';
                  }
                } catch (e) { console.error('Error parsing update stream chunk:', e, dataStr); }
              }
            }
            read();
          });
        }
        read();
      })
      .catch(err => {
        logEl.textContent += '\nConnection error: ' + err.message + '\n';
      });
  }

  // Check for updates shortly after load and then every 1 hour
  setTimeout(checkSystemUpdate, 5000);
  setInterval(checkSystemUpdate, 60 * 60 * 1000);

  // ─── Helpers ───
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
