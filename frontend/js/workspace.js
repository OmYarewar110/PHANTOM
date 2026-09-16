/**
 * Workspace File Explorer & Reader Logic
 * Features:
 * - Drag-to-resize workspace panel width
 * - Forward & Back navigation history
 * - Real-time file filter/search
 * - View any text/code file (.txt, .md, .json, .sh, .py, .js, .html, etc.)
 * - Rich rendered markdown preview for .md files
 * - Copy content button
 */
window.WorkspaceExplorer = {
  panel: null,
  resizer: null,
  isOpen: false,
  treeData: [],
  history: [],
  historyIndex: -1,
  currentFile: null,

  init() {
    this.panel = document.getElementById('workspace-panel');
    this.resizer = document.getElementById('workspace-resizer');

    const toggleBtn = document.getElementById('workspace-toggle-btn');
    const closeBtn = document.getElementById('workspace-close-btn');
    const refreshBtn = document.getElementById('workspace-refresh-btn');
    const searchInput = document.getElementById('workspace-search-input');
    const backBtn = document.getElementById('ws-nav-back');
    const forwardBtn = document.getElementById('ws-nav-forward');
    const viewerBackBtn = document.getElementById('viewer-back-btn');
    const viewerCloseBtn = document.getElementById('viewer-close-btn');
    const viewerCopyBtn = document.getElementById('viewer-copy-btn');

    toggleBtn?.addEventListener('click', () => this.toggle());
    closeBtn?.addEventListener('click', () => this.close());
    refreshBtn?.addEventListener('click', () => this.loadTree());

    // Navigation
    backBtn?.addEventListener('click', () => this.goBack());
    forwardBtn?.addEventListener('click', () => this.goForward());
    viewerBackBtn?.addEventListener('click', () => this.showTree());
    viewerCloseBtn?.addEventListener('click', () => this.showTree());

    // Copy file content
    viewerCopyBtn?.addEventListener('click', () => {
      const contentEl = document.getElementById('viewer-content');
      const text = contentEl?.textContent || '';
      if (text && window.copyText) {
        window.copyText(text, viewerCopyBtn);
      }
    });

    // Real-time Search / Filter
    searchInput?.addEventListener('input', (e) => {
      this.filterTree(e.target.value.trim().toLowerCase());
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        const viewer = document.getElementById('workspace-file-viewer');
        if (viewer && !viewer.classList.contains('hidden')) {
          this.showTree();
        } else {
          this.close();
        }
      }
    });

    // Resizing logic
    this.initResizer();

    // Restore saved width
    const savedWidth = localStorage.getItem('phantom_workspace_width');
    if (savedWidth && this.panel) {
      this.panel.style.width = `${savedWidth}px`;
    }
  },

  initResizer() {
    if (!this.resizer || !this.panel) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseDown = (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = this.panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      if (!isResizing) return;
      const dx = startX - e.clientX; // drag left expands panel
      const newWidth = Math.max(220, Math.min(window.innerWidth * 0.7, startWidth + dx));
      this.panel.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('phantom_workspace_width', this.panel.offsetWidth);

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    this.resizer.addEventListener('mousedown', onMouseDown);
  },

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  open() {
    if (!this.panel) return;
    this.isOpen = true;
    this.panel.classList.remove('hidden');
    if (this.history.length === 0) {
      this.pushHistory({ type: 'tree' });
    }
    this.loadTree();
  },

  close() {
    if (!this.panel || !this.isOpen) return;
    this.isOpen = false;
    this.panel.classList.add('hidden');
  },

  // ─── History Navigation (Back / Forward) ───
  pushHistory(state) {
    // Truncate forward history if we're in the middle
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }
    this.history.push(state);
    this.historyIndex = this.history.length - 1;
    this.updateNavButtons();
  },

  goBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreHistoryState(this.history[this.historyIndex]);
    }
  },

  goForward() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreHistoryState(this.history[this.historyIndex]);
    }
  },

  restoreHistoryState(state) {
    this.updateNavButtons();
    if (!state) return;
    if (state.type === 'tree') {
      this.showTree(false);
    } else if (state.type === 'file' && state.path) {
      this.previewFile(state.path, false);
    }
  },

  updateNavButtons() {
    const backBtn = document.getElementById('ws-nav-back');
    const forwardBtn = document.getElementById('ws-nav-forward');
    if (backBtn) backBtn.disabled = this.historyIndex <= 0;
    if (forwardBtn) forwardBtn.disabled = this.historyIndex >= this.history.length - 1;
  },

  // ─── Tree Explorer ───
  async loadTree() {
    const treeEl = document.getElementById('workspace-tree');
    if (!treeEl) return;

    treeEl.innerHTML = '<div class="workspace-loading">⏳ Loading workspace files...</div>';

    try {
      const res = await fetch('/api/workspace/files');
      const data = await res.json();

      if (data.success) {
        this.treeData = data.tree || [];
        if (this.treeData.length === 0) {
          treeEl.innerHTML = '<div class="workspace-empty">📁 Workspace is empty</div>';
          return;
        }
        treeEl.innerHTML = this.renderNodes(this.treeData);
        this.attachTreeListeners();
      } else {
        treeEl.innerHTML = `<div class="workspace-error">❌ ${this.escapeHtml(data.error)}</div>`;
      }
    } catch (err) {
      treeEl.innerHTML = `<div class="workspace-error">❌ Error: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  renderNodes(nodes, level = 0) {
    return `<ul class="tree-list level-${level}">` + nodes.map(node => {
      if (node.isDirectory) {
        return `
          <li class="tree-node directory">
            <div class="tree-item dir-item" data-path="${node.path}">
              <span class="folder-toggle">▼</span>
              <span class="tree-icon">📁</span>
              <span class="tree-name">${this.escapeHtml(node.name)}</span>
            </div>
            <div class="subtree">
              ${node.children ? this.renderNodes(node.children, level + 1) : ''}
            </div>
          </li>
        `;
      } else {
        const icon = this.getFileIcon(node.name);
        const sizeStr = this.formatSize(node.size);
        return `
          <li class="tree-node file">
            <div class="tree-item file-item" data-path="${node.path}">
              <span class="tree-icon">${icon}</span>
              <span class="tree-name">${this.escapeHtml(node.name)}</span>
              <span class="tree-size">${sizeStr}</span>
            </div>
          </li>
        `;
      }
    }).join('') + '</ul>';
  },

  attachTreeListeners() {
    const treeEl = document.getElementById('workspace-tree');
    if (!treeEl) return;

    // Folder toggle
    treeEl.querySelectorAll('.dir-item').forEach(dirItem => {
      dirItem.addEventListener('click', (e) => {
        const parentLi = dirItem.closest('.tree-node');
        const toggleSpan = dirItem.querySelector('.folder-toggle');
        const subtree = parentLi.querySelector('.subtree');

        if (subtree) {
          if (subtree.style.display === 'none') {
            subtree.style.display = 'block';
            if (toggleSpan) toggleSpan.textContent = '▼';
          } else {
            subtree.style.display = 'none';
            if (toggleSpan) toggleSpan.textContent = '▶';
          }
        }
      });
    });

    // File click -> Preview
    treeEl.querySelectorAll('.file-item').forEach(fileItem => {
      fileItem.addEventListener('click', () => {
        const path = fileItem.dataset.path;
        if (path) this.previewFile(path, true);
      });
    });
  },

  filterTree(query) {
    const treeEl = document.getElementById('workspace-tree');
    if (!treeEl) return;

    if (!query) {
      treeEl.innerHTML = this.renderNodes(this.treeData);
      this.attachTreeListeners();
      return;
    }

    const filterNodes = (nodes) => {
      const result = [];
      for (const node of nodes) {
        if (node.isDirectory) {
          const matchingChildren = node.children ? filterNodes(node.children) : [];
          if (matchingChildren.length > 0 || node.name.toLowerCase().includes(query)) {
            result.push({ ...node, children: matchingChildren });
          }
        } else {
          if (node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)) {
            result.push(node);
          }
        }
      }
      return result;
    };

    const filtered = filterNodes(this.treeData);
    if (filtered.length === 0) {
      treeEl.innerHTML = `<div class="workspace-empty">🔍 No matching files found</div>`;
    } else {
      treeEl.innerHTML = this.renderNodes(filtered);
      this.attachTreeListeners();
    }
  },

  // ─── In-Panel File Viewer (Text, Code, Markdown) ───
  showTree(recordHistory = true) {
    const viewer = document.getElementById('workspace-file-viewer');
    const headerTitle = document.getElementById('ws-header-title');
    if (viewer) viewer.classList.add('hidden');
    if (headerTitle) headerTitle.textContent = 'Workspace';
    this.currentFile = null;

    if (recordHistory) {
      this.pushHistory({ type: 'tree' });
    }
  },

  async previewFile(path, recordHistory = true) {
    const viewer = document.getElementById('workspace-file-viewer');
    const filenameEl = document.getElementById('viewer-filename');
    const contentEl = document.getElementById('viewer-content');
    const markdownEl = document.getElementById('viewer-markdown');
    const headerTitle = document.getElementById('ws-header-title');

    if (!viewer || !filenameEl || !contentEl || !markdownEl) return;

    this.currentFile = path;
    filenameEl.textContent = path;
    if (headerTitle) headerTitle.textContent = path.split('/').pop();

    contentEl.textContent = '⏳ Loading file content...';
    markdownEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
    viewer.classList.remove('hidden');

    if (recordHistory) {
      this.pushHistory({ type: 'file', path });
    }

    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();

      if (data.success) {
        const ext = path.split('.').pop()?.toLowerCase();
        const content = data.content;

        if (ext === 'md' && window.renderMarkdown) {
          // Markdown rendered view
          markdownEl.innerHTML = window.renderMarkdown(content);
          markdownEl.classList.remove('hidden');
          contentEl.classList.add('hidden');
        } else if (ext === 'json') {
          try {
            const parsed = JSON.parse(content);
            contentEl.textContent = JSON.stringify(parsed, null, 2);
          } catch (e) {
            contentEl.textContent = content;
          }
        } else {
          contentEl.textContent = content;
        }
      } else {
        contentEl.textContent = `❌ Error loading file: ${data.error}`;
      }
    } catch (err) {
      contentEl.textContent = `❌ Network Error: ${err.message}`;
    }
  },

  getFileIcon(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js': case 'jsx': case 'mjs': return '🟨';
      case 'ts': case 'tsx': return '🔷';
      case 'py': return '🐍';
      case 'html': case 'htm': return '🌐';
      case 'css': return '🎨';
      case 'json': return '📋';
      case 'md': return '📝';
      case 'sh': case 'bash': return '⚡';
      case 'sql': case 'db': return '💾';
      case 'png': case 'jpg': case 'jpeg': case 'svg': return '🖼️';
      case 'yaml': case 'yml': return '⚙️';
      case 'txt': case 'log': return '📄';
      default: return '📄';
    }
  },

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
