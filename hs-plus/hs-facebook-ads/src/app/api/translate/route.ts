import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

type AdItem = {
  title: string;
  description: string;
  cta: string;
};

export async function POST(req: NextRequest) {
  try {
    const { ads, targetLanguage } = await req.json();
    if (!Array.isArray(ads) || !targetLanguage) {
      return NextResponse.json({ error: "Manjkajo podatki: ads ali targetLanguage." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Manjka okoljska spremenljivka OPENAI_API_KEY." }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const prompt = `Translate each ad to ${targetLanguage}. Keep the persuasive style and emojis. Keep CTA short and natural for ${targetLanguage}. Return JSON with key \"ads\" as an array of {title, description, cta}.\n\nAds to translate:\n${JSON.stringify(ads, null, 2)}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You output strictly the requested JSON and nothing else.` },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ad_list_translation",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ads: {
                type: "array",
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
    let result: AdItem[] = [];
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed?.ads)) result = parsed.ads;
    } catch {}
    if (!result.length) {
      return NextResponse.json({ error: "Neveljaven JSON iz OpenAI.", raw: content }, { status: 502 });
    }

    return NextResponse.json({ ads: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Neznana napaka";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


