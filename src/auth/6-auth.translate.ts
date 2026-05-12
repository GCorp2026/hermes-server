import { db } from '../db';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

type TranslateKey = { id: string; text: string; hash?: string };

type TranslateResult = { parsed: Record<string, string>; status: number };

const LANG_NAME: Record<string, string> = { en: 'English', zh: 'Simplified Chinese', tr: 'Turkish' };
const AI_CHUNK_SIZE = 25;
const AI_CONCURRENCY = 3;
const AI_BASE_URL = 'https://api.minimax.io/anthropic/v1';

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractJson(content: string): Record<string, string> {
  if (!content) return {};
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {}
  }
  const result: Record<string, string> = {};
  const keyValRe = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = keyValRe.exec(cleaned)) !== null) {
    try {
      result[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`) || '';
    } catch {}
  }
  return result;
}

async function doTranslateChunk(chunk: Required<TranslateKey>[], targetLang: string): Promise<TranslateResult> {
  const inputObj: Record<string, string> = {};
  for (const t of chunk) inputObj[t.id] = t.text;

  const systemPrompt = `You are a professional UI translator. Translate each Russian string into ${LANG_NAME[targetLang]}. Preserve placeholders (like {name}, {count}), punctuation, capitalization style, and brand names (e.g. Hermes CRM, Resend). Keep translations concise and natural for product UI. Return ONLY a JSON object mapping the same keys to their translated strings.`;
  const userPrompt = `Translate these Russian UI strings to ${LANG_NAME[targetLang]} and return JSON with the same keys:\n${JSON.stringify(inputObj)}`;
  const apiKey = process.env.MINIMAX_API_KEY || '';
  if (!apiKey) return { parsed: {}, status: 503 };

  try {
    const aiResp = await fetch(`${AI_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        max_tokens: 8192,
        messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
      }),
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error('AI API error', aiResp.status, errText.slice(0, 200));
      return { parsed: {}, status: aiResp.status };
    }
    const aiData: any = await aiResp.json();
    const textBlock = aiData?.content?.find((b: any) => b.type === 'text');
    return { parsed: extractJson(textBlock?.text || ''), status: 200 };
  } catch (e) {
    console.error('translateChunk error', e);
    return { parsed: {}, status: 500 };
  }
}

async function translateChunk(chunk: Required<TranslateKey>[], targetLang: string, retries = 2): Promise<TranslateResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await doTranslateChunk(chunk, targetLang);
    if (Object.keys(result.parsed).length > 0 || attempt === retries || result.status === 402 || result.status === 429 || result.status === 503) return result;
    await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
  }
  return { parsed: {}, status: 500 };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
    }
  }));
  return results;
}

/**
 * Ensure the i18n_translations table exists.
 * This table stores key-based (not hash-based) translations for dynamic i18n.
 * Keys are the i18n key names (e.g. "nav.platform"), values are per-language translations.
 */
async function ensureI18nTable(): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS public.hermes_i18n_translations (
    lang TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (lang, key)
  )`.execute();
}

// GET /api/translate?lang=en — bulk fetch all cached translations for a language
async function handleGetTranslate(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lang = url.searchParams.get('lang') || '';
  if (!LANG_NAME[lang]) {
    return json({ error: 'Invalid lang parameter' }, 400);
  }
  await ensureI18nTable();
  const rows = await db`SELECT key, value FROM public.hermes_i18n_translations WHERE lang = ${lang}`.execute();
  const translations: Record<string, string> = {};
  for (const r of rows as any[]) {
    translations[r.key] = r.value;
  }
  return json({ translations, count: Object.keys(translations).length });
}

// POST /api/translate — batch translate missing keys using AI, store in DB
async function handlePostTranslate(req: Request): Promise<Response> {
  const { targetLang, keys = [] } = await req.json();
  if (!LANG_NAME[targetLang]) return json({ error: 'Invalid targetLang' }, 400);
  if (!Array.isArray(keys)) return json({ error: 'keys must be an array' }, 400);
  if (keys.length === 0) return json({ translations: {} });

  await ensureI18nTable();

  const cleanKeys: TranslateKey[] = keys.filter((k: any) => k && typeof k.id === 'string' && typeof k.text === 'string');
  const keyIds = cleanKeys.map(k => k.id);

  // Step 1: Check i18n_translations (key-based DB cache)
  let dbRows: any[];
  if (keyIds.length > 0) {
    dbRows = keyIds.length === 1
      ? await db`SELECT key, value FROM public.hermes_i18n_translations WHERE lang = ${targetLang} AND key = ${keyIds[0]}`.execute()
      : await db`SELECT key, value FROM public.hermes_i18n_translations WHERE lang = ${targetLang} AND key = ANY(${keyIds})`.execute();
  } else {
    dbRows = [];
  }

  const dbCacheMap: Record<string, string> = {};
  for (const r of dbRows as any[]) dbCacheMap[r.key] = r.value;

  // Step 2: Check translation_cache (hash-based cache for backwards compat)
  const hashed = await Promise.all(cleanKeys.filter(k => !dbCacheMap[k.id]).map(async k => ({ ...k, hash: await sha256Hex(k.text) } as Required<TranslateKey>)));
  const hashes = hashed.map(h => h.hash);

  const hashCacheResult = hashes.length
    ? await db`SELECT source_hash, translated_text FROM public.hermes_translation_cache WHERE target_lang = ${targetLang} AND source_hash = ANY(${hashes})`.execute()
    : [];

  const hashCacheMap: Record<string, string> = {};
  for (const r of hashCacheResult as any[]) hashCacheMap[r.source_hash] = r.translated_text;

  // Step 3: Build translations result from both caches
  const translations: Record<string, string> = {};
  // Keys that need AI translation
  const toTranslate: Required<TranslateKey>[] = [];

  for (const k of cleanKeys) {
    if (dbCacheMap[k.id]) {
      translations[k.id] = dbCacheMap[k.id];
    } else {
      // Find the hashed version
      const h = hashed.find(h => h.id === k.id);
      if (h && hashCacheMap[h.hash]) {
        translations[k.id] = hashCacheMap[h.hash];
        // Also migrate to i18n_translations
        try {
          await db`INSERT INTO public.hermes_i18n_translations (lang, key, value) VALUES (${targetLang}, ${k.id}, ${hashCacheMap[h.hash]}) ON CONFLICT (lang, key) DO NOTHING`.execute();
        } catch {}
      } else if (h) {
        toTranslate.push(h);
      }
    }
  }

  let rateLimited = false;
  let creditsExhausted = false;

  // Step 4: AI-translate missing keys
  if (toTranslate.length > 0 && process.env.MINIMAX_API_KEY) {
    const chunks: Required<TranslateKey>[][] = [];
    for (let i = 0; i < toTranslate.length; i += AI_CHUNK_SIZE) chunks.push(toTranslate.slice(i, i + AI_CHUNK_SIZE));
    const results = await runWithConcurrency(chunks, AI_CONCURRENCY, chunk => translateChunk(chunk, targetLang));
    const rows: { lang: string; key: string; value: string }[] = [];

    results.forEach((result, ci) => {
      if (result.status === 429) rateLimited = true;
      if (result.status === 402) creditsExhausted = true;
      const chunk = chunks[ci];
      for (const t of chunk) {
        const val = result.parsed?.[t.id];
        if (typeof val === 'string' && val.length > 0) {
          translations[t.id] = val;
          rows.push({ lang: targetLang, key: t.id, value: val });
        }
      }
    });

    if (rows.length > 0) {
      // Deduplicate
      const seen = new Set<string>();
      const unique: typeof rows = [];
      for (const r of rows) {
        const key = r.lang + '||' + r.key;
        if (!seen.has(key)) { seen.add(key); unique.push(r); }
      }
      try {
        await db`INSERT INTO public.hermes_i18n_translations (lang, key, value) VALUES ${db(unique.map(r => [r.lang, r.key, r.value]))} ON CONFLICT (lang, key) DO UPDATE SET value = EXCLUDED.value`.execute();
        // Also save to translation_cache for backward compatibility
        const hashRows = unique.map(r => ({
          source_hash: '', // computed below
          target_lang: r.lang,
          source_text: '',
          translated_text: r.value,
        }));
        // Attempt to save to hash cache too
        for (const r of unique) {
          const originalKey = cleanKeys.find(k => k.id === r.key);
          if (originalKey) {
            const h = await sha256Hex(originalKey.text);
            try {
              await db`INSERT INTO public.hermes_translation_cache (source_hash, target_lang, source_text, translated_text) VALUES (${h}, ${r.lang}, ${originalKey.text}, ${r.value}) ON CONFLICT (source_hash, target_lang) DO UPDATE SET translated_text = EXCLUDED.translated_text`.execute();
            } catch {}
          }
        }
      } catch (e: any) {
        console.error('i18n insert failed:', e.message);
      }
    }
  }

  const status = rateLimited ? 429 : creditsExhausted ? 402 : 200;
  return json({ translations, rateLimited, creditsExhausted }, status);
}

// Combined handler: GET returns cached translations, POST translates
export async function handleTranslate(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return handleGetTranslate(req);
  }
  return handlePostTranslate(req);
}
