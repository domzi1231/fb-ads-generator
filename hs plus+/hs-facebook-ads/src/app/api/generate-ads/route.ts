import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";

type AdItem = {
  title: string;
  description: string;
  cta: string;
};

type GenerateBody = {
  url?: string;
  customPrompt?: string;
  language?: string; // e.g., "Slovenian", "German", "French"
  variantOf?: AdItem;
};

function buildPrompt(productUrl: string, title?: string, metaDescription?: string, customPrompt?: string, variantOf?: AdItem, language: string = "Slovenian") {
  const sharedGuidelines = `
Context:
- Product URL: ${productUrl}
- Page title (h1): ${title || ""}
- Meta description: ${metaDescription || ""}

Style guidelines (match these exactly):
- Catchy title with an emoji at the start (e.g., ✨, ☀️, 🌧️, ⚡)
- Description must be short, scannable bullet-like lines with emojis
- 3–5 lines in the description, no URLs and no CTA inside description

Rules:
- title: max 9 words, start with an emoji
- description: 3–6 kratkih vrstic, vsaka vrstica naj se začne z emoji ali kratko frazo
- cta: 1–5 besed; pick a CTA that BEST fits the page intent (infer from URL, h1, meta). It may include a leading emoji and/or a trailing down arrow ("👇").
- če gre za e‑commerce produkt/košarico/checkout: uporabi "Kupi" ali "Naroči zdaj"
- če gre za informativno/landing stran ali blog: uporabi "Izvedi več"
- če gre za prijavo/registracijo: uporabi "Prijavi se"
- če gre za kontakt/storitve/ponudbo: uporabi "Kontaktiraj nas" ali "Zahtevaj ponudbo"
IMPORTANT: All text (title, description, CTA) MUST be written in ${language}. Do not use any other language. Avoid untranslated words.
Vsak od treh oglasov naj ima CTA, ki je lahko različen, vendar vedno skladen z namenom strani.

Return a JSON object with key "ads" whose value is an array of 3 items. Each item must include keys: title, description, cta. Example:
{"ads":[
  {"title":"...","description":"...","cta":"<primeren CTA glede na namen>"},
  {"title":"...","description":"...","cta":"<primeren CTA glede na namen>"},
  {"title":"...","description":"...","cta":"<primeren CTA glede na namen>"}
]}`;
  if (variantOf) {
    const base = `${variantOf.title}\n\n${variantOf.description}\n\nCTA: ${variantOf.cta}`;
    return `You are a performance Facebook ads copywriter.
Generate EXACTLY 3 similar VARIATIONS to the given base ad, keeping the same CTA. Language: ${language}.

Base ad:\n${base}

Guidelines:
- Keep the core benefits and style (emoji title + bullet-like short lines)
- Avoid repeating the exact same phrases; rephrase creatively
- Keep CTA identical to the base ad's CTA
- Respect the previous style rules (max title length, 3–6 short lines, no URLs)

Return a JSON object with key "ads" whose value is an array of items with keys: title, description, cta. Example:
{"ads":[{"title":"...","description":"...","cta":"${variantOf.cta}"}]]}`;
  }
  if (customPrompt && customPrompt.trim().length > 0) {
    return `${customPrompt}\n\nGenerate EXACTLY 3 distinct Facebook ad variations in ${language}. Output strictly JSON.\n${sharedGuidelines}`;
  }
  return `You are a performance Facebook ads copywriter.
Generate EXACTLY 3 distinct Facebook ad variations.
 Language: ${language}. Be persuasive, concise, and compliant. Output JSON only.

${sharedGuidelines}`;
}

async function scrapePage(url: string): Promise<{ h1?: string; meta?: string }> {
  const response = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } });
  const html = response.data as string;
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().trim() || undefined;
  const meta = $('meta[name="description"]').attr("content")?.trim() ||
               $('meta[property="og:description"]').attr("content")?.trim() ||
               undefined;
  return { h1, meta };
}

export async function POST(req: NextRequest) {
  try {
    const { url, customPrompt, variantOf, language }: GenerateBody = await req.json();
    if (!url && !variantOf) {
      return NextResponse.json({ error: "Zahteva mora vsebovati 'url' ali 'variantOf'." }, { status: 400 });
    }

    let h1: string | undefined;
    let meta: string | undefined;

    if (url) {
      const scraped = await scrapePage(url);
      h1 = scraped.h1; meta = scraped.meta;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Manjka okoljska spremenljivka OPENAI_API_KEY." }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });
    const prompt = buildPrompt(url || "", h1, meta, customPrompt, variantOf, language || "Slovenian");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You output strictly the requested JSON and nothing else. Respond ONLY in ${language || "Slovenian"}. Do not use any other language.` },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ad_list",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ads: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    cta: { type: "string" }
                  },
                  required: ["title", "description", "cta"]
                }
              }
            },
            required: ["ads"]
          }
        }
      }
    });

    const content = completion.choices?.[0]?.message?.content?.trim() || "";

    let parsed: AdItem[] = [];
    try {
      const json = JSON.parse(content);
      if (Array.isArray(json)) {
        parsed = json;
      } else if (json && Array.isArray(json.ads)) {
        parsed = json.ads;
      } else {
        throw new Error("Unexpected JSON shape");
      }
    } catch (e) {
      // Fallback: poskusi iztisniti prvo JSON tabelo iz besedila
      try {
        const start = content.indexOf("[");
        const end = content.lastIndexOf("]");
        if (start !== -1 && end !== -1 && end > start) {
          const slice = content.slice(start, end + 1);
          const arr = JSON.parse(slice);
          if (Array.isArray(arr)) parsed = arr;
        }
      } catch {}
      if (!parsed.length) {
        return NextResponse.json({ error: "Neveljaven JSON iz OpenAI.", raw: content }, { status: 502 });
      }
    }

    const normalized = parsed
      .slice(0, 3)
      .map((item) => ({
        title: String(item.title || "").trim(),
        description: String(item.description || "").trim(),
        cta: String(item.cta || "").trim(),
      }))
      .filter((a) => a.title && a.description && a.cta);

    if (normalized.length < 3) {
      return NextResponse.json({ error: "Prejetih je premalo oglasov.", items: normalized }, { status: 502 });
    }

    return NextResponse.json({
      source: { url, h1, meta, variant: Boolean(variantOf) },
      ads: normalized,
    });
  } catch (error: any) {
    const message = error?.message || "Neznana napaka";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


