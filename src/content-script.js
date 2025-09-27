(function () {
  if (window.hasRunSmartReplyExtension) {
    return;
  }
  window.hasRunSmartReplyExtension = true;

  const MODAL_ID = 'smart-reply-extension-modal';
  const SUGGESTIONS_CONTAINER_SELECTOR = '[data-smart-reply-suggestions]';
  const USER_PROMPT_SELECTOR = '[data-smart-reply-user-prompt]';
  const GENERATE_BUTTON_SELECTOR = '[data-smart-reply-generate]';
  const GUIDANCE_CONTAINER_SELECTOR = '[data-smart-reply-guidance-presets]';
  const GUIDANCE_CHECKBOX_SELECTOR = '[data-smart-reply-guidance-preset]';
  const GUIDANCE_ADD_BUTTON_SELECTOR = '[data-smart-reply-guidance-add]';
  const PROMPT_PREVIEW_MODAL_ID = 'smart-reply-prompt-preview-modal';
  const DEFAULT_GUIDANCE_SELECTION_LIMIT = 2;
  const CARET_MARKER_SELECTOR = '[data-smart-reply-caret]';
  const LIGHTNING_PLACEHOLDER_SELECTOR = '[data-lightning-placeholder]';
  const LIGHTNING_PLACEHOLDER_TEXT = '＜文章作成中＞...';
  const PROOFREAD_MODAL_ID = 'smart-reply-proofread-modal';
  const PROOFREAD_SOURCE_SELECTOR = '[data-smart-proofread-source]';
  const PROOFREAD_RESULT_SELECTOR = '[data-smart-proofread-result]';
  const PROOFREAD_STATUS_SELECTOR = '[data-smart-proofread-status]';
  const PROOFREAD_APPLY_SELECTOR = '[data-smart-proofread-apply]';
  const PROOFREAD_RETRY_SELECTOR = '[data-smart-proofread-retry]';
  const COMPOSE_SELECTORS = [
    'div[aria-label="Message Body"]',
    'div[aria-label="メッセージ本文"]',
    'div[role="textbox"][contenteditable="true"][aria-label][g_editable="true"]'
  ];
  const COMPOSE_SELECTOR = COMPOSE_SELECTORS.join(', ');

  let activeCompose = null;
  let isRequestInProgress = false;
  let activeRequestId = 0;
  let isLightningInProgress = false;
  let activeLightningRequestId = 0;
  let savedSelection = null;
  let proofreadState = null;
  let isProofreadInProgress = false;
  let activeProofreadRequestId = 0;
  let guidancePersistTimer = null;
  const GUIDANCE_PERSIST_DELAY = 400;

  document.querySelectorAll('.smart-reply__floating-trigger').forEach((el) => {
    el.remove();
  });

  const guidanceState = {
    presets: [],
    selectedIds: new Set(),
  };

  function hideModal() {
    hidePromptPreview();
    void flushGuidancePersist();
    const modal = document.getElementById(MODAL_ID);
    if (modal) {
      modal.remove();
    }
    isRequestInProgress = false;
    if (activeCompose && document.body.contains(activeCompose)) {
      removeCaretMarker(activeCompose);
    }
  }

  function scheduleGuidancePersist() {
    if (guidancePersistTimer) {
      clearTimeout(guidancePersistTimer);
    }
    guidancePersistTimer = setTimeout(() => {
      guidancePersistTimer = null;
      void persistGuidancePresets();
    }, GUIDANCE_PERSIST_DELAY);
  }

  async function flushGuidancePersist() {
    if (guidancePersistTimer) {
      clearTimeout(guidancePersistTimer);
      guidancePersistTimer = null;
      await persistGuidancePresets();
    }
  }

  function normalizeGuidancePreset(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!id || !name) {
      return null;
    }
    return {
      id,
      name,
      content,
      useInLightning: Boolean(raw.useInLightning),
    };
  }

  function handleGuidanceAddClick() {
    const modal = document.getElementById(MODAL_ID);
    const name = prompt('新しい指示プリセットの名前を入力してください。');
    if (!name || !name.trim()) {
      return;
    }
    const preset = {
      id: generateGuidanceId(),
      name: name.trim(),
      content: '',
      useInLightning: false,
    };
    guidanceState.presets = [...guidanceState.presets, preset];
    guidanceState.selectedIds.add(preset.id);
    if (modal) {
      renderGuidancePresets(modal, guidanceState.presets);
      const newlyAdded = modal.querySelector(`.smart-reply__guidance-card[data-id="${preset.id}"] textarea`);
      if (newlyAdded) {
        newlyAdded.focus();
      }
    }
    void persistGuidancePresets();
  }

  function persistGuidancePresets() {
    return new Promise((resolve) => {
      if (!chrome.storage?.sync?.set) {
        resolve();
        return;
      }
      const payload = {
        instructionPresets: { entries: guidanceState.presets },
      };
      chrome.storage.sync.set(payload, () => {
        resolve();
      });
    });
  }

  function generateGuidanceId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `preset-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  async function handlePromptPreviewClick() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    const instructionPresetIds = Array.from(modal.querySelectorAll(`${GUIDANCE_CHECKBOX_SELECTOR}:checked`)).map((cb) => cb.value);
    guidanceState.selectedIds = new Set(instructionPresetIds);

    try {
      await flushGuidancePersist();
      const response = await requestPromptPreview('ja', instructionPresetIds);
      if (!response?.ok) {
        const message = response?.error || 'システムプロンプトを取得できませんでした。';
        window.alert(message);
        return;
      }
      showPromptPreview(response.systemPrompt, response.meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'システムプロンプトを取得できませんでした。';
      window.alert(message);
    }
  }

  function showPromptPreview(systemPrompt, meta = {}) {
    hidePromptPreview();

    const overlay = document.createElement('div');
    overlay.id = PROMPT_PREVIEW_MODAL_ID;
    overlay.className = 'smart-reply__modal-overlay smart-reply__prompt-preview-overlay';
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        hidePromptPreview();
      }
    });

    const dialog = document.createElement('div');
    dialog.className = 'smart-reply__prompt-preview-dialog';

    const header = document.createElement('div');
    header.className = 'smart-reply__prompt-preview-header';
    const title = document.createElement('span');
    title.textContent = '使用するシステムプロンプト';
    header.appendChild(title);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'smart-reply__close';
    closeButton.textContent = '×';
    closeButton.addEventListener('click', hidePromptPreview);
    header.appendChild(closeButton);
    dialog.appendChild(header);

    const metaSection = document.createElement('div');
    metaSection.className = 'smart-reply__prompt-preview-meta';
    const metaList = document.createElement('ul');
    metaList.className = 'smart-reply__prompt-preview-meta-list';

    const languageItem = document.createElement('li');
    languageItem.textContent = `言語: ${meta?.languageLabel || '日本語'}`;
    metaList.appendChild(languageItem);

    const countItem = document.createElement('li');
    countItem.textContent = `返信案の数: ${typeof meta?.count === 'number' ? meta.count : '未設定'}`;
    metaList.appendChild(countItem);

    if (Array.isArray(meta?.instructionPresets) && meta.instructionPresets.length) {
      const presetItem = document.createElement('li');
      const presetDetails = meta.instructionPresets
        .map((preset, index) => `#${index + 1} ${preset?.name || '名称未設定'}`)
        .join(' / ');
      presetItem.textContent = `使用中の指示プリセット: ${presetDetails}`;
      metaList.appendChild(presetItem);
    } else {
      const presetItem = document.createElement('li');
      presetItem.textContent = '使用中の指示プリセット: なし';
      metaList.appendChild(presetItem);
    }

    metaSection.appendChild(metaList);
    dialog.appendChild(metaSection);

    const promptBlock = document.createElement('pre');
    promptBlock.className = 'smart-reply__prompt-preview-text';
    promptBlock.textContent = systemPrompt;
    dialog.appendChild(promptBlock);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function hidePromptPreview() {
    const overlay = document.getElementById(PROMPT_PREVIEW_MODAL_ID);
    if (overlay) {
      overlay.remove();
    }
  }

  function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = MODAL_ID;
      modal.className = 'smart-reply__modal-overlay';
      modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

      const content = document.createElement('div');
      content.className = 'smart-reply__modal-content';

      // Header
      const header = document.createElement('div');
      header.className = 'smart-reply__header';
      header.innerHTML = `<span>Smart Reply（Lightning Reply）</span><button type="button" class="smart-reply__close">×</button>`;
      header.querySelector('.smart-reply__close').addEventListener('click', hideModal);
      content.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'smart-reply__body';

      // Form Section
      const form = document.createElement('div');
      form.className = 'smart-reply__form';
      form.innerHTML = `
        <label class="smart-reply__label">返信のイメージ (任意)</label>
        <textarea class="smart-reply__user-prompt" data-smart-reply-user-prompt placeholder="感謝を伝え、会議の日程を再調整したい旨を伝える / 12/24とかでどうでしょうか？ / 新幹線が遅れているみたいですみません。"></textarea>
      `;
      body.appendChild(form);

      // Style category section
      const guidanceSection = document.createElement('section');
      guidanceSection.className = 'smart-reply__guidance-section';
      guidanceSection.innerHTML = `
        <label class="smart-reply__label">事前指示プリセット (任意)</label>
        <p class="smart-reply__guidance-hint">ここで選んだ指示・例文をもとに、AIが語調や進め方を合わせます。必要に応じてその場で編集や追加もできます。</p>
        <div class="smart-reply__guidance-categories" data-smart-reply-guidance-presets></div>
        <button type="button" class="smart-reply__guidance-add" data-smart-reply-guidance-add>＋指示プリセットを追加</button>
      `;
      const addGuidanceButton = guidanceSection.querySelector(GUIDANCE_ADD_BUTTON_SELECTOR);
      if (addGuidanceButton) {
        addGuidanceButton.addEventListener('click', handleGuidanceAddClick);
      }
      body.appendChild(guidanceSection);

      // Generate Button (sticky footer)
      const generateWrapper = document.createElement('div');
      generateWrapper.className = 'smart-reply__generate-wrapper';

      const promptPreviewButton = document.createElement('button');
      promptPreviewButton.type = 'button';
      promptPreviewButton.className = 'smart-reply__button-secondary smart-reply__prompt-preview-button';
      promptPreviewButton.setAttribute('data-smart-reply-prompt-preview', '');
      promptPreviewButton.textContent = 'プロンプトを確認';
      promptPreviewButton.addEventListener('click', handlePromptPreviewClick);
      generateWrapper.appendChild(promptPreviewButton);

      const generateButton = document.createElement('button');
      generateButton.type = 'button';
      generateButton.className = 'smart-reply__generate-button';
      generateButton.textContent = '返信を作成';
      generateButton.setAttribute('data-smart-reply-generate', '');
      generateButton.addEventListener('click', handleGenerateClick);
      generateWrapper.appendChild(generateButton);

      body.appendChild(generateWrapper);

      // Suggestions
      const suggestionsContainer = document.createElement('div');
      suggestionsContainer.className = 'smart-reply__suggestions-container';
      suggestionsContainer.setAttribute('data-smart-reply-suggestions', '');
      body.appendChild(suggestionsContainer);

      content.appendChild(body);
      modal.appendChild(content);
      document.body.appendChild(modal);
    }

    void loadGuidancePresets(modal);

    return modal;
  }

  function hideProofreadModal() {
    const modal = document.getElementById(PROOFREAD_MODAL_ID);
    if (modal) {
      modal.remove();
    }
    isProofreadInProgress = false;
    activeProofreadRequestId += 1;
    proofreadState = null;
  }

  function ensureProofreadModal() {
    let modal = document.getElementById(PROOFREAD_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = PROOFREAD_MODAL_ID;
    modal.className = 'smart-reply__modal-overlay';
    modal.addEventListener('click', (e) => { if (e.target === modal) hideProofreadModal(); });

    const content = document.createElement('div');
    content.className = 'smart-reply__modal-content';

    const header = document.createElement('div');
    header.className = 'smart-reply__header';
    header.innerHTML = `<span>推敲</span><button type="button" class="smart-reply__close">×</button>`;
    header.querySelector('.smart-reply__close').addEventListener('click', hideProofreadModal);
    content.appendChild(header);

    const body = document.createElement('div');
    body.className = 'smart-reply__body smart-reply__proofread-body';

    const originalSection = document.createElement('div');
    originalSection.className = 'smart-reply__proofread-section';
    originalSection.innerHTML = `
      <label class="smart-reply__label">推敲前のテキスト</label>
      <textarea class="smart-reply__user-prompt smart-reply__proofread-source" data-smart-proofread-source readonly></textarea>
    `;
    body.appendChild(originalSection);

    const resultSection = document.createElement('div');
    resultSection.className = 'smart-reply__proofread-section';
    resultSection.innerHTML = `
      <label class="smart-reply__label">推敲後のテキスト</label>
      <textarea class="smart-reply__user-prompt smart-reply__proofread-result" data-smart-proofread-result readonly></textarea>
      <div class="smart-reply__proofread-status" data-smart-proofread-status></div>
    `;
    body.appendChild(resultSection);

    const actions = document.createElement('div');
    actions.className = 'smart-reply__proofread-actions';
    actions.innerHTML = `
      <button type="button" class="smart-reply__generate-button" data-smart-proofread-apply disabled>取り込み</button>
      <button type="button" class="smart-reply__button-secondary" data-smart-proofread-retry disabled>再推敲</button>
      <button type="button" class="smart-reply__button-secondary" data-smart-proofread-close>閉じる</button>
    `;
    body.appendChild(actions);

    content.appendChild(body);
    modal.appendChild(content);
    document.body.appendChild(modal);

    const applyButton = modal.querySelector(PROOFREAD_APPLY_SELECTOR);
    const retryButton = modal.querySelector(PROOFREAD_RETRY_SELECTOR);
    const closeButton = actions.querySelector('[data-smart-proofread-close]');

    applyButton.addEventListener('click', handleProofreadApply);
    retryButton.addEventListener('click', handleProofreadRetry);
    closeButton.addEventListener('click', hideProofreadModal);

    return modal;
  }

  function cacheSelectionIfInsideCompose() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const compose = findComposeFromNode(selection.anchorNode, { strict: true });
    if (!compose || !document.body.contains(compose)) {
      return;
    }
    storeSelection(compose, range);
  }

  function restoreSelectionForCompose(compose) {
    if (!savedSelection || savedSelection.compose !== compose) {
      return false;
    }
    if (!document.body.contains(compose)) {
      savedSelection = null;
      return false;
    }
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    let range = savedSelection.range;
    if (!isRangeWithinCompose(range, compose)) {
      if (savedSelection.serialized) {
        range = deserializeRange(compose, savedSelection.serialized);
        if (!range) {
          savedSelection = null;
          return false;
        }
      } else {
        savedSelection = null;
        return false;
      }
    }

    const clone = range.cloneRange();
    selection.removeAllRanges();
    selection.addRange(clone);
    storeSelection(compose, clone);
    return true;
  }

  function getElementFromNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
    return null;
  }

  function getSelectionWithinCompose() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return null;
    }
    const compose = findComposeFromNode(range.commonAncestorContainer, { strict: true });
    if (!compose || !document.body.contains(compose)) {
      return null;
    }
    return { compose, range: range.cloneRange() };
  }

  function getCaretSnapshot({ allowCollapsed = false } = {}) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!allowCollapsed && range.collapsed) {
      return null;
    }
    const compose = findComposeFromNode(range.commonAncestorContainer, { strict: true });
    if (!compose || !document.body.contains(compose)) {
      return null;
    }
    return { compose, range: range.cloneRange(), collapsed: range.collapsed };
  }

  function storeSelection(compose, range) {
    if (!compose || !range) {
      return;
    }
    const serialized = serializeRange(range, compose);
    savedSelection = {
      compose,
      range: range.cloneRange(),
      serialized,
    };
  }

  function isRangeWithinCompose(range, compose) {
    if (!range || !compose) {
      return false;
    }
    return isNodeWithin(range.startContainer, compose) && isNodeWithin(range.endContainer, compose);
  }

  function isNodeWithin(node, root) {
    while (node) {
      if (node === root) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  function serializeRange(range, root) {
    const startPath = buildNodePath(range.startContainer, root);
    const endPath = buildNodePath(range.endContainer, root);
    if (!startPath || !endPath) {
      return null;
    }
    return {
      startPath,
      startOffset: range.startOffset,
      endPath,
      endOffset: range.endOffset,
    };
  }

  function deserializeRange(root, serialized) {
    if (!serialized) {
      return null;
    }
    const startNode = traversePath(root, serialized.startPath);
    const endNode = traversePath(root, serialized.endPath);
    if (!startNode || !endNode) {
      return null;
    }
    const range = document.createRange();
    range.setStart(startNode, Math.min(serialized.startOffset, getNodeLength(startNode)));
    range.setEnd(endNode, Math.min(serialized.endOffset, getNodeLength(endNode)));
    return range;
  }

  function buildNodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) {
        return null;
      }
      const index = Array.prototype.indexOf.call(parent.childNodes, current);
      path.unshift(index);
      current = parent;
    }
    if (current !== root) {
      return null;
    }
    return path;
  }

  function traversePath(root, path) {
    let current = root;
    for (const index of path) {
      if (!current || !current.childNodes || index < 0 || index >= current.childNodes.length) {
        return null;
      }
      current = current.childNodes[index];
    }
    return current;
  }

  function getNodeLength(node) {
    if (!node) {
      return 0;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ? node.textContent.length : 0;
    }
    return node.childNodes ? node.childNodes.length : 0;
  }

  function getCurrentInsertionRange(compose) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!isRangeWithinCompose(range, compose)) {
      return null;
    }
    return range.cloneRange();
  }

  function getTextBeforeRange(compose, range, limit = 200) {
    if (!range || !compose.contains(range.startContainer)) {
      return '';
    }
    try {
      const preRange = range.cloneRange();
      preRange.selectNodeContents(compose);
      preRange.setEnd(range.startContainer, range.startOffset);
      const text = preRange.toString();
      return limit ? text.slice(-limit) : text;
    } catch (_error) {
      return '';
    }
  }

  function getTextAfterRange(compose, range, limit = 200) {
    if (!range || !compose.contains(range.endContainer)) {
      return '';
    }
    try {
      const postRange = range.cloneRange();
      postRange.selectNodeContents(compose);
      postRange.setStart(range.endContainer, range.endOffset);
      const text = postRange.toString();
      return limit ? text.slice(0, limit) : text;
    } catch (_error) {
      return '';
    }
  }

  function prepareFormattedSuggestion(text, compose) {
    const range = getCurrentInsertionRange(compose);
    const before = range ? getTextBeforeRange(compose, range, 400) : '';
    const after = range ? getTextAfterRange(compose, range, 400) : '';

    const trimmed = text.trim();
    const normalized = normalizeWhitespacePreservingParagraphs(trimmed);
    let result = applyNaturalLineBreaks(normalized);

    const beforeHasContent = /\S/.test(before);
    if (beforeHasContent) {
      if (before.endsWith('\n\n')) {
        // already separated by a blank line
      } else if (before.endsWith('\n')) {
        result = `\n${result}`;
      } else {
        result = `\n\n${result}`;
      }
    }

    if (!result.endsWith('\n')) {
      result += '\n';
    }

    const afterHasContent = /\S/.test(after);
    if (afterHasContent) {
      if (after.startsWith('\n\n')) {
        // already separated by a blank line
      } else if (after.startsWith('\n')) {
        result += '\n';
      } else {
        result += '\n\n';
      }
    }

    return { content: result, range };
  }

  function applyNaturalLineBreaks(text) {
    if (!text) {
      return text;
    }

    const sentences = splitSentences(text);
    if (!sentences.length) {
      return text;
    }

    return sentences.join('\n');
  }

  function splitSentences(text) {
    const result = [];
    let buffer = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      buffer += char;

      if (/[。！？]/.test(char)) {
        const next = text[i + 1];
        if (!next || !/[。！？、,.\s\n]/.test(next)) {
          result.push(buffer.trim());
          buffer = '';
        }
      } else if (/[.!?]/.test(char)) {
        const next = text[i + 1];
        if (!next || /[A-Z\s\n]/.test(next)) {
          result.push(buffer.trim());
          buffer = '';
        }
      }
      if (char === '\n') {
        result.push(buffer.trim());
        buffer = '';
      }
    }

    if (buffer.trim()) {
      result.push(buffer.trim());
    }

    return result.filter(Boolean);
  }

  function normalizeWhitespacePreservingParagraphs(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00A0\u200B]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function insertCaretMarker(compose, baseRange) {
    if (!compose || !document.body.contains(compose)) {
      return;
    }
    removeCaretMarker(compose);
    const selection = window.getSelection();
    const snapshot = baseRange ? baseRange.cloneRange() : (selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null);
    if (!snapshot) {
      return;
    }
    const marker = document.createElement('span');
    marker.setAttribute('data-smart-reply-caret', '');
    marker.style.display = 'inline-block';
    marker.style.width = '0px';
    marker.style.height = '0px';
    marker.style.lineHeight = '0px';
    marker.appendChild(document.createTextNode('\u200b'));
    snapshot.collapse(true);
    snapshot.insertNode(marker);
    snapshot.setStartAfter(marker);
    snapshot.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(snapshot);
    }
  }

  function removeCaretMarker(root) {
    if (!root) return;
    root.querySelectorAll(CARET_MARKER_SELECTOR).forEach((marker) => {
      const parent = marker.parentNode;
      if (!parent) {
        return;
      }
      if (marker.firstChild && marker.firstChild.nodeValue === '\u200b') {
        marker.firstChild.nodeValue = '';
      }
      parent.removeChild(marker);
    });
  }

  function restoreSelectionFromMarker(compose) {
    if (!compose) {
      return false;
    }
    const marker = compose.querySelector(CARET_MARKER_SELECTOR);
    if (!marker) {
      return false;
    }
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNode(marker);
    range.deleteContents();
    const collapsedRange = document.createRange();
    collapsedRange.setStart(range.startContainer, range.startOffset);
    collapsedRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(collapsedRange);
    storeSelection(compose, collapsedRange);
    return true;
  }

  function replaceRangeWithHtml(range, html, fallbackText) {
    if (!range) {
      return null;
    }
    const selection = window.getSelection();
    let fragment;
    try {
      const template = document.createElement('template');
      template.innerHTML = html;
      fragment = template.content;
    } catch (_error) {
      fragment = null;
    }

    range.deleteContents();

    let endNode;
    if (fragment && fragment.childNodes.length) {
      const clone = fragment.cloneNode(true);
      endNode = clone.lastChild;
      range.insertNode(clone);
    } else {
      const textNode = document.createTextNode(fallbackText);
      range.insertNode(textNode);
      endNode = textNode;
    }

    const collapsed = document.createRange();
    collapsed.setStartAfter(endNode);
    collapsed.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(collapsed);
    }
    return collapsed;
  }

  function convertTextToHtml(text) {
    if (!text) {
      return '';
    }
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.split('\n'));

    const htmlParagraphs = paragraphs.map((lines) => {
      const safeLines = lines.map((line) => escapeHtml(line));
      return `<div>${safeLines.join('<br>')}</div>`;
    });

    return htmlParagraphs.join('');
  }

  function escapeHtml(value) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return value.replace(/[&<>"']/g, (char) => map[char] || char);
  }

  function updateSuggestions({ suggestions = [], language = 'en', status = 'ready', message = '' }) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const container = modal.querySelector(SUGGESTIONS_CONTAINER_SELECTOR);
    if (!container) return;
    container.innerHTML = '';

    if (status === 'loading') {
      container.appendChild(createStatusElement(language === 'ja' ? 'AIが返信案を生成しています…' : 'Generating reply suggestions…', 'muted'));
    } else if (status === 'error') {
      container.appendChild(createStatusElement(message || (language === 'ja' ? '返信案の生成に失敗しました。' : 'Failed to generate suggestions.'), 'error'));
    } else if (status === 'empty' || !suggestions.length) {
      container.appendChild(createStatusElement(message || (language === 'ja' ? '提案できる返信が見つかりませんでした。' : 'No suggestions available yet.'), 'muted'));
    } else {
      suggestions.forEach((suggestion) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'smart-reply__suggestion';
        button.textContent = suggestion;
        button.addEventListener('click', () => {
          insertSuggestion(suggestion);
          hideModal();
        });
        container.appendChild(button);
      });
    }
  }

  function createStatusElement(text, variant) {
    const statusEl = document.createElement('div');
    statusEl.className = 'smart-reply__status';
    if (variant) statusEl.classList.add(`smart-reply__status--${variant}`);
    statusEl.textContent = text;
    return statusEl;
  }

  function insertSuggestion(text) {
    if (!text) return;
    const compose = (activeCompose && document.body.contains(activeCompose)) ? activeCompose : document.querySelector(COMPOSE_SELECTOR);
    if (!compose) return;

    compose.focus({ preventScroll: false });

    const markerRangeApplied = restoreSelectionFromMarker(compose);

    let selection = window.getSelection();
    if (!markerRangeApplied && !restoreSelectionForCompose(compose)) {
      if (selection && selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(compose);
        range.collapse(false);
        selection.addRange(range);
      }
    }

    selection = window.getSelection();

    const { content: contentToInsert, range: referenceRange } = prepareFormattedSuggestion(text, compose);
    const htmlToInsert = convertTextToHtml(contentToInsert);

    let inserted = false;
    if (!markerRangeApplied) {
      try {
        inserted = document.execCommand('insertHTML', false, htmlToInsert);
      } catch (_error) {
        inserted = false;
      }
    }

    if (markerRangeApplied) {
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : referenceRange;
      if (range) {
        replaceRangeWithHtml(range, htmlToInsert, contentToInsert);
        inserted = true;
      }
    } else if (!inserted && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      replaceRangeWithHtml(range, htmlToInsert, contentToInsert);
      inserted = true;
    } else if (!inserted && compose) {
      const fallbackRange = document.createRange();
      fallbackRange.selectNodeContents(compose);
      fallbackRange.collapse(false);
      replaceRangeWithHtml(fallbackRange, htmlToInsert, contentToInsert);
      inserted = true;
    }

    const eventDetail = { bubbles: true, data: contentToInsert, inputType: 'insertText' };
    if (typeof InputEvent === 'function') {
      compose.dispatchEvent(new InputEvent('input', eventDetail));
    } else {
      compose.dispatchEvent(new Event('input', eventDetail));
    }

    removeCaretMarker(compose);
    cacheSelectionIfInsideCompose();
  }

  function insertLightningPlaceholder(compose) {
    if (!compose || !document.body.contains(compose)) {
      return null;
    }

    const markerApplied = restoreSelectionFromMarker(compose);
    let selection = window.getSelection();

    if (!markerApplied) {
      if (!selection || selection.rangeCount === 0) {
        const fallbackRange = document.createRange();
        fallbackRange.selectNodeContents(compose);
        fallbackRange.collapse(false);
        if (!selection) {
          selection = window.getSelection();
        }
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(fallbackRange);
        }
      } else {
        const range = selection.getRangeAt(0);
        if (!isRangeWithinCompose(range, compose)) {
          const fallback = document.createRange();
          fallback.selectNodeContents(compose);
          fallback.collapse(false);
          selection.removeAllRanges();
          selection.addRange(fallback);
        }
      }
    }

    selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);

    const placeholder = document.createElement('span');
    placeholder.setAttribute('data-lightning-placeholder', '');
    placeholder.style.whiteSpace = 'pre-wrap';
    placeholder.textContent = LIGHTNING_PLACEHOLDER_TEXT;

    range.insertNode(placeholder);

    const afterRange = document.createRange();
    afterRange.setStartAfter(placeholder);
    afterRange.collapse(true);

    const updatedSelection = window.getSelection();
    if (updatedSelection) {
      updatedSelection.removeAllRanges();
      updatedSelection.addRange(afterRange);
    }

    storeSelection(compose, afterRange);

    const eventDetail = { bubbles: true, data: LIGHTNING_PLACEHOLDER_TEXT, inputType: 'insertText' };
    if (typeof InputEvent === 'function') {
      compose.dispatchEvent(new InputEvent('input', eventDetail));
    } else {
      compose.dispatchEvent(new Event('input', eventDetail));
    }

    return placeholder;
  }

  function removeLightningPlaceholder(compose, placeholder, { keepCaretMarker = false } = {}) {
    if (!compose || !document.body.contains(compose)) {
      return null;
    }

    const target = placeholder && document.body.contains(placeholder)
      ? placeholder
      : compose.querySelector(LIGHTNING_PLACEHOLDER_SELECTOR);

    if (!target) {
      return null;
    }

    const range = document.createRange();
    range.setStartBefore(target);
    range.setEndAfter(target);
    range.deleteContents();
    range.collapse(true);

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    storeSelection(compose, range);

    if (keepCaretMarker) {
      insertCaretMarker(compose, range);
    }

    const eventDetail = { bubbles: true, data: LIGHTNING_PLACEHOLDER_TEXT, inputType: 'deleteContentBackward' };
    if (typeof InputEvent === 'function') {
      compose.dispatchEvent(new InputEvent('input', eventDetail));
    } else {
      compose.dispatchEvent(new Event('input', eventDetail));
    }

    return range;
  }

  function openSmartReplyModal() {
    let compose = (activeCompose && document.body.contains(activeCompose)) ? activeCompose : null;
    if (!compose) {
      compose = findComposeFromTarget(document.activeElement);
    }
    if (!compose) {
      compose = document.querySelector(COMPOSE_SELECTOR);
    }
    if (!compose) {
      return false;
    }

    const snapshot = getCaretSnapshot({ allowCollapsed: true });
    if (snapshot && snapshot.compose === compose) {
      insertCaretMarker(compose, snapshot.range);
      storeSelection(compose, snapshot.range);
    }

    activeCompose = compose;
    compose.focus({ preventScroll: false });
    if (snapshot && snapshot.compose === compose) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(snapshot.range.cloneRange());
      }
      insertCaretMarker(compose, snapshot.range);
      storeSelection(compose, snapshot.range);
    } else {
      cacheSelectionIfInsideCompose();
      insertCaretMarker(compose);
    }
    ensureModal();
    return true;
  }

  function openProofreadModal(initialText, selectionInfo) {
    if (!selectionInfo || !initialText) {
      return false;
    }

    const { compose, range } = selectionInfo;
    if (!compose || !document.body.contains(compose)) {
      return false;
    }

    activeCompose = compose;
    proofreadState = {
      compose,
      range: range.cloneRange(),
      originalText: initialText,
      resultText: '',
      language: 'ja',
    };

    storeSelection(compose, range);

    compose.focus({ preventScroll: false });
    cacheSelectionIfInsideCompose();

    const modal = ensureProofreadModal();
    const sourceField = modal.querySelector(PROOFREAD_SOURCE_SELECTOR);
    const resultField = modal.querySelector(PROOFREAD_RESULT_SELECTOR);
    if (sourceField) {
      sourceField.value = initialText;
    }
    if (resultField) {
      resultField.value = '';
    }
    updateProofreadModal({ status: 'loading', message: '', language: proofreadState.language });
    startProofread();
    return true;
  }

  function updateProofreadModal({ status, text = '', message = '', language = 'ja' }) {
    const modal = document.getElementById(PROOFREAD_MODAL_ID);
    if (!modal) return;
    const resultField = modal.querySelector(PROOFREAD_RESULT_SELECTOR);
    const statusEl = modal.querySelector(PROOFREAD_STATUS_SELECTOR);
    const applyButton = modal.querySelector(PROOFREAD_APPLY_SELECTOR);
    const retryButton = modal.querySelector(PROOFREAD_RETRY_SELECTOR);

    if (resultField && status !== 'loading') {
      resultField.value = text;
    }

    if (statusEl) {
      if (status === 'loading') {
        statusEl.textContent = language === 'ja' ? 'AIが推敲しています…' : 'Polishing in progress…';
        statusEl.classList.remove('smart-reply__proofread-status--error');
      } else if (status === 'error') {
        statusEl.textContent = message || (language === 'ja' ? '推敲に失敗しました。' : 'Failed to proofread.');
        statusEl.classList.add('smart-reply__proofread-status--error');
      } else {
        statusEl.textContent = '';
        statusEl.classList.remove('smart-reply__proofread-status--error');
      }
    }

    if (applyButton) {
      applyButton.disabled = status !== 'success';
    }

    if (retryButton) {
      retryButton.disabled = status === 'loading';
    }
  }

  async function startProofread() {
    if (!proofreadState || isProofreadInProgress) {
      return;
    }
    const { originalText, language } = proofreadState;
    if (!originalText) {
      updateProofreadModal({ status: 'error', message: '推敲するテキストが選択されていません。', language: 'ja' });
      return;
    }

    proofreadState.resultText = '';
    const modal = document.getElementById(PROOFREAD_MODAL_ID);
    if (modal) {
      const resultField = modal.querySelector(PROOFREAD_RESULT_SELECTOR);
      if (resultField) {
        resultField.value = '';
      }
    }

    isProofreadInProgress = true;
    const requestId = ++activeProofreadRequestId;
    updateProofreadModal({ status: 'loading', language });

    try {
      const response = await requestProofreadSuggestion(originalText, language);
      if (requestId !== activeProofreadRequestId) {
        return;
      }
      const suggestion = typeof response?.suggestion === 'string' ? response.suggestion.trim() : '';
      if (!suggestion) {
        throw new Error('推敲結果が空です。');
      }
      if (!proofreadState) {
        return;
      }
      proofreadState.resultText = suggestion;
      updateProofreadModal({ status: 'success', text: suggestion, language });
    } catch (error) {
      if (requestId !== activeProofreadRequestId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error || '');
      updateProofreadModal({ status: 'error', message, language: proofreadState?.language || 'ja' });
    } finally {
      if (requestId === activeProofreadRequestId) {
        isProofreadInProgress = false;
      }
    }
  }

  function handleProofreadApply() {
    if (!proofreadState || !proofreadState.resultText) {
      return;
    }
    const { compose, range, resultText } = proofreadState;
    if (!compose || !document.body.contains(compose) || !range) {
      hideProofreadModal();
      return;
    }

    compose.focus({ preventScroll: false });

    const replacementRange = range.cloneRange();
    let selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(replacementRange);
    }

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, resultText);
    } catch (_error) {
      inserted = false;
    }

    let finalRange = null;

    if (!inserted) {
      const targetRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : replacementRange;
      targetRange.deleteContents();
      const textNode = document.createTextNode(resultText);
      targetRange.insertNode(textNode);
      targetRange.setStartAfter(textNode);
      targetRange.collapse(true);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(targetRange);
      }
      finalRange = targetRange.cloneRange();
    } else if (selection && selection.rangeCount > 0) {
      finalRange = selection.getRangeAt(0).cloneRange();
    }

    if (finalRange) {
      storeSelection(compose, finalRange);
    }

    const eventDetail = { bubbles: true, data: resultText, inputType: 'insertText' };
    if (typeof InputEvent === 'function') {
      compose.dispatchEvent(new InputEvent('input', eventDetail));
    } else {
      compose.dispatchEvent(new Event('input', eventDetail));
    }

    proofreadState = null;
    cacheSelectionIfInsideCompose();
    hideProofreadModal();
  }

  function handleProofreadRetry() {
    if (!proofreadState || isProofreadInProgress) {
      return;
    }
    startProofread();
  }

  function requestProofreadSuggestion(text, language) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'SMART_PROOFREAD_GENERATE', payload: { text, language } },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '推敲の生成リクエストに失敗しました。'));
          } else if (!response) {
            reject(new Error('AIから推敲結果が受信できませんでした。'));
          } else if (!response.ok) {
            reject(new Error(response.error || '推敲の生成に失敗しました。'));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  async function handleGenerateClick() {
    if (isRequestInProgress) return;

    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    const userInput = modal.querySelector(USER_PROMPT_SELECTOR).value.trim();
    const generateButton = modal.querySelector(GENERATE_BUTTON_SELECTOR);

    const instructionPresetIds = Array.from(modal.querySelectorAll(`${GUIDANCE_CHECKBOX_SELECTOR}:checked`)).map((cb) => cb.value);
    guidanceState.selectedIds = new Set(instructionPresetIds);

    const context = getLatestEmailContext();
    const language = 'ja';
    const requestId = ++activeRequestId;

    await flushGuidancePersist();

    isRequestInProgress = true;
    if (generateButton) generateButton.disabled = true;
    updateSuggestions({ suggestions: [], language, status: 'loading' });

    try {
      const response = await requestAiSuggestions(context, language, userInput, instructionPresetIds);
      if (requestId !== activeRequestId) return;
      const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
      updateSuggestions({ suggestions, language, status: suggestions.length ? 'ready' : 'empty' });
    } catch (error) {
      if (requestId !== activeRequestId) return;
      const message = error instanceof Error ? error.message : String(error || '');
      updateSuggestions({ suggestions: [], language, status: 'error', message });
    } finally {
      isRequestInProgress = false;
      if (generateButton) generateButton.disabled = false;
    }
  }

  async function triggerLightningReply() {
    if (isLightningInProgress) {
      return false;
    }

    let compose = (activeCompose && document.body.contains(activeCompose)) ? activeCompose : null;
    if (!compose) {
      compose = findComposeFromTarget(document.activeElement);
    }
    if (!compose) {
      compose = document.querySelector(COMPOSE_SELECTOR);
    }
    if (!compose) {
      window.alert('Gmailの本文にカーソルを置いてから実行してください。');
      return false;
    }

    activeCompose = compose;
    compose.focus({ preventScroll: false });

    const snapshot = getCaretSnapshot({ allowCollapsed: true });
    if (snapshot && snapshot.compose === compose) {
      insertCaretMarker(compose, snapshot.range);
      storeSelection(compose, snapshot.range);
    } else {
      cacheSelectionIfInsideCompose();
      insertCaretMarker(compose);
    }

    isLightningInProgress = true;
    const requestId = ++activeLightningRequestId;

    const placeholderNode = insertLightningPlaceholder(compose);
    if (!placeholderNode) {
      if (activeLightningRequestId === requestId) {
        isLightningInProgress = false;
      }
      removeCaretMarker(compose);
      window.alert('カーソル位置を特定できませんでした。もう一度お試しください。');
      return false;
    }

    const context = getLatestEmailContext();
    const language = 'ja';

    await flushGuidancePersist();

    let success = false;
    let placeholderRemoved = false;
    try {
      const response = await requestLightningSuggestion(context, language);
      if (!response || requestId !== activeLightningRequestId) {
        removeLightningPlaceholder(compose, placeholderNode, { keepCaretMarker: false });
        placeholderRemoved = true;
        return false;
      }
      const suggestion = typeof response.suggestion === 'string' ? response.suggestion.trim() : '';
      if (!suggestion) {
        throw new Error('AIから返信案を取得できませんでした。');
      }
      removeLightningPlaceholder(compose, placeholderNode, { keepCaretMarker: true });
      placeholderRemoved = true;
      insertSuggestion(suggestion);
      success = true;
      return true;
    } catch (error) {
      if (!placeholderRemoved) {
        removeLightningPlaceholder(compose, placeholderNode, { keepCaretMarker: false });
        placeholderRemoved = true;
      }
      const message = error instanceof Error ? error.message : 'Lightning Reply の生成に失敗しました。';
      window.alert(message);
      return false;
    } finally {
      if (activeLightningRequestId === requestId) {
        isLightningInProgress = false;
      }
      if (!placeholderRemoved && compose && document.body.contains(compose)) {
        removeLightningPlaceholder(compose, placeholderNode, { keepCaretMarker: false });
        placeholderRemoved = true;
      }
      if (!success && compose && document.body.contains(compose)) {
        removeCaretMarker(compose);
        cacheSelectionIfInsideCompose();
      }
    }
  }

  function getLatestEmailContext() {
    const candidates = Array.from(document.querySelectorAll('div.a3s.aiL, div.a3s.aiJ'));
    for (let i = candidates.length - 1; i >= 0; i--) {
      const cloned = candidates[i].cloneNode(true);
      cloned.querySelectorAll('blockquote').forEach(n => n.remove());
      const text = (cloned.innerText || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '';
  }

  function requestAiSuggestions(context, language, userPrompt, instructionPresetIds) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'SMART_REPLY_GENERATE', payload: { context, language, userPrompt, instructionPresetIds } },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'AI返信の生成リクエストに失敗しました。'));
          } else if (!response) {
            reject(new Error('AIからの応答が受信できませんでした。'));
          } else if (!response.ok) {
            reject(new Error(response.error || 'AI返信の生成に失敗しました。'));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  function requestPromptPreview(language, instructionPresetIds) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'SMART_REPLY_PROMPT_PREVIEW', payload: { language, instructionPresetIds } },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'システムプロンプトの取得に失敗しました。'));
          } else if (!response) {
            reject(new Error('バックグラウンドから応答がありませんでした。'));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  async function loadGuidancePresets(modal) {
    if (!modal) return;
    if (!chrome.storage?.sync?.get) {
      renderGuidancePresets(modal, []);
      return;
    }

    const presets = await new Promise((resolve) => {
      chrome.storage.sync.get({ instructionPresets: { entries: [] } }, (result) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }

        const rawPresets = Array.isArray(result?.instructionPresets?.entries)
          ? result.instructionPresets.entries
          : [];
        const normalized = rawPresets
          .map(normalizeGuidancePreset)
          .filter(Boolean);

        resolve(normalized);
      });
    });

    guidanceState.presets = presets;

    const storedSelections = presets
      .filter((preset) => preset.useInLightning)
      .map((preset) => preset.id);
    guidanceState.selectedIds = new Set(storedSelections);

    renderGuidancePresets(modal, presets);
  }

  function renderGuidancePresets(modal, presets) {
    const container = modal.querySelector(GUIDANCE_CONTAINER_SELECTOR);
    if (!container) return;
    container.innerHTML = '';

    if (!presets.length) {
      const empty = document.createElement('p');
      empty.className = 'smart-reply__guidance-empty';
      empty.textContent = 'ポップアップまたはここで指示プリセットを追加すると、AIに共有できます。';
      container.appendChild(empty);
      return;
    }

    presets.forEach((preset) => {
      const item = document.createElement('div');
      item.className = 'smart-reply__guidance-card';
      item.dataset.id = preset.id;

      const header = document.createElement('div');
      header.className = 'smart-reply__guidance-card-header';

      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = 'smart-reply__guidance-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = preset.id;
      checkbox.setAttribute('data-smart-reply-guidance-preset', '');
      const initiallySelected = guidanceState.selectedIds.has(preset.id);
      checkbox.checked = initiallySelected;
      preset.useInLightning = initiallySelected;

      const nameSpan = document.createElement('span');
      const lightningStatus = document.createElement('span');
      lightningStatus.className = 'smart-reply__guidance-lightning-indicator';
      lightningStatus.textContent = initiallySelected ? '（Lightning Reply にも使用されます）' : '';

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          guidanceState.selectedIds.add(preset.id);
          preset.useInLightning = true;
        } else {
          guidanceState.selectedIds.delete(preset.id);
          preset.useInLightning = false;
        }
        lightningStatus.textContent = checkbox.checked ? '（Lightning Reply にも使用されます）' : '';
        void persistGuidancePresets();
      });
      checkboxLabel.appendChild(checkbox);

      nameSpan.textContent = preset.name;
      checkboxLabel.appendChild(nameSpan);
      checkboxLabel.appendChild(lightningStatus);
      header.appendChild(checkboxLabel);

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'smart-reply__guidance-delete';
      deleteButton.textContent = '削除';
      deleteButton.addEventListener('click', () => {
        const confirmation = window.confirm(`「${preset.name}」を削除しますか？`);
        if (!confirmation) {
          return;
        }
        guidanceState.presets = guidanceState.presets.filter((entry) => entry.id !== preset.id);
        guidanceState.selectedIds.delete(preset.id);
        void persistGuidancePresets().then(() => {
          renderGuidancePresets(modal, guidanceState.presets);
        });
      });
      header.appendChild(deleteButton);

      item.appendChild(header);

      const textarea = document.createElement('textarea');
      textarea.className = 'smart-reply__guidance-textarea';
      textarea.placeholder = '（まだ内容が設定されていません）';
      textarea.value = preset.content;
      textarea.rows = 8;
      textarea.addEventListener('input', (event) => {
        const value = typeof event.target.value === 'string' ? event.target.value : '';
        preset.content = value;
        scheduleGuidancePersist();
      });
      textarea.addEventListener('blur', () => {
        void flushGuidancePersist();
      });
      item.appendChild(textarea);

      container.appendChild(item);
    });

  }

  function requestLightningSuggestion(context, language) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      const lightningInstructionIds = Array.from(guidanceState.selectedIds);
      chrome.runtime.sendMessage(
        { type: 'LIGHTNING_REPLY_GENERATE', payload: { context, language, instructionPresetIds: lightningInstructionIds } },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Lightning Reply の生成リクエストに失敗しました。'));
          } else if (!response) {
            reject(new Error('AIからの応答が受信できませんでした。'));
          } else if (!response.ok) {
            reject(new Error(response.error || 'Lightning Reply の生成に失敗しました。'));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  function findComposeFromTarget(target) {
    return findComposeFromNode(target, { strict: false });
  }

  function findComposeFromNode(node, { strict } = { strict: false }) {
    if (!node) {
      return strict ? null : document.querySelector(COMPOSE_SELECTOR);
    }
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element) {
      return strict ? null : document.querySelector(COMPOSE_SELECTOR);
    }
    const compose = element.closest(COMPOSE_SELECTOR);
    if (compose) {
      return compose;
    }
    return strict ? null : document.querySelector(COMPOSE_SELECTOR);
  }

  document.addEventListener('focusin', (event) => {
    const compose = findComposeFromTarget(event.target);
    if (compose) {
      activeCompose = compose;
      cacheSelectionIfInsideCompose();
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || target.closest(`#${MODAL_ID}`) || target.closest(`#${PROOFREAD_MODAL_ID}`)) {
      return;
    }
    const compose = findComposeFromTarget(target);
    if (compose) {
      activeCompose = compose;
    }
  });

  document.addEventListener('contextmenu', (event) => {
    const compose = findComposeFromTarget(event.target);
    if (!compose) {
      return;
    }
    activeCompose = compose;
    const snapshot = getCaretSnapshot({ allowCollapsed: true });
    if (snapshot && snapshot.compose === compose) {
      storeSelection(compose, snapshot.range);
    }
  });

  const observer = new MutationObserver(() => {
    if (activeCompose && !document.body.contains(activeCompose)) {
      activeCompose = null;
      hideModal();
      hideProofreadModal();
      savedSelection = null;
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SMART_REPLY_LIGHTNING_EXECUTE') {
      (async () => {
        const ok = await triggerLightningReply();
        if (typeof sendResponse === 'function') {
          sendResponse({ ok });
        }
      })();
      return true;
    }

    if (message?.type === 'SMART_REPLY_OPEN_MODAL') {
      const opened = openSmartReplyModal();
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: opened });
      }
      return;
    }

    if (message?.type === 'SMART_PROOFREAD_OPEN_MODAL') {
      const selectionInfo = getSelectionWithinCompose();
      const selectionText = selectionInfo ? selectionInfo.range.toString() : '';
      const fallbackText = (message?.payload?.text || '').trim();
      const textToProofread = selectionText || fallbackText;

      if (!selectionInfo || !textToProofread) {
        window.alert('Gmailの本文から推敲したいテキストを選択してから実行してください。');
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: false, error: 'NO_SELECTION' });
        }
        return;
      }

      const opened = openProofreadModal(textToProofread, selectionInfo);
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: opened });
      }
    }
  });

  document.addEventListener('selectionchange', () => {
    cacheSelectionIfInsideCompose();
  });
})();
