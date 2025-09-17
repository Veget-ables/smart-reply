(function () {
  if (window.hasRunSmartReplyExtension) {
    return;
  }
  window.hasRunSmartReplyExtension = true;

  const PANEL_ID = 'smart-reply-extension-panel';
  const PANEL_BODY_SELECTOR = '[data-smart-reply-body]';
  const COMPOSE_SELECTOR = 'div[aria-label="Message Body"]';

  let activeCompose = null;
  let refreshTimer = null;

  const debounceRefresh = (delay = 200) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(refreshSuggestions, delay);
  };

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
      close.addEventListener('click', () => {
        panel.setAttribute('hidden', 'true');
      });
      header.appendChild(close);

      const body = document.createElement('div');
      body.className = 'smart-reply__body';
      body.setAttribute('data-smart-reply-body', '');

      panel.appendChild(header);
      panel.appendChild(body);
      document.body.appendChild(panel);
    }
    return panel;
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.setAttribute('hidden', 'true');
    }
  }

  function updatePanel({ suggestions, language }) {
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

    if (!suggestions.length) {
      const empty = document.createElement('div');
      empty.className = 'smart-reply__empty';
      empty.textContent = language === 'ja'
        ? '提案できる返信が見つかりませんでした。'
        : 'No suggestions available yet.';
      body.appendChild(empty);
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
    if (selection && selection.rangeCount > 0) {
      selection.deleteFromDocument();
    }
    document.execCommand('insertText', false, text);
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

  function generateSuggestions(context) {
    const language = detectLanguage(context);
    const suggestions = [];
    const add = (enText, jaText) => {
      const text = language === 'ja' && jaText ? jaText : enText;
      if (text && !suggestions.includes(text)) {
        suggestions.push(text);
      }
    };

    const normalized = (context || '').toLowerCase();

    if (!context) {
      add(
        'Thanks for reaching out. I will review the details and follow up shortly.',
        'ご連絡ありがとうございます。内容を確認のうえ、改めてご連絡いたします。'
      );
      add(
        'Let me know if there is any additional context I should be aware of.',
        'ほかに共有いただける情報があればお知らせください。'
      );
      return { suggestions, language };
    }

    add(
      'Thanks for the update. I will review everything and get back to you soon.',
      'ご連絡ありがとうございます。内容を確認し、追ってご連絡いたします。'
    );

    const hasQuestion = /\?|\uff1f/.test(context) || /\u304b[\s　]*$/m.test(context);
    if (hasQuestion) {
      add(
        'Thanks for the question! I will investigate and share an update shortly. Does that timeline work for you?',
        'ご質問ありがとうございます。こちらで確認し、近日中に状況をご連絡いたします。少々お待ちいただけますでしょうか。'
      );
    }

    const meetingKeywords = /(meeting|meet|schedule|call|calendar|打ち合わせ|ミーティング|面談)/i;
    if (meetingKeywords.test(context)) {
      add(
        'Happy to set up a meeting—please share a few time slots that work for you and I will send an invite.',
        '打ち合わせの件、承知しました。ご都合の良い候補日時をお知らせいただければ、こちらで招待をお送りします。'
      );
    }

    const gratitudeKeywords = /(thank you|thanks|appreciate|ありがとう|感謝)/i;
    if (gratitudeKeywords.test(context)) {
      add(
        'Glad to help! Let me know if there is anything else you need.',
        'お役に立てて何よりです。ほかにも必要なことがあれば遠慮なくお知らせください。'
      );
    }

    const deadlineKeywords = /(deadline|due|asap|soon as possible|いつまで|納期|締め切り)/i;
    if (deadlineKeywords.test(context)) {
      add(
        'I understand the timeline. I will confirm feasibility and update you later today.',
        'スケジュール了解しました。対応可否を確認し、本日中に改めてご連絡いたします。'
      );
    }

    const attachmentKeywords = /(attachment|attached|document|資料|添付)/i;
    if (attachmentKeywords.test(context)) {
      add(
        'Thanks for sending the materials. I will review them and follow up if I have any questions.',
        '資料のご送付ありがとうございます。内容を確認し、不明点があれば改めてご連絡いたします。'
      );
    }

    if (suggestions.length < 3) {
      add(
        'I will prepare the necessary details and circle back with you tomorrow.',
        '必要事項を整理し、明日中に改めてご連絡いたします。'
      );
    }

    if (suggestions.length < 3) {
      add(
        'Does that plan align with your expectations? Happy to adjust if needed.',
        'こちらの進め方で問題ないかご確認いただけますでしょうか。ご要望があれば調整いたします。'
      );
    }

    return { suggestions, language };
  }

  function refreshSuggestions() {
    if (!activeCompose || !document.body.contains(activeCompose)) {
      hidePanel();
      return;
    }
    const context = getLatestEmailContext();
    const result = generateSuggestions(context);
    updatePanel(result);
  }

  document.addEventListener('focusin', (event) => {
    const compose = event.target.closest(COMPOSE_SELECTOR);
    if (compose) {
      activeCompose = compose;
      debounceRefresh(100);
    }
  });

  document.addEventListener('click', (event) => {
    const compose = event.target.closest(COMPOSE_SELECTOR);
    if (compose) {
      activeCompose = compose;
      debounceRefresh(150);
    }
  });

  const observer = new MutationObserver(() => {
    if (!activeCompose || !document.body.contains(activeCompose)) {
      return;
    }
    debounceRefresh(300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
