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
  const TRIGGER_ID = 'smart-reply-extension-trigger';
  const COMPOSE_SELECTORS = [
    'div[aria-label="Message Body"]',
    'div[aria-label="メッセージ本文"]',
    'div[role="textbox"][contenteditable="true"][aria-label][g_editable="true"]'
  ];
  const COMPOSE_SELECTOR = COMPOSE_SELECTORS.join(', ');

  let activeCompose = null;
  let isRequestInProgress = false;
  let activeRequestId = 0;
  let savedSelection = null;

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
      <textarea class="smart-reply__user-prompt" data-smart-reply-user-prompt placeholder="感謝を伝え、会議の日程を再調整したい旨を伝える"></textarea>
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

  function cacheSelectionIfInsideCompose() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const anchorElement = getElementFromNode(selection.anchorNode);
    const compose = findComposeFromNode(anchorElement, { strict: true });
    if (!compose || !document.body.contains(compose)) {
      return;
    }
    savedSelection = { compose, range: range.cloneRange() };
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
    const range = savedSelection.range.cloneRange();
    selection.removeAllRanges();
    selection.addRange(range);
    savedSelection = { compose, range: range.cloneRange() };
    return true;
  }

  function getElementFromNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
    return null;
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

    let selection = window.getSelection();
    if (!restoreSelectionForCompose(compose)) {
      if (selection && selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(compose);
        range.collapse(false);
        selection.addRange(range);
      }
    }

    selection = window.getSelection();

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (_error) {
      inserted = false;
    }

    if (!inserted && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (!inserted && compose) {
      compose.appendChild(document.createTextNode(text));
    }

    const eventDetail = { bubbles: true, data: text, inputType: 'insertText' };
    if (typeof InputEvent === 'function') {
      compose.dispatchEvent(new InputEvent('input', eventDetail));
    } else {
      compose.dispatchEvent(new Event('input', eventDetail));
    }

    cacheSelectionIfInsideCompose();
  }

  function ensureTrigger() {
    let trigger = document.getElementById(TRIGGER_ID);
    if (!trigger) {
      trigger = document.createElement('button');
      trigger.id = TRIGGER_ID;
      trigger.type = 'button';
      trigger.className = 'smart-reply__floating-trigger';
      trigger.setAttribute('aria-label', 'Smart Reply');
      const icon = document.createElement('span');
      icon.className = 'smart-reply__floating-trigger-icon';
      icon.textContent = 'AI';
      const label = document.createElement('span');
      label.className = 'smart-reply__floating-trigger-label';
      label.textContent = 'Smart Reply';
      trigger.appendChild(icon);
      trigger.appendChild(label);
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const compose = (activeCompose && document.body.contains(activeCompose)) ? activeCompose : findComposeFromTarget(document.activeElement);
        if (!compose) return;
        activeCompose = compose;
        handleTriggerClick();
      });
      trigger.setAttribute('hidden', 'true');
      document.body.appendChild(trigger);
    }
    return trigger;
  }

  function updateTriggerForCompose(compose) {
    if (!compose || !document.body.contains(compose)) {
      hideTrigger();
      return;
    }
    const trigger = ensureTrigger();
    const rect = compose.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
      trigger.setAttribute('hidden', 'true');
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const triggerWidth = triggerRect.width || 120;
    const triggerHeight = triggerRect.height || 44;
    const gap = 12;
    const left = Math.min(Math.max(rect.right - triggerWidth - gap, gap), window.innerWidth - triggerWidth - gap);
    const top = Math.min(Math.max(rect.bottom - triggerHeight - gap, gap), window.innerHeight - triggerHeight - gap);
    trigger.style.left = `${left}px`;
    trigger.style.top = `${top}px`;
    trigger.removeAttribute('hidden');
  }

  function hideTrigger() {
    const trigger = document.getElementById(TRIGGER_ID);
    if (trigger) trigger.setAttribute('hidden', 'true');
  }

  function handleTriggerClick() {
    cacheSelectionIfInsideCompose();
    ensureModal();
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
      updateTriggerForCompose(compose);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || target.closest(`#${TRIGGER_ID}`) || target.closest(`#${MODAL_ID}`)) {
      return;
    }
    const compose = findComposeFromTarget(target);
    if (compose) {
      activeCompose = compose;
      updateTriggerForCompose(compose);
    } else {
      hideTrigger();
    }
  });

  const observer = new MutationObserver(() => {
    if (activeCompose && !document.body.contains(activeCompose)) {
      activeCompose = null;
      hideTrigger();
      hideModal();
      savedSelection = null;
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('selectionchange', () => {
    cacheSelectionIfInsideCompose();
  });
})();
