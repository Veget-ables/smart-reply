const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_SUGGESTION_COUNT = 3;
const MAX_INSTRUCTION_PRESETS = 4;
const INSTRUCTION_CHAR_LIMIT = 1200;
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

function buildSystemInstruction({ languageLabel, count, instructionPresets }) {
  const resolvedLanguageLabel = '日本語';
  const resolvedCount = Math.max(1, Math.min(Number.isFinite(Number(count)) ? Number(count) : DEFAULT_SUGGESTION_COUNT, 5));
  const instructionBlocks = [
    `あなたは${resolvedLanguageLabel}でビジネスメールの返信案を作成するアシスタントです。`,
    '<<Objectives>>\n- 現在進行中のメールスレッドを理解し、送信者に代わって自然で即送信可能な返信案を用意します。\n- 返信案は状況説明・対応方針・次のアクションを明確にし、やり取りの流れを寸断しないようにしてください。',
    `<<Output Format>>\n- JSON配列として${resolvedCount}件の文字列を返してください。余計なテキストやMarkdownは含めません。\n- 各文字列は挨拶・本題・締めを改行で区切り、挨拶と本文、本文と締めの間に空行を入れてください。`,
    '<<Tone & Quality>>\n- 受信者がプロフェッショナルかつ思いやりのある印象を受ける文体を維持してください。\n- 宛名プレースホルダーやテンプレート感の強い表現は避け、メール内容に即した固有情報を織り込みます。',
    '<<Custom Instructions>>\n- ユーザーが登録した指示・返信例を読み込み、それらの意図やトーンを最優先で反映します。\n- 他のルールと衝突する場合も、ユーザー指示を損なわない範囲で文章を調整してください。'
  ];

  if (instructionPresets.length > 0) {
    const criticalLines = instructionPresets
      .map((example, index) => `指示${index + 1}: ${example.name || '名称未設定のプリセット'}`)
      .join('\n');
    instructionBlocks.push('<<Critical Requirements>>\n- 以下の指示プリセットに含まれる要素・語尾・口調・キーワードはすべて同時に満たしてください。\n- どれか一つでも抜けたり希薄化したりしないよう文章を調整し、指示同士が矛盾する場合は両立する表現を工夫してください。\n- 各指示ごとに固有の語彙やトーンを文中で明確に反映させてください。');
    instructionBlocks.push(criticalLines);

    const serialized = instructionPresets
      .map((example, index) => {
        const name = example.name || `プリセット${index + 1}`;
        const contentBody = example.content ? example.content : '（内容が設定されていません）';
        return `[#${index + 1} ${name}]\n${contentBody}`;
      })
      .join('\n\n');
    instructionBlocks.push('<<Guidance Library>>\n- 以下の指示・参考テキストを熟読し、語尾・語彙・句読点・改行リズム・絵文字などの癖、ならびに明示された意図を可能な限り反映してください。\n- 例文を丸写しせず、現在のメール内容に合わせた新しい文章に落とし込んでください。');
    instructionBlocks.push(serialized);
  } else {
    instructionBlocks.push('<<Guidance Library>>\n- 登録された指示はありません。丁寧で誠実なビジネス口調を保ちつつ、メール文脈から適切な対応案を導いてください。');
  }

  instructionBlocks.push('<<Process>>\n- スレッドから相手の要望・懸念・締め切りを抽出し、それぞれに明確に応答してください。\n- 必要に応じて謝意・謝罪・次のアクションを盛り込み、自然な会話フローに仕上げてください。\n- 返信案ごとに視点を少し変え（長さ、フォーカス、語調の微差など）、利用者が選びやすいバリエーションを提供してください。');

  instructionBlocks.push('<<Do Not>>\n- 事実と異なる約束や確認済みでない情報を断定しない。\n- 箇条書きの代わりに会話文のみを返さない。\n- JSON配列以外の出力をしない。');

  return instructionBlocks.join('\n\n');
}

function buildUserPrompt({ languageLabel, count, truncatedContext, userIntent, instructionPresets }) {
  const sections = [];

  if (truncatedContext) {
    sections.push(`【メールスレッド抜粋】\n${truncatedContext}`);
  } else {
    sections.push('【メールスレッド抜粋】\n提供されていません。');
  }

  if (userIntent) {
    sections.push(`【返信の狙い】\n${userIntent}`);
  }

  if (Array.isArray(instructionPresets) && instructionPresets.length > 0) {
    const summary = instructionPresets
      .map((preset, index) => {
        const name = preset.name || `プリセット${index + 1}`;
        return `${index + 1}. ${name}`;
      })
      .join('\n');
    sections.push(`【必ず反映する指示プリセット】\n${summary}\n\n上記すべての指示を同時に満たしてください。`);
  }

  sections.push(`【生成タスク】\n- 上記内容を踏まえ、${languageLabel}で${count}件の返信案を示してください。\n- 各案は送信者視点で書き、受信者が次に取るべきアクションが明瞭になるようにしてください。\n- 返信案ごとに微妙なニュアンスや提案内容を変え、利用者が状況に最適なものを選べるようにしてください。`);

  return sections.join('\n\n');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  switch (message.type) {
    case 'SMART_REPLY_GENERATE': {
      (async () => {
        try {
          const {
            context = '',
            userPrompt = '',
            instructionPresetIds = [],
          } = message.payload || {};
          const suggestions = await generateSuggestionsFromAi(context, 'ja', userPrompt, { instructionPresetIds });
          sendResponse({ ok: true, suggestions, language: 'ja' });
        } catch (error) {
          const fallbackMessage = error instanceof Error ? error.message : 'AIリクエストで不明なエラーが発生しました。';
          sendResponse({ ok: false, error: fallbackMessage });
    }
      })();
      return true;
    }
    case 'SMART_REPLY_PROMPT_PREVIEW': {
      (async () => {
        try {
          const { instructionPresetIds = [] } = message.payload || {};
          const { suggestionCount } = await storageGet(['suggestionCount']);
          const numericCount = Number(suggestionCount);
          const resolvedCount = Math.max(1, Math.min(Number.isFinite(numericCount) ? numericCount : DEFAULT_SUGGESTION_COUNT, 5));
          const languageLabel = '日本語';
          const instructionPresets = instructionPresetIds.length ? await resolveInstructionPresets(instructionPresetIds) : [];
          const systemPrompt = buildSystemInstruction({ languageLabel, count: resolvedCount, instructionPresets });
          sendResponse({ ok: true, systemPrompt, meta: { languageLabel, count: resolvedCount, instructionPresets } });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'システムプロンプトの取得に失敗しました。';
          sendResponse({ ok: false, error: messageText });
        }
      })();
      return true;
    }
    case 'LIGHTNING_REPLY_GENERATE': {
      (async () => {
        try {
          const payload = message.payload || {};
          const context = typeof payload.context === 'string' ? payload.context : '';
          const hasExplicit = Object.prototype.hasOwnProperty.call(payload, 'instructionPresetIds');
          const selectedIds = Array.isArray(payload.instructionPresetIds)
            ? payload.instructionPresetIds.filter((id) => typeof id === 'string' && id)
            : [];
          const instructionPresetIds = hasExplicit ? selectedIds : await resolveLightningInstructionPresetIds();
          const suggestions = await generateSuggestionsFromAi(context, 'ja', '', { suggestionCountOverride: 1, instructionPresetIds });
          const suggestion = Array.isArray(suggestions) ? suggestions[0] || '' : '';
          if (!suggestion) {
            throw new Error('AIから有効な返信案を取得できませんでした。');
          }
          sendResponse({ ok: true, suggestion, language: 'ja' });
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
  const languageLabel = '日本語';
  const instructionPresetIds = Array.isArray(options?.instructionPresetIds) ? options.instructionPresetIds : [];
  const instructionPresets = instructionPresetIds.length ? await resolveInstructionPresets(instructionPresetIds) : [];

  const systemPrompt = buildSystemInstruction({ languageLabel, count, instructionPresets });
  const userPrompt = buildUserPrompt({ languageLabel, count, truncatedContext, userIntent, instructionPresets });

  const maxOutputTokens = 12000;
  const body = {
    system_instruction: {
      role: 'system',
      parts: [{ text: systemPrompt }],
    },
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.2,
      maxOutputTokens,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60-second timeout

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

function getStoredInstructionPresets() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ instructionPresets: { entries: [] } }, (result) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }

      const rawPresets = Array.isArray(result?.instructionPresets?.entries)
        ? result.instructionPresets.entries
        : [];
      const normalized = rawPresets
        .map(normalizeInstructionPreset)
        .filter(Boolean);

      resolve(normalized);
    });
  });
}

function normalizeInstructionPreset(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const content = typeof item.content === 'string' ? item.content.trim() : '';

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    content,
    useInLightning: Boolean(item.useInLightning),
  };
}

async function resolveInstructionPresets(requestedIds) {
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    return [];
  }

  const presets = await getStoredInstructionPresets();
  if (!presets.length) {
    return [];
  }

  const uniqueIds = Array.from(new Set(requestedIds.filter((id) => typeof id === 'string' && id)));
  if (!uniqueIds.length) {
    return [];
  }

  const selected = [];
  for (const id of uniqueIds) {
    const match = presets.find((preset) => preset.id === id);
    if (match) {
      selected.push({
        id: match.id,
        name: match.name,
        content: truncateInstructionContent(match.content, INSTRUCTION_CHAR_LIMIT),
      });
    }
    if (selected.length >= MAX_INSTRUCTION_PRESETS) {
      break;
    }
  }

  return selected;
}

function truncateInstructionContent(content, limit) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    return '';
  }
  if (limit && text.length > limit) {
    return `${text.slice(0, limit)}…`;
  }
  return text;
}

async function resolveLightningInstructionPresetIds() {
  const presets = await getStoredInstructionPresets();
  if (!presets.length) {
    return [];
  }
  const prioritized = presets.filter((preset) => preset.useInLightning);
  const source = prioritized.length ? prioritized : presets;
  return source.slice(0, MAX_INSTRUCTION_PRESETS).map((preset) => preset.id);
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
      title: 'Smart Reply（マニュアル）',
      contexts: ['editable'],
    }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_LIGHTNING_REPLY_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: 'Smart Reply（オート）',
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

  const languageLabel = '日本語';

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
  const timeoutId = setTimeout(() => controller.abort(), 60000);

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
