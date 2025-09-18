const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const DEFAULT_SUGGESTION_COUNT = 3;

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
      const { context = '', language = 'en' } = message.payload || {};
      const suggestions = await generateSuggestionsFromAi(context, language);
      sendResponse({ ok: true, suggestions, language });
    } catch (error) {
      const fallbackMessage = error instanceof Error ? error.message : 'AIリクエストで不明なエラーが発生しました。';
      sendResponse({ ok: false, error: fallbackMessage });
    }
  })();

  return true;
});

async function generateSuggestionsFromAi(rawContext, language) {
  const { apiKey, apiModel, apiEndpoint, suggestionCount } = await storageGet(Object.keys(STORAGE_DEFAULTS));

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。拡張機能のポップアップから設定してください。');
  }

  const endpoint = apiEndpoint || DEFAULT_ENDPOINT;
  const model = apiModel || DEFAULT_MODEL;
  const count = Math.max(1, Math.min(Number(suggestionCount) || DEFAULT_SUGGESTION_COUNT, 5));

  const context = (rawContext || '').trim();
  const truncatedContext = context.length > 5000 ? `${context.slice(0, 5000)}...` : context;
  const languageLabel = language === 'ja' ? 'Japanese' : 'English';

  const systemPrompt = [
    `You are an assistant that drafts professional ${languageLabel} email replies.`,
    'Always return a valid JSON array of strings. Do not include any other text.',
    `Provide ${count} distinct reply options. Each reply must be 1-3 sentences and ready to send.`,
    'Avoid placeholders like [NAME]; keep a polite, helpful tone.',
  ].join(' ');

  const userPrompt = truncatedContext
    ? `The latest email thread is below. Craft ${count} ${languageLabel} reply options that address it.\n\n${truncatedContext}`
    : `There is no email context. Provide ${count} polite ${languageLabel} acknowledgment replies.`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 512,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new Error(`AIリクエストに失敗しました (${response.status}). ${deriveErrorMessage(errorText)}`);
  }

  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  const suggestions = parseSuggestions(content);

  if (!suggestions.length) {
    throw new Error('AIから有効な返信案を取得できませんでした。');
  }

  return suggestions;
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

  return trimmed
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\d\.\)]\s*/, '').trim())
    .filter(Boolean);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}
