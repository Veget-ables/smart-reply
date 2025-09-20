const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_SUGGESTION_COUNT = 3;
const CONTEXT_MENU_ROOT_ID = 'smart-reply-root';
const CONTEXT_MENU_SMART_REPLY_ID = 'smart-reply-generate';
const CONTEXT_MENU_PROOFREAD_ID = 'smart-proofread-context';

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
          const { context = '', language = 'en', userPrompt = '', tones = [] } = message.payload || {};
          const suggestions = await generateSuggestionsFromAi(context, language, userPrompt, tones);
          sendResponse({ ok: true, suggestions, language });
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

  const messageTarget = info.menuItemId === CONTEXT_MENU_SMART_REPLY_ID
    ? 'SMART_REPLY_OPEN_MODAL'
    : info.menuItemId === CONTEXT_MENU_PROOFREAD_ID
      ? 'SMART_PROOFREAD_OPEN_MODAL'
      : null;

  if (!messageTarget) {
    return;
  }

  if (messageTarget === 'SMART_REPLY_OPEN_MODAL') {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'SMART_REPLY_OPEN_MODAL' }, options, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Ignore failures (e.g., tab navigated away).
    }
    return;
  }

  if (messageTarget === 'SMART_PROOFREAD_OPEN_MODAL') {
    try {
      const payload = {
        type: 'SMART_PROOFREAD_OPEN_MODAL',
        payload: { text: info.selectionText || '' },
      };
      chrome.tabs.sendMessage(tab.id, payload, options, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Ignore failures (e.g., tab navigated away).
    }
  }
});

async function generateSuggestionsFromAi(rawContext, language, userIntent, tones) {
  const { apiKey, apiModel, apiEndpoint, suggestionCount } = await storageGet(Object.keys(STORAGE_DEFAULTS));

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。拡張機能のポップアップから設定してください。');
  }

  const endpoint = apiEndpoint || DEFAULT_ENDPOINT;
  const count = Math.max(1, Math.min(Number(suggestionCount) || DEFAULT_SUGGESTION_COUNT, 5));

  const context = (rawContext || '').trim();
  const truncatedContext = context.length > 15000 ? `${context.slice(0, 15000)}...` : context;
  const languageLabel = language === 'ja' ? 'Japanese' : 'English';

  const systemPromptParts = [
    `You are an assistant that drafts professional ${languageLabel} email replies.`, 
    'Your output MUST be a valid JSON array of strings. Do not include any other text or markdown formatting. For example: ["Thank you.", "I will check it."]', 
    `Provide ${count} distinct reply options. Each reply must be 1-3 sentences and ready to send.`, 
    'Avoid placeholders like [NAME]; keep a polite, helpful tone.', 
    'Format each reply so that every sentence starts on a new line. Insert a blank line between the greeting, body, and closing (e.g., "こんにちは\n\nご連絡ありがとうございます。\n追加情報をご教示ください。\n\nよろしくお願いいたします。"). Do not return a single-line paragraph.', 
  ];

  if (tones && tones.length > 0) {
    systemPromptParts.push(`The user has requested the following tone(s): ${tones.join(', ')}. Please adhere to these tones.`);
  }

  const systemPrompt = systemPromptParts.join(' ');

  let userPrompt;
  const baseContext = truncatedContext
    ? `The latest email thread is below:\n\n${truncatedContext}`
    : 'There is no email context.';

  if (userIntent) {
    userPrompt = `A user wants to reply to an email with the following intent: "${userIntent}".\n\n${baseContext}\n\nBased on the user's intent and the email thread, craft ${count} professional ${languageLabel} reply options.`
  } else {
    userPrompt = `${baseContext}\n\nCraft ${count} professional ${languageLabel} reply options that address the email thread.`
  }

  const maxOutputTokens = 4000;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: "OK, I will provide the suggestions in a JSON array." }] },
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
      id: CONTEXT_MENU_PROOFREAD_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: '選択テキストを推敲',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
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

  const languageLabel = language === 'ja' ? 'Japanese' : 'English';

  const systemPrompt = [
    'You are a professional business writing editor and proofreader.',
    'Polish the provided text so it reads naturally, remains faithful to the original intent, and aligns with modern business etiquette.',
    'Return only the revised text without extra commentary or quotation marks.',
  ].join(' ');

  const userPrompt = [
    `Language: ${languageLabel}.`,
    'Revise the following text accordingly.',
    '---',
    trimmed,
    '---',
  ].join('\n');

  const maxOutputTokens = 4000;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Understood. I will return only the polished text.' }] },
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
