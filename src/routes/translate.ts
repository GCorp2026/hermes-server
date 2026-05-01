import { db } from '../db';

const LANG_NAME: Record<string, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
};

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// POST /api/translate — batch translate missing keys using MiniMax
export async function handleTranslate(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const targetLang = String(body?.targetLang || '');
    const keys: { id: string; text: string }[] = Array.isArray(body?.keys) ? body.keys : [];

    if (!LANG_NAME[targetLang]) {
      return new Response(JSON.stringify({ error: 'Invalid targetLang' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (keys.length === 0) {
      return new Response(JSON.stringify({ translations: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Compute hashes and check Hermes Postgres cache
    const hashed = await Promise.all(keys.map(async (k) => ({ ...k, hash: await sha256(k.text) })));
    const hashes = hashed.map((h) => h.hash);

    const cached = await db
      `SELECT source_hash, translated_text FROM translation_cache WHERE target_lang = ${targetLang} AND source_hash = ANY(${hashes})`
      .execute();

    const cacheMap = new Map<string, string>();
    for (const r of cached as any[]) cacheMap.set(r.source_hash, r.translated_text);

    const translations: Record<string, string> = {};
    const toTranslate: typeof hashed = [];
    for (const k of hashed) {
      const hit = cacheMap.get(k.hash);
      if (hit) translations[k.id] = hit;
      else toTranslate.push(k);
    }

    if (toTranslate.length > 0) {
      const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
      if (!MINIMAX_API_KEY) {
        // Fallback: return empty, frontend will show RU fallback
        return new Response(JSON.stringify({ translations }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const inputObj: Record<string, string> = {};
      for (const t of toTranslate) inputObj[t.id] = t.text;

      const systemPrompt = `You are a professional UI translator. Translate each Russian string into ${LANG_NAME[targetLang]}. Preserve placeholders, punctuation, capitalization style, and brand names (e.g. Hermes CRM). Keep translations concise and natural for product UI. Return ONLY a JSON object mapping the same keys to their translated strings.`;
      const userPrompt = `Translate these Russian UI strings to ${LANG_NAME[targetLang]} and return JSON with the same keys:\n${JSON.stringify(inputObj)}`;

      const aiResp = await fetch('https://api.minimax.io/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': MINIMAX_API_KEY,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'MiniMax-M2.7',
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      
      if (aiResp.ok) {
        const aiData = await aiResp.json() as any;
        const contentObj = (aiData?.content as any[])?.find((c: any) => c.type === 'text');
        const content = contentObj?.text || '{}';
        try { parsed = JSON.parse(content); } catch {
          const m = content.match(/\{[\s\S]*\}/);
          if (m) parsed = JSON.parse(m[0]);
        }
      }

      const rows: any[] = [];
      for (const t of toTranslate) {
        const val = parsed[t.id];
        if (typeof val === 'string' && val.length > 0) {
          translations[t.id] = val;
          rows.push({
            source_hash: t.hash,
            target_lang: targetLang,
            source_text: t.text,
            translated_text: val,
          });
        }
      }

      if (rows.length > 0) {
        await db`
          INSERT INTO translation_cache (source_hash, target_lang, source_text, translated_text)
          VALUES ${db(rows.map((r) => [r.source_hash, r.target_lang, r.source_text, r.translated_text]))}
          ON CONFLICT (source_hash, target_lang) DO UPDATE SET translated_text = EXCLUDED.translated_text
        `.execute();
      }
    }

    return new Response(JSON.stringify({ translations }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error("MINIMAX_KEY present:", !!process.env.MINIMAX_API_KEY, "resp.ok:", aiResp.ok, "status:", aiResp.status);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
