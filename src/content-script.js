(function () {
  if (window.hasRunSmartReplyExtension) {
    return;
  }
  window.hasRunSmartReplyExtension = true;

  const PANEL_ID = 'smart-reply-extension-panel';
  const PANEL_BODY_SELECTOR = '[data-smart-reply-body]';
  const TRIGGER_ID = 'smart-reply-extension-trigger';
  const COMPOSE_SELECTORS = [
    'div[aria-label="Message Body"]',
    'div[aria-label="メッセージ本文"]',
    'div[role="textbox"][contenteditable="true"][aria-label][g_editable="true"]'
  ];
  const COMPOSE_SELECTOR = COMPOSE_SELECTORS.join(', ');
  const PANEL_MARGIN = 16;

  let activeCompose = null;
  let activeTrigger = null;
  let activeRequestId = 0;

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.setAttribute('hidden', 'true');
    }
    if (activeTrigger) {
      setTriggerLoading(activeTrigger, false);
    }
    activeRequestId += 1;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;

      const header = document.createElement('div');
      header.className = 'smart-reply__header';

      const title = document.createElement('span');
      title.textContent = 'Smart Reply';
      header.appendChild(title);

      const close = document.createElement('button');
      close.className = 'smart-reply__close';
      close.type = 'button';
      close.textContent = '×';
      close.addEventListener('click', hidePanel);
      header.appendChild(close);

      const body = document.createElement('div');
      body.className = 'smart-reply__body';
      body.setAttribute('data-smart-reply-body', '');

      panel.appendChild(header);
      panel.appendChild(body);
      panel.setAttribute('hidden', 'true');
      document.body.appendChild(panel);
    }
    return panel;
  }

  function updatePanel({
    suggestions = [],
    language = 'en',
    status = 'ready',
    message = '',
  }) {
    const panel = ensurePanel();
    const body = panel.querySelector(PANEL_BODY_SELECTOR);
    if (!body) {
      return;
    }
    body.innerHTML = '';

    const composeAvailable = Boolean(activeCompose && document.body.contains(activeCompose));
    if (!composeAvailable) {
      panel.setAttribute('hidden', 'true');
      return;
    }

    if (status === 'loading') {
      body.appendChild(createStatusElement(
        language === 'ja'
          ? 'AIが返信案を生成しています…'
          : 'Generating reply suggestions…',
        'muted'
      ));
    } else if (status === 'error') {
      body.appendChild(createStatusElement(
        message || (language === 'ja' ? '返信案の生成に失敗しました。' : 'Failed to generate suggestions.'),
        'error'
      ));
    } else if (status === 'empty' || !suggestions.length) {
      body.appendChild(createStatusElement(
        message || (language === 'ja'
          ? '提案できる返信が見つかりませんでした。'
          : 'No suggestions available yet.'),
        'muted'
      ));
    } else {
      suggestions.forEach((suggestion) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'smart-reply__suggestion';
        button.textContent = suggestion;
        button.addEventListener('click', () => {
          insertSuggestion(suggestion);
        });
        body.appendChild(button);
      });
    }

    panel.removeAttribute('hidden');
  }

  function createStatusElement(text, variant) {
    const statusEl = document.createElement('div');
    statusEl.className = 'smart-reply__status';
    if (variant) {
      statusEl.classList.add(`smart-reply__status--${variant}`);
    }
    statusEl.textContent = text;
    return statusEl;
  }

  function insertSuggestion(text) {
    if (!text) {
      return;
    }
    const target = (activeCompose && document.body.contains(activeCompose))
      ? activeCompose
      : document.querySelector(COMPOSE_SELECTOR);

    if (!target) {
      return;
    }

    target.focus({ preventScroll: false });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      const existing = target.textContent || '';
      const needsSpace = existing && !(/[\s\u00a0]$/).test(existing);
      if (needsSpace) {
        target.appendChild(document.createTextNode(' '));
      }
      target.appendChild(document.createTextNode(text));
    }

    const eventDetail = { bubbles: true };
    if (typeof InputEvent === 'function') {
      target.dispatchEvent(new InputEvent('input', { ...eventDetail, data: text, inputType: 'insertText' }));
    } else {
      target.dispatchEvent(new Event('input', eventDetail));
    }
  }

  function ensureTrigger() {
    let trigger = document.getElementById(TRIGGER_ID);
    if (!trigger) {
      trigger = document.createElement('button');
      trigger.id = TRIGGER_ID;
      trigger.type = 'button';
      trigger.className = 'smart-reply__floating-trigger';
      trigger.setAttribute('aria-label', 'Smart Reply');
      trigger.setAttribute('data-smart-reply-trigger', '');
      const icon = document.createElement('span');
      icon.className = 'smart-reply__floating-trigger-icon';
      icon.textContent = 'AI';

      const label = document.createElement('span');
      label.className = 'smart-reply__floating-trigger-label';
      label.textContent = 'Smart Reply';

      trigger.appendChild(icon);
      trigger.appendChild(label);
      trigger.dataset.defaultLabel = 'Smart Reply';
      trigger.dataset.loadingLabel = 'Generating…';
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const compose = (activeCompose && document.body.contains(activeCompose))
          ? activeCompose
          : trigger.__smartReplyCompose || findComposeFromTarget(document.activeElement);
        if (!compose) {
          return;
        }
        activeCompose = compose;
        activeTrigger = trigger;
        handleTriggerClick(compose, trigger);
      });
      trigger.setAttribute('hidden', 'true');
      document.body.appendChild(trigger);
    }
    return trigger;
  }

  function setTriggerLoading(trigger, loading) {
    if (!trigger) {
      return;
    }
    trigger.disabled = loading;
    trigger.classList.toggle('smart-reply__trigger--loading', loading);
    const label = trigger.querySelector('.smart-reply__floating-trigger-label');
    if (label) {
      label.textContent = loading
        ? (trigger.dataset.loadingLabel || 'Generating…')
        : (trigger.dataset.defaultLabel || 'Smart Reply');
    }
  }

  function updateTriggerForCompose(compose) {
    if (!compose || !document.body.contains(compose)) {
      hideTrigger();
      return null;
    }
    const trigger = ensureTrigger();
    trigger.__smartReplyCompose = compose;

    const rect = compose.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
      trigger.setAttribute('hidden', 'true');
      if (activeTrigger === trigger) {
        activeTrigger = null;
      }
      return null;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const triggerWidth = triggerRect.width || 120;
    const triggerHeight = triggerRect.height || 44;
    const gap = 12;

    const left = Math.min(
      Math.max(rect.right - triggerWidth - gap, gap),
      window.innerWidth - triggerWidth - gap
    );
    const top = Math.min(
      Math.max(rect.bottom - triggerHeight - gap, gap),
      window.innerHeight - triggerHeight - gap
    );

    trigger.style.left = `${left}px`;
    trigger.style.top = `${top}px`;
    trigger.removeAttribute('hidden');
    activeTrigger = trigger;
    return trigger;
  }

  function hideTrigger() {
    const trigger = document.getElementById(TRIGGER_ID);
    if (trigger) {
      trigger.setAttribute('hidden', 'true');
      trigger.disabled = false;
      trigger.classList.remove('smart-reply__trigger--loading');
      const label = trigger.querySelector('.smart-reply__floating-trigger-label');
      if (label) {
        label.textContent = trigger.dataset.defaultLabel || 'Smart Reply';
      }
    }
    activeTrigger = null;
  }

  async function handleTriggerClick(compose, trigger) {
    const context = getLatestEmailContext();
    const language = detectLanguage(context);
    const requestId = ++activeRequestId;

    updateTriggerForCompose(compose);
    setTriggerLoading(trigger, true);
    updatePanel({ suggestions: [], language, status: 'loading' });
    positionPanel(trigger);

    try {
      const response = await requestAiSuggestions(context, language);
      if (requestId !== activeRequestId) {
        return;
      }
      const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
      if (!suggestions.length) {
        updatePanel({ suggestions: [], language, status: 'empty' });
      } else {
        updatePanel({ suggestions, language, status: 'ready' });
      }
      positionPanel(trigger);
    } catch (error) {
      if (requestId !== activeRequestId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error || '');
      updatePanel({ suggestions: [], language, status: 'error', message });
      positionPanel(trigger);
    } finally {
      setTriggerLoading(trigger, false);
    }
  }

  function positionPanel(trigger) {
    const panel = ensurePanel();
    if (!panel || !trigger || !document.body.contains(trigger)) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return;
    }

    const width = panel.offsetWidth || 280;
    const height = panel.offsetHeight || 220;

    const preferredLeft = rect.left + rect.width - width;
    const left = Math.min(
      Math.max(preferredLeft, PANEL_MARGIN),
      window.innerWidth - width - PANEL_MARGIN
    );

    let top = rect.top - height - 12;
    if (top < PANEL_MARGIN) {
      top = Math.min(rect.bottom + 12, window.innerHeight - height - PANEL_MARGIN);
    }

    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.removeAttribute('hidden');
  }

  function getLatestEmailContext() {
    const candidates = Array.from(document.querySelectorAll('div.a3s.aiL, div.a3s.aiJ'));
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      const cloned = candidate.cloneNode(true);
      cloned.querySelectorAll('blockquote').forEach((node) => node.remove());
      const text = (cloned.innerText || '').replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    }
    return '';
  }

  function detectLanguage(text) {
    if (!text) {
      return 'en';
    }
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text) ? 'ja' : 'en';
  }

  function requestAiSuggestions(context, language) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('拡張機能へのメッセージ送信がサポートされていません。'));
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: 'SMART_REPLY_GENERATE',
          payload: { context, language },
        },
        (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || 'AI返信の生成リクエストに失敗しました。'));
            return;
          }
          if (!response) {
            reject(new Error('AIからの応答が受信できませんでした。'));
            return;
          }
          if (!response.ok) {
            reject(new Error(response.error || 'AI返信の生成に失敗しました。'));
            return;
          }
          resolve(response);
        }
      );
    });
  }

  function findComposeFromTarget(target) {
    if (!target) {
      return null;
    }
    if (typeof target.closest === 'function') {
      const compose = target.closest(COMPOSE_SELECTOR);
      if (compose) {
        return compose;
      }
    }

    return document.querySelector(COMPOSE_SELECTOR);
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
    if (!target) {
      return;
    }

    const trigger = target.closest(`#${TRIGGER_ID}`);
    if (trigger) {
      return;
    }

    const panel = target.closest(`#${PANEL_ID}`);
    if (panel) {
      return;
    }

    const compose = findComposeFromTarget(target);
    if (compose) {
      activeCompose = compose;
      updateTriggerForCompose(compose);
      return;
    }

    hidePanel();
  });

  function repositionUi() {
    if (activeCompose && document.body.contains(activeCompose)) {
      updateTriggerForCompose(activeCompose);
    } else {
      hideTrigger();
    }

    const panel = document.getElementById(PANEL_ID);
    if (panel && !panel.hasAttribute('hidden')) {
      if (activeTrigger && document.body.contains(activeTrigger)) {
        positionPanel(activeTrigger);
      } else {
        hidePanel();
      }
    }
  }

  window.addEventListener('scroll', repositionUi, true);
  window.addEventListener('resize', repositionUi);

  const observer = new MutationObserver(() => {
    if (activeCompose && !document.body.contains(activeCompose)) {
      activeCompose = null;
      hideTrigger();
      hidePanel();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
