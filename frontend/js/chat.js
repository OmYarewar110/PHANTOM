/**
 * Chat rendering and interaction logic
 * Enhanced with:
 *  - Real-time typing animation (character by character)
 *  - AI thinking/reasoning display (shown before the answer)
 *  - FIXED: Auto-scroll now works correctly during streaming
 *  - Image message support
 */
window.Chat = {
  messagesEl: null,
  currentAssistantEl: null,
  currentContent: '',
  renderedContent: '',
  isStreaming: false,
  // Typing animation state
  typingQueue: [],
  typingIndex: 0,
  typingTimer: null,
  typingSpeed: 22, // ms per character — slightly slower for visible effect
  // Thinking state
  currentThinkingEl: null,
  thinkingContent: '',
  // Auto-scroll control: user can scroll up to pause, near-bottom = resume
  _userScrolled: false,
  _lastScrollTop: 0,

  init() {
    this.messagesEl = document.getElementById('messages');
    this._chatArea = document.getElementById('chat-area');

    // Detect when user manually scrolls up (pause auto-scroll)
    this._chatArea.addEventListener('scroll', () => {
      const threshold = 80;
      const currentScrollTop = this._chatArea.scrollTop;
      const distFromBottom = Math.ceil(this._chatArea.scrollHeight - currentScrollTop - this._chatArea.clientHeight);

      if (distFromBottom <= threshold) {
        // If we are at or near the bottom, resume auto-scroll
        this._userScrolled = false;
      } else if (currentScrollTop < this._lastScrollTop) {
        // If we are NOT near the bottom AND we scrolled UP,
        // it means the user intentionally scrolled back.
        this._userScrolled = true;
      }

      this._lastScrollTop = currentScrollTop;
    });
  },

  clear() {
    this.messagesEl.innerHTML = '';
    this.currentAssistantEl = null;
    this.currentContent = '';
    this.renderedContent = '';
    this.currentThinkingEl = null;
    this.thinkingContent = '';
    this.typingQueue = [];
    this.typingIndex = 0;
    this._userScrolled = false;
    if (this.typingTimer) {
      cancelAnimationFrame(this.typingTimer);
      this.typingTimer = null;
    }
  },

  showWelcome() {
    document.getElementById('welcome-screen').style.display = 'flex';
    this.messagesEl.style.display = 'none';
  },

  hideWelcome() {
    document.getElementById('welcome-screen').style.display = 'none';
    this.messagesEl.style.display = 'flex';
  },

  addUserMessage(content, imageDataUrl) {
    this.hideWelcome();
    this._userScrolled = false; // reset on new user message
    const el = document.createElement('div');
    el.className = 'message user';

    // Add user message content container
    const contentEl = document.createElement('div');
    if (imageDataUrl) {
      const img = document.createElement('img');
      img.src = imageDataUrl;
      img.className = 'msg-image';
      img.alt = 'Uploaded image';
      contentEl.appendChild(img);
      if (content) {
        const textEl = document.createElement('div');
        textEl.textContent = content;
        textEl.style.marginTop = '8px';
        contentEl.appendChild(textEl);
      }
    } else {
      contentEl.textContent = content;
    }
    el.appendChild(contentEl);

    // Add timestamp
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const footerEl = document.createElement('div');
    footerEl.className = 'message-footer user';
    footerEl.innerHTML = `<span class="message-timestamp">${timeStr}</span>`;
    el.appendChild(footerEl);

    this.messagesEl.appendChild(el);
    this.scrollToBottom(true);
  },

  /**
   * Show AI thinking/reasoning text — displayed BEFORE the answer
   */
  addThinkingChunk(text) {
    this.hideWelcome();

    if (!this.currentThinkingEl) {
      this.currentThinkingEl = document.createElement('details');
      this.currentThinkingEl.className = 'message thinking';
      this.currentThinkingEl.open = true;

      const label = document.createElement('summary');
      label.className = 'thinking-label';
      label.textContent = '🧠 Thinking...';
      this.currentThinkingEl.appendChild(label);

      const contentEl = document.createElement('div');
      contentEl.className = 'thinking-content';
      this.currentThinkingEl.appendChild(contentEl);

      this.messagesEl.appendChild(this.currentThinkingEl);
      this.thinkingContent = '';
    }

    this.thinkingContent += text;
    const contentEl = this.currentThinkingEl.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = this.thinkingContent;
      // Auto-scroll the thinking content box itself
      contentEl.scrollTop = contentEl.scrollHeight;
    }
    this.scrollToBottom();
  },

  /**
   * End thinking — fade it slightly, update label
   */
  endThinking() {
    if (this.currentThinkingEl) {
      this.currentThinkingEl.classList.add('thinking-done');
      this.currentThinkingEl.open = false;
      const label = this.currentThinkingEl.querySelector('.thinking-label');
      if (label) label.textContent = '🧠 Thought process';
    }
    this.currentThinkingEl = null;
    this.thinkingContent = '';
  },

  startAssistantMessage() {
    this.hideWelcome();

    // End any thinking block (thinking already shown above)
    this.endThinking();

    this.currentContent = '';
    this.renderedContent = '';
    this.typingQueue = [];
    this.typingIndex = 0;
    this.currentAssistantEl = document.createElement('div');
    this.currentAssistantEl.className = 'message assistant';

    // Add typing indicator dots
    const typing = document.createElement('div');
    typing.className = 'typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    this.currentAssistantEl.appendChild(typing);

    this.messagesEl.appendChild(this.currentAssistantEl);
    this.isStreaming = true;
    this.scrollToBottom(true);

    // Start the typing animation loop
    this._startTypingLoop();
  },

  appendChunk(text) {
    if (!this.currentAssistantEl) {
      this.startAssistantMessage();
    }

    // Remove typing indicator dots on first chunk
    const typing = this.currentAssistantEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    // Add text to full content buffer
    this.currentContent += text;

    // Queue only the NEW characters for typing animation
    for (const char of text) {
      this.typingQueue.push(char);
    }
  },

  /**
   * Typing animation loop — renders characters gradually, not all at once
   * FIXED: scrollToBottom now called after every render to keep up
   */
  _startTypingLoop() {
    let lastTime = 0;

    const animate = (timestamp) => {
      if (!this.isStreaming && this.typingIndex >= this.typingQueue.length) {
        return; // Stop the loop
      }

      if (this.typingIndex < this.typingQueue.length) {
        const elapsed = timestamp - lastTime;

        // Adaptive speed: speed up when queue grows to prevent lag
        const queueSize = this.typingQueue.length - this.typingIndex;
        let speed = this.typingSpeed;
        if (queueSize > 200) speed = 1;
        else if (queueSize > 100) speed = 3;
        else if (queueSize > 50) speed = 6;
        else if (queueSize > 20) speed = 8;

        if (elapsed >= speed) {
          // Batch size also adapts to prevent falling behind
          const batchSize = Math.min(
            queueSize,
            queueSize > 200 ? 30 :
            queueSize > 100 ? 15 :
            queueSize > 50 ? 8 :
            queueSize > 20 ? 4 : 2
          );

          for (let i = 0; i < batchSize; i++) {
            if (this.typingIndex < this.typingQueue.length) {
              this.renderedContent += this.typingQueue[this.typingIndex++];
            }
          }

          // Re-render markdown with what we've typed so far
          if (this.currentAssistantEl) {
            this.currentAssistantEl.innerHTML = window.renderMarkdown(this.renderedContent);
          }

          // FIXED: Force scroll to bottom after each render frame
          this.scrollToBottom(false, true);
          lastTime = timestamp;
        }
      }

      this.typingTimer = requestAnimationFrame(animate);
    };

    this.typingTimer = requestAnimationFrame(animate);
  },

  endAssistantMessage() {
    if (this.currentAssistantEl) {
      // Remove any remaining typing indicator
      const typing = this.currentAssistantEl.querySelector('.typing-indicator');
      if (typing) typing.remove();

      // Flush any remaining queued characters
      if (this.typingIndex < this.typingQueue.length) {
        this.renderedContent += this.typingQueue.slice(this.typingIndex).join('');
        this.typingQueue = [];
        this.typingIndex = 0;
      }

      // Final full render
      if (this.renderedContent || this.currentContent) {
        this.currentAssistantEl.innerHTML = window.renderMarkdown(this.renderedContent || this.currentContent);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const footerEl = document.createElement('div');
        footerEl.className = 'message-footer assistant';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'message-copy-btn';
        copyBtn.setAttribute('aria-label', 'Copy message');
        copyBtn.innerHTML = '📋 Copy';
        const textToCopy = this.renderedContent || this.currentContent;
        copyBtn.onclick = () => window.copyText(textToCopy, copyBtn);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'message-timestamp';
        timeSpan.textContent = timeStr;

        footerEl.appendChild(timeSpan);
        footerEl.appendChild(copyBtn);

        this.currentAssistantEl.appendChild(footerEl);
      }
    }

    if (this.typingTimer) {
      cancelAnimationFrame(this.typingTimer);
      this.typingTimer = null;
    }

    this.currentAssistantEl = null;
    this.currentContent = '';
    this.renderedContent = '';
    this.isStreaming = false;
    this._userScrolled = false;

    // End thinking too
    this.endThinking();
    // Final scroll to bottom
    this.scrollToBottom(true);
  },

  addToolCall(data) {
    this.hideWelcome();

    if (data.name === 'write_file' || data.name === 'edit_source_code' || data.name === 'read_file') {
      const card = document.createElement('div');
      card.className = 'tool-card file-mod-card';
      card.id = `tool-${data.id}`;

      const filePath = typeof data.args === 'object' ? (data.args.path || data.args.file_path || data.args.target_file || 'unknown file') : 'unknown file';
      let actionName = 'Editing file';
      let icon = '📝';
      if (data.name === 'write_file') { actionName = 'Creating file'; icon = '📄'; }
      if (data.name === 'read_file') { actionName = 'Reading file'; icon = '📖'; }

      card.innerHTML = `
        <div class="tool-card-header file-mod-header" onclick="this.nextElementSibling.classList.toggle('expanded')" style="background: var(--bg-tertiary); border-left: 3px solid var(--accent);">
          <span>${icon} <strong>${actionName}</strong></span>
          <span style="flex:1;margin-left:8px;opacity:0.8;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(filePath)}</span>
          <span class="tool-status running"><span class="spinner"></span></span>
        </div>
        <div class="tool-card-body expanded" style="background: #1e1e1e;"></div>
      `;
      this.messagesEl.appendChild(card);
      this.scrollToBottom(true);
      return;
    }

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.id = `tool-${data.id}`;

    const argsPreview = this.getArgsPreview(data.args);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
        <span>⚡ ${this.escapeHtml(data.name)}</span>
        <span style="flex:1;margin-left:8px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(argsPreview)}</span>
        <span class="tool-status running"><span class="spinner"></span></span>
      </div>
      <div class="tool-card-body expanded"></div>
    `;

    this.messagesEl.appendChild(card);
    this.scrollToBottom(true);
  },

  /**
   * Live tool output — stream text into the tool card body in real-time
   */
  updateToolProgress(data) {
    const card = document.getElementById(`tool-${data.id}`);
    if (card) {
      const body = card.querySelector('.tool-card-body');
      if (body) {
        body.textContent += data.text;
        body.classList.add('expanded');
        // Auto-scroll the body to bottom
        body.scrollTop = body.scrollHeight;
      }
    }
    this.scrollToBottom();
  },

  addToolResult(data) {
    const card = document.getElementById(`tool-${data.id}`);
    if (card) {
      const status = card.querySelector('.tool-status');
      status.className = 'tool-status done';
      status.textContent = '✓';

      const body = card.querySelector('.tool-card-body');
      body.textContent = data.result || 'No output';
    }

    if (['write_file', 'edit_source_code', 'execute_command'].includes(data.name)) {
      window.WorkspaceExplorer?.loadTree();
    }

    this.scrollToBottom();
  },

  addSystemMessage(content) {
    const el = document.createElement('div');
    el.className = 'message system';
    el.textContent = content;
    this.messagesEl.appendChild(el);
    this.scrollToBottom(true);
  },

  addErrorMessage(content) {
    const el = document.createElement('div');
    el.className = 'message error';
    el.textContent = content;
    this.messagesEl.appendChild(el);
    this.scrollToBottom(true);
  },

  /**
   * Render full conversation history from API
   */
  renderHistory(messages) {
    this.clear();
    if (!messages || messages.length === 0) {
      this.showWelcome();
      return;
    }

    this.hideWelcome();

    for (const msg of messages) {
      if (msg.role === 'user') {
        const el = document.createElement('div');
        el.className = 'message user';

        const contentEl = document.createElement('div');
        contentEl.textContent = msg.content;
        el.appendChild(contentEl);

        const msgTimestamp = msg.timestamp || msg.created_at; const timeStr = msgTimestamp ? new Date(msgTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const footerEl = document.createElement('div');
        footerEl.className = 'message-footer user';
        if (timeStr) footerEl.innerHTML = `<span class="message-timestamp">${timeStr}</span>`;
        el.appendChild(footerEl);

        this.messagesEl.appendChild(el);
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          // Strip <think> blocks and show them before the answer
          let displayContent = msg.content;
          const thinkMatch = displayContent.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            const thinkEl = document.createElement('details');
            thinkEl.className = 'message thinking thinking-done';
            thinkEl.innerHTML = `<summary class="thinking-label">🧠 Thought process</summary><div class="thinking-content">${this.escapeHtml(thinkMatch[1].trim())}</div>`;
            this.messagesEl.appendChild(thinkEl);
            displayContent = displayContent.replace(/<think>[\s\S]*?<\/think>/, '').trim();
          }

          if (displayContent) {
            const el = document.createElement('div');
            el.className = 'message assistant';
            el.innerHTML = window.renderMarkdown(displayContent);

            const msgTimestamp = msg.timestamp || msg.created_at; const timeStr = msgTimestamp ? new Date(msgTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const footerEl = document.createElement('div');
            footerEl.className = 'message-footer assistant';

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'message-copy-btn';
            copyBtn.setAttribute('aria-label', 'Copy message');
            copyBtn.innerHTML = '📋 Copy';
            const textToCopy = displayContent;
            copyBtn.onclick = () => window.copyText(textToCopy, copyBtn);

            if (timeStr) {
                const timeSpan = document.createElement('span');
                timeSpan.className = 'message-timestamp';
                timeSpan.textContent = timeStr;
                footerEl.appendChild(timeSpan);
            }

            footerEl.appendChild(copyBtn);
            el.appendChild(footerEl);

            this.messagesEl.appendChild(el);
          }
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch (err) {
              console.error('Failed to parse tool arguments:', err);
            }

            if (tc.function.name === 'write_file' || tc.function.name === 'edit_source_code') {
              const filePath = args.path || args.file_path || 'unknown file';
              const actionName = tc.function.name === 'write_file' ? 'Created file' : 'Edited file';
              const icon = tc.function.name === 'write_file' ? '📄' : '📝';

              const card = document.createElement('div');
              card.className = 'tool-card file-mod-card';
              if (tc.id) card.id = `tool-${tc.id}`;
              card.innerHTML = `
                <div class="tool-card-header file-mod-header" onclick="this.nextElementSibling.classList.toggle('expanded')" style="background: var(--bg-tertiary); border-left: 3px solid var(--accent);">
                  <span>${icon} <strong>${actionName}</strong></span>
                  <span style="flex:1;margin-left:8px;opacity:0.8;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(filePath)}</span>
                  <span class="tool-status done">✓</span>
                </div>
                <div class="tool-card-body" style="background: #1e1e1e;">Loading...</div>
              `;
              this.messagesEl.appendChild(card);
              continue;
            }

            const argsPreview = this.getArgsPreview(args);
            const card = document.createElement('div');
            card.className = 'tool-card';
            if (tc.id) card.id = `tool-${tc.id}`;
            card.innerHTML = `
              <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
                <span>⚡ ${this.escapeHtml(tc.function.name)}</span>
                <span style="flex:1;margin-left:8px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(argsPreview)}</span>
                <span class="tool-status done">✓</span>
              </div>
              <div class="tool-card-body">Loading...</div>
            `;
            this.messagesEl.appendChild(card);
          }
        }
      } else if (msg.role === 'tool') {
        let card = null;
        if (msg.tool_call_id) {
          card = document.getElementById(`tool-${msg.tool_call_id}`);
        }
        if (!card) {
          const cards = this.messagesEl.querySelectorAll('.tool-card');
          card = cards[cards.length - 1];
        }
        if (card) {
          const body = card.querySelector('.tool-card-body');
          if (body) body.textContent = msg.content || 'No output';
        }
      }
    }
    this.scrollToBottom(true);
  },

  /**
   * FIXED: Reliable scroll to bottom
   * force=true bypasses the user-scrolled check (use on new messages)
   */
  scrollToBottom(force = false, sync = false) {
    if (!this._chatArea) return;
    if (force || !this._userScrolled) {
      if (sync) {
        this._chatArea.scrollTop = this._chatArea.scrollHeight;
        return;
      }
      // Use double rAF to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this._chatArea && (force || !this._userScrolled)) {
            this._chatArea.scrollTop = this._chatArea.scrollHeight;
          }
        });
      });
    }
  },

    getArgsPreview(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = ['command', 'path', 'file_path', 'media_path', 'query', 'goal', 'url', 'task', 'approach', 'title', 'name', 'target_name', 'content', 'code'];
    for (const key of keys) {
      if (args[key]) return String(args[key]);
    }
    const str = JSON.stringify(args);
    return str.length > 80 ? str.substring(0, 80) + '...' : str;
  },

  escapeHtml(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return str.replace(/[&<>"]/g, m => map[m]);
  },
};
