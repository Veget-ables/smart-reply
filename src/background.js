const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_SUGGESTION_COUNT = 3;
const MAX_STYLE_EXAMPLES = 4;
const STYLE_EXAMPLE_CHAR_LIMIT = 1200;
const CONTEXT_MENU_ROOT_ID = 'smart-reply-root';
const CONTEXT_MENU_SMART_REPLY_ID = 'smart-reply-generate';
const CONTEXT_MENU_PROOFREAD_ID = 'smart-proofread-context';
const CONTEXT_MENU_LIGHTNING_REPLY_ID = 'smart-reply-lightning';
const COMMAND_OPEN_SMART_REPLY = 'open-smart-reply';
const COMMAND_OPEN_SMART_PROOFREAD = 'open-smart-proofread';
const COMMAND_TRIGGER_LIGHTNING_REPLY = 'trigger-lightning-reply';

const STORAGE_DEFAULTS = {
  apiKey: '',
  apiModel: DEFAULT_MODEL,
  apiEndpoint: DEFAULT_ENDPOINT,
  suggestionCount: DEFAULT_SUGGESTION_COUNT,
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ ...STORAGE_DEFAULTS });
        return;
      }
      resolve({ ...STORAGE_DEFAULTS, ...result });
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  switch (message.type) {
    case 'SMART_REPLY_GENERATE': {
      (async () => {
        try {
          const { context = '', language = 'en', userPrompt = '', styleCategoryIds = [] } = message.payload || {};
          const suggestions = await generateSuggestionsFromAi(context, language, userPrompt, { styleCategoryIds });
          sendResponse({ ok: true, suggestions, language });
        } catch (error) {
          const fallbackMessage = error instanceof Error ? error.message : 'AIリクエストで不明なエラーが発生しました。';
          sendResponse({ ok: false, error: fallbackMessage });
        }
      })();
      return true;
    }
    case 'LIGHTNING_REPLY_GENERATE': {
      (async () => {
        try {
          const { context = '', language = 'en' } = message.payload || {};
          const suggestions = await generateSuggestionsFromAi(context, language, '', { suggestionCountOverride: 1 });
          const suggestion = Array.isArray(suggestions) ? suggestions[0] || '' : '';
          if (!suggestion) {
            throw new Error('AIから有効な返信案を取得できませんでした。');
          }
          sendResponse({ ok: true, suggestion, language });
        } catch (error) {
          const fallbackMessage = error instanceof Error ? error.message : 'AIリクエストで不明なエラーが発生しました。';
          sendResponse({ ok: false, error: fallbackMessage });
        }
      })();
      return true;
    }
    case 'SMART_PROOFREAD_GENERATE': {
      (async () => {
        try {
          const { text = '', language = 'ja' } = message.payload || {};
          const suggestion = await generateProofreadFromAi(text, language);
          sendResponse({ ok: true, suggestion, language });
        } catch (error) {
          const fallbackMessage = error instanceof Error ? error.message : '推敲リクエストで不明なエラーが発生しました。';
          sendResponse({ ok: false, error: fallbackMessage });
        }
      })();
      return true;
    }
    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }

  const options = {};
  if (typeof info.frameId === 'number' && info.frameId >= 0) {
    options.frameId = info.frameId;
  }

  let message = null;

  switch (info.menuItemId) {
    case CONTEXT_MENU_SMART_REPLY_ID:
      message = { type: 'SMART_REPLY_OPEN_MODAL' };
      break;
    case CONTEXT_MENU_PROOFREAD_ID:
      message = {
        type: 'SMART_PROOFREAD_OPEN_MODAL',
        payload: { text: info.selectionText || '' },
      };
      break;
    case CONTEXT_MENU_LIGHTNING_REPLY_ID:
      message = { type: 'SMART_REPLY_LIGHTNING_EXECUTE' };
      break;
    default:
      break;
  }

  if (!message) {
    return;
  }

  try {
    chrome.tabs.sendMessage(tab.id, message, options, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore failures (e.g., tab navigated away).
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === COMMAND_OPEN_SMART_REPLY) {
    void dispatchShortcutToActiveTab('SMART_REPLY_OPEN_MODAL');
    return;
  }

  if (command === COMMAND_OPEN_SMART_PROOFREAD) {
    void dispatchShortcutToActiveTab('SMART_PROOFREAD_OPEN_MODAL');
    return;
  }

  if (command === COMMAND_TRIGGER_LIGHTNING_REPLY) {
    void dispatchShortcutToActiveTab('SMART_REPLY_LIGHTNING_EXECUTE');
  }
});

async function generateSuggestionsFromAi(rawContext, language, userIntent, options = {}) {
  const { apiKey, apiModel, apiEndpoint, suggestionCount } = await storageGet(Object.keys(STORAGE_DEFAULTS));

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。拡張機能のポップアップから設定してください。');
  }

  const endpoint = apiEndpoint || DEFAULT_ENDPOINT;
  const override = options && typeof options.suggestionCountOverride !== 'undefined'
    ? Number(options.suggestionCountOverride)
    : null;
  const resolved = override === null || Number.isNaN(override)
    ? Number(suggestionCount)
    : override;
  const count = Math.max(1, Math.min(Number.isFinite(resolved) ? resolved : DEFAULT_SUGGESTION_COUNT, 5));

  const context = (rawContext || '').trim();
  const truncatedContext = context.length > 15000 ? `${context.slice(0, 15000)}...` : context;
  const languageLabel = language === 'ja' ? '日本語' : '英語';
  const styleCategoryIds = Array.isArray(options?.styleCategoryIds) ? options.styleCategoryIds : [];
  const styleExamples = styleCategoryIds.length ? await resolveStyleExamples(styleCategoryIds) : [];

  const systemPromptParts = [
    `${languageLabel}でビジネス向けのメール返信案を作成するアシスタントです。`,
    '出力は文字列のみを要素に持つJSON配列にしてください。余計なテキストやMarkdownは含めないでください。例: ["ありがとうございます。", "確認いたします。"]',
    `返信案は${count}件用意し、それぞれ即送信できる完成形にしてください。必要に応じて文量を調整し、冗長にならないよう配慮してください。`,
    '宛名などのプレースホルダー（例: [NAME]）は使用せず、丁寧で前向きな語調を保ってください。',
    '各文は改行で区切り、挨拶・本文・締めの間には空行を挟んでください（例: "こんにちは\n\nご連絡ありがとうございます。\n追加情報をご教示ください。\n\nよろしくお願いいたします。")。一段落でまとめないでください。',
  ];

  if (styleExamples.length > 0) {
    const serialized = styleExamples
      .map((example) => `【${example.name}】\n${example.content}`)
      .join('\n\n――――――――\n\n');
    systemPromptParts.push('以下は利用者が登録した返信例です。語調や言い回しを参考にしつつ、現在のメール内容に合わせて新しい返信を作成してください。例文をそのまま転記せず、要点を踏まえて調整してください。');
    systemPromptParts.push(serialized);
  }

  const systemPrompt = systemPromptParts.join('\n\n');

  let userPrompt;
  const baseContext = truncatedContext
    ? `最新のメールスレッドを以下に示します:\n\n${truncatedContext}`
    : 'メールスレッドは提供されていません。';

  if (userIntent) {
    userPrompt = `利用者は次の意図で返信したいと考えています: "${userIntent}"。\n\n${baseContext}\n\nこの意図とメール内容を踏まえて、${languageLabel}で${count}件のビジネス向け返信案を作成してください。`
  } else {
    userPrompt = `${baseContext}\n\nこの内容を踏まえて、${languageLabel}で${count}件のビジネス向け返信案を作成してください。`
  }

  const maxOutputTokens = 12000;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: '了解しました。返信案はJSON配列で返します。' }] },
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.4,
      maxOutputTokens,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);
      throw new Error(`AIリクエストに失敗しました (${response.status}). ${deriveErrorMessage(errorText)}`);
    }

    const data = await response.json().catch(() => null);
    const candidate = data?.candidates?.[0];

    if (!candidate) {
      throw new Error('AIから応答が返ってきませんでした。しばらくしてから再試行してください。');
    }

    const candidateIssue = evaluateCandidateIssue(candidate, {
      maxOutputTokens,
      activityLabel: '返信案',
    });
    if (candidateIssue) {
      throw new Error(candidateIssue);
    }

    const content = candidate?.content?.parts?.[0]?.text;
    const suggestions = parseSuggestions(content);

    if (!suggestions.length) {
      throw new Error('AIから有効な返信案を取得できませんでした。');
    }

    return suggestions;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AIへのリクエストがタイムアウトしました (30秒)。');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getStoredStyleCategories() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ styleExamples: { categories: [] } }, (result) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      const raw = result?.styleExamples?.categories;
      if (!Array.isArray(raw)) {
        resolve([]);
        return;
      }
      const normalized = raw
        .map((item) => {
          const id = typeof item?.id === 'string' ? item.id : '';
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          const content = typeof item?.content === 'string' ? item.content.trim() : '';
          if (!id || !name || !content) {
            return null;
          }
          return { id, name, content };
        })
        .filter(Boolean);
      resolve(normalized);
    });
  });
}

async function resolveStyleExamples(requestedIds) {
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    return [];
  }
  const categories = await getStoredStyleCategories();
  if (!categories.length) {
    return [];
  }

  const uniqueIds = Array.from(new Set(requestedIds.filter((id) => typeof id === 'string' && id)));
  if (!uniqueIds.length) {
    return [];
  }

  const selected = [];
  for (const id of uniqueIds) {
    const match = categories.find((category) => category.id === id);
    if (match) {
      selected.push({
        id: match.id,
        name: match.name,
        content: truncateStyleContent(match.content, STYLE_EXAMPLE_CHAR_LIMIT),
      });
    }
    if (selected.length >= MAX_STYLE_EXAMPLES) {
      break;
    }
  }
  return selected.filter((item) => item.content);
}

function truncateStyleContent(content, limit) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    return '';
  }
  if (limit && text.length > limit) {
    return `${text.slice(0, limit)}…`;
  }
  return text;
}

function setupContextMenu() {
  if (!chrome.contextMenus) {
    return;
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ROOT_ID,
      title: 'Smart Reply for Gmail',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SMART_REPLY_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: 'Smart Reply を生成',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_LIGHTNING_REPLY_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: 'Lightning Reply を挿入',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PROOFREAD_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: '選択テキストを推敲',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

async function dispatchShortcutToActiveTab(messageType) {
  const tab = await queryActiveGmailTab();
  if (!tab?.id) {
    return;
  }

  let message;

  switch (messageType) {
    case 'SMART_PROOFREAD_OPEN_MODAL':
      message = { type: messageType, payload: { text: '' } };
      break;
    case 'SMART_REPLY_OPEN_MODAL':
    case 'SMART_REPLY_LIGHTNING_EXECUTE':
      message = { type: messageType };
      break;
    default:
      message = { type: messageType };
      break;
  }

  await sendMessageToTab(tab.id, message);
}

function queryActiveGmailTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      const gmailTab = tabs.find((candidate) => {
        const url = candidate?.url || '';
        return typeof url === 'string' && url.startsWith('https://mail.google.com/');
      });

      resolve(gmailTab || null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_error) {
      resolve();
    }
  });
}

async function generateProofreadFromAi(originalText, language) {
  const { apiKey, apiModel, apiEndpoint } = await storageGet(Object.keys(STORAGE_DEFAULTS));

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。拡張機能のポップアップから設定してください。');
  }

  const endpoint = apiEndpoint || DEFAULT_ENDPOINT;
  const trimmed = (originalText || '').trim();
  if (!trimmed) {
    throw new Error('推敲するテキストが空です。');
  }

  const languageLabel = language === 'ja' ? '日本語' : '英語';

  const systemPrompt = [
    'あなたはビジネス文書の編集と校正を専門とするアシスタントです。',
    '提供された文章を自然で意図に忠実な表現へ整え、現代的なビジネスマナーに合わせてください。',
    '出力は校正済みの本文のみとし、追加のコメントや引用符は入れないでください。',
  ].join(' ');

  const userPrompt = [
    `対象言語: ${languageLabel}。`,
    '次の文章を上記方針に従って校正してください。',
    '---',
    trimmed,
    '---',
  ].join('\n');

  const maxOutputTokens = 4000;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: '了解しました。校正済みの本文のみを返します。' }] },
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      response_mime_type: 'text/plain',
      temperature: 0.2,
      maxOutputTokens,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);
      throw new Error(`AIリクエストに失敗しました (${response.status}). ${deriveErrorMessage(errorText)}`);
    }

    const data = await response.json().catch(() => null);
    const candidate = data?.candidates?.[0];

    if (!candidate) {
      throw new Error('AIから推敲結果が返ってきませんでした。選択範囲を確認して再試行してください。');
    }

    const candidateIssue = evaluateCandidateIssue(candidate, {
      maxOutputTokens,
      activityLabel: '推敲結果',
    });
    if (candidateIssue) {
      throw new Error(candidateIssue);
    }

    const content = candidate?.content?.parts?.[0]?.text;
    const suggestion = typeof content === 'string' ? content.trim() : '';

    if (!suggestion) {
      throw new Error('推敲結果を取得できませんでした。');
    }

    return suggestion;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AIへのリクエストがタイムアウトしました (30秒)。');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return '';
  }
}

function deriveErrorMessage(text) {
  if (!text) {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
    if (parsed?.message) {
      return parsed.message;
    }
  } catch (_error) {
    // Ignore JSON parse failures and fall back to raw text snippet.
  }
  return text.slice(0, 200);
}

function parseSuggestions(rawContent) {
  if (!rawContent) {
    return [];
  }

  const trimmed = rawContent.trim();
  const jsonParsed = tryParseJson(trimmed);
  if (Array.isArray(jsonParsed)) {
    return jsonParsed
      .map((entry) => (typeof entry === 'string' ? entry : String(entry || '')))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (jsonParsed?.suggestions && Array.isArray(jsonParsed.suggestions)) {
    return jsonParsed.suggestions
      .map((entry) => (typeof entry === 'string' ? entry : String(entry || '')))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  // Fallback for non-JSON or malformed JSON responses
  const cleaned = trimmed.replace(/```json|```/g, '').trim();
  const lines = cleaned.split(/\n+/);
  return lines
    .map((line) => {
      try {
        // Try to parse each line as a JSON array/object
        const parsedLine = JSON.parse(line);
        if (Array.isArray(parsedLine)) {
          return parsedLine;
        }
      } catch (e) {
        // Not a JSON line, treat as plain text
      }
      // Cleanup for list-like formats
      return line.replace(/^["\s\-d.\[\]]*/, '').replace(/["\\]\s*$/, '').trim();
    })
    .flat()
    .filter(Boolean);
}

function evaluateCandidateIssue(candidate, { maxOutputTokens, activityLabel } = {}) {
  if (!candidate) {
    return null;
  }

  const blockedRatings = Array.isArray(candidate.safetyRatings)
    ? candidate.safetyRatings.filter((rating) => rating?.blocked)
    : [];
  if (blockedRatings.length) {
    const categories = blockedRatings
      .map((rating) => formatSafetyCategory(rating?.category))
      .filter(Boolean)
      .join(', ');
    const detail = categories ? ` (${categories})` : '';
    return `AIが安全性の基準により内容をブロックしました${detail}。表現を穏やかにするか内容を見直してください。`;
  }

  switch (candidate.finishReason) {
    case 'MAX_TOKENS': {
      const label = activityLabel || '出力';
      const limit = typeof maxOutputTokens === 'number' ? ` (maxOutputTokens: ${maxOutputTokens})` : '';
      return `AIの${label}がトークン上限${limit}に達しました。対象テキストを短くするか分割して再試行してください。`;
    }
    case 'SAFETY':
      return 'AIが安全性の理由で回答を停止しました。内容を見直してから再試行してください。';
    case 'RECITATION':
      return 'AIが著作権保護などの理由で出力を抑止しました。入力内容を調整して再試行してください。';
    default:
      return null;
  }
}

function formatSafetyCategory(category) {
  if (!category) return '';
  switch (category) {
    case 'HARM_CATEGORY_HATE_SPEECH':
      return 'ヘイトスピーチ';
    case 'HARM_CATEGORY_SEXUAL_CONTENT':
      return '性的コンテンツ';
    case 'HARM_CATEGORY_HARASSMENT_ABUSE':
      return 'ハラスメント/暴力';
    case 'HARM_CATEGORY_DANGEROUS_CONTENT':
      return '危険行為';
    case 'HARM_CATEGORY_MEDICAL':
      return '医療情報';
    case 'HARM_CATEGORY_FINANCIAL':
      return '金融情報';
    case 'HARM_CATEGORY_POLITICAL':
      return '政治的コンテンツ';
    default:
      return String(category);
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    // Fallback for content that might be wrapped in ```json ... ```
    const match = /```json\n(.*?)\n```/s.exec(text);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}
