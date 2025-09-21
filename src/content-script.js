(function () {
  if (window.hasRunSmartReplyExtension) {
    return;
  }
  window.hasRunSmartReplyExtension = true;

  const MODAL_ID = 'smart-reply-extension-modal';
  const SUGGESTIONS_CONTAINER_SELECTOR = '[data-smart-reply-suggestions]';
  const USER_PROMPT_SELECTOR = '[data-smart-reply-user-prompt]';
  const TONE_CHECKBOX_SELECTOR = '[data-smart-reply-tone]';
  const OTHER_TONE_INPUT_SELECTOR = '[data-smart-reply-other-tone-input]';
  const OTHER_TONE_CHECKBOX_SELECTOR = '[data-smart-reply-other-tone-checkbox]';
  const GENERATE_BUTTON_SELECTOR = '[data-smart-reply-generate]';
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

  document.querySelectorAll('.smart-reply__floating-trigger').forEach((el) => {
    el.remove();
  });

  const TONE_OPTIONS = {
    '丁寧な': 'polite',
    'フォーマルな': 'formal',
    'カジュアルな': 'casual',
    '熱意のある': 'enthusiastic',
    '謙虚な': 'humble',
    '直接的な': 'direct',
  };

  function hideModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) {
      modal.remove();
    }
    isRequestInProgress = false;
    if (activeCompose && document.body.contains(activeCompose)) {
      removeCaretMarker(activeCompose);
    }
  }

  function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'smart-reply__modal-overlay';
    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

    const content = document.createElement('div');
    content.className = 'smart-reply__modal-content';

    // Header
    const header = document.createElement('div');
    header.className = 'smart-reply__header';
    header.innerHTML = `<span>Smart Reply</span><button type="button" class="smart-reply__close">×</button>`;
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

    // Tone Section
    const toneSection = document.createElement('fieldset');
    toneSection.className = 'smart-reply__tone-section';
    toneSection.innerHTML = `<legend class="smart-reply__label">文章の雰囲気は？ (任意、複数選択可)</legend>`;
    const toneCheckboxes = document.createElement('div');
    toneCheckboxes.className = 'smart-reply__tone-checkboxes';

    for (const [label, value] of Object.entries(TONE_OPTIONS)) {
      toneCheckboxes.innerHTML += `
        <div class="smart-reply__checkbox-wrapper">
          <input type="checkbox" id="tone-${value}" data-smart-reply-tone value="${label}">
          <label for="tone-${value}">${label}</label>
        </div>
      `;
    }

    toneCheckboxes.innerHTML += `
      <div class="smart-reply__checkbox-wrapper">
        <input type="checkbox" id="tone-other" data-smart-reply-other-tone-checkbox>
        <label for="tone-other">その他</label>
        <input type="text" class="smart-reply__other-tone-input" data-smart-reply-other-tone-input disabled placeholder="具体的な雰囲気を入力">
      </div>
    `;
    toneSection.appendChild(toneCheckboxes);
    body.appendChild(toneSection);

    // Generate Button
    const generateButton = document.createElement('button');
    generateButton.type = 'button';
    generateButton.className = 'smart-reply__generate-button';
    generateButton.textContent = '返信を作成';
    generateButton.setAttribute('data-smart-reply-generate', '');
    generateButton.addEventListener('click', handleGenerateClick);
    body.appendChild(generateButton);

    // Suggestions
    const suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'smart-reply__suggestions-container';
    suggestionsContainer.setAttribute('data-smart-reply-suggestions', '');
    body.appendChild(suggestionsContainer);

    content.appendChild(body);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Event listener for 'Other' checkbox
    const otherCheckbox = modal.querySelector(OTHER_TONE_CHECKBOX_SELECTOR);
    const otherInput = modal.querySelector(OTHER_TONE_INPUT_SELECTOR);
    otherCheckbox.addEventListener('change', () => {
      otherInput.disabled = !otherCheckbox.checked;
      if (!otherCheckbox.checked) otherInput.value = '';
    });

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
      language: detectLanguage(initialText),
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

    const tones = Array.from(modal.querySelectorAll(`${TONE_CHECKBOX_SELECTOR}:checked`)).map(cb => cb.value);
    const otherToneCheckbox = modal.querySelector(OTHER_TONE_CHECKBOX_SELECTOR);
    if (otherToneCheckbox?.checked) {
      const otherToneValue = modal.querySelector(OTHER_TONE_INPUT_SELECTOR).value.trim();
      if (otherToneValue) tones.push(otherToneValue);
    }

    const context = getLatestEmailContext();
    const language = detectLanguage(context + userInput);
    const requestId = ++activeRequestId;

    isRequestInProgress = true;
    if (generateButton) generateButton.disabled = true;
    updateSuggestions({ suggestions: [], language, status: 'loading' });

    try {
      const response = await requestAiSuggestions(context, language, userInput, tones);
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
    const composePreview = (compose.innerText || '').trim();
    const language = detectLanguage(`${context}\n${composePreview}`.trim());

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

  function detectLanguage(text) {
    if (!text) return 'en';
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text) ? 'ja' : 'en';
  }

  function requestAiSuggestions(context, language, userPrompt, tones) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'SMART_REPLY_GENERATE', payload: { context, language, userPrompt, tones } },
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

  function requestLightningSuggestion(context, language) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'LIGHTNING_REPLY_GENERATE', payload: { context, language } },
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
