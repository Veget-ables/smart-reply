const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_SUGGESTION_COUNT = 3;
const CONTEXT_MENU_ID = 'smart-reply-context';

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
  if (message?.type !== 'SMART_REPLY_GENERATE') {
    return false;
  }

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
});

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }
  try {
    const options = {};
    if (typeof info.frameId === 'number' && info.frameId >= 0) {
      options.frameId = info.frameId;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'SMART_REPLY_OPEN_MODAL' }, options, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore failures (e.g., tab navigated away).
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
    'Within each reply, add natural paragraph breaks (e.g., greeting, body, closing) using newline characters so the email reads with clear spacing.', 
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

  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: "OK, I will provide the suggestions in a JSON array." }] },
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.4,
      maxOutputTokens: 2048,
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
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
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
      id: CONTEXT_MENU_ID,
      title: 'Smart Reply を生成',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
  });
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
