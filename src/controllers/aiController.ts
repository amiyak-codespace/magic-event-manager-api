import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export const aiChat = async (req: AuthRequest, res: Response): Promise<void> => {
  const { message, context } = req.body as { message: string; context?: string };

  const systemPrompt = `You are Aria, an intelligent AI event assistant built into Thevent — an event management platform.
You help organizers and attendees with:
- Creating events from natural language descriptions (output a JSON block with: title, description, short_description, city, state, venue_name, start_date, end_date, is_free, price, is_online, tags, category suggestion)
- Generating compelling event descriptions and titles
- Suggesting pricing strategies and ticket tiers
- Answering questions about events
- Providing tips for better event promotion

When a user wants to create an event, extract details and output a JSON block wrapped in \`\`\`json ... \`\`\` followed by a friendly explanation.
Always be concise, helpful, and action-oriented.
${context ? `Current context: ${context}` : ''}`;

  try {
    const fullPrompt = `${systemPrompt}\n\nUser: ${message}`;
    const reply = await callGemini(fullPrompt);
    res.json({ reply });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'AI assistant unavailable' });
  }
};

export const aiGenerateEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  const { description, target_language } = req.body as { description: string; target_language?: string };
  const nowIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const prompt = `You are an event creation assistant. Extract a complete event plan from this description and return ONLY a valid JSON object (no markdown, no explanation).
Important language rule:
- If user input is in Hindi/Tamil/Telugu/etc, keep user-facing text fields in the same language.
- Never force English translation unless user explicitly asks.
- Unicode text is allowed.
${target_language && target_language !== 'same'
  ? `- Output user-facing text fields in this target language: ${target_language}.`
  : ''}
Current date/time reference for relative dates: ${nowIst} (Asia/Kolkata).

Description: "${description}"

Return this exact JSON structure:
{
  "title": "string",
  "description": "string (2-3 paragraphs)",
  "short_description": "string (max 150 chars)",
  "city": "string",
  "state": "string",
  "country": "string",
  "venue_name": "string",
  "venue_address": "string",
  "start_date": "ISO8601 datetime",
  "end_date": "ISO8601 datetime",
  "registration_deadline": "ISO8601 datetime or null",
  "is_free": boolean,
  "price": number,
  "currency": "INR",
  "is_online": boolean,
  "online_link": "string or null",
  "max_attendees": "number or null",
  "is_private": "boolean",
  "show_attendees_public": "boolean",
  "banner_url": "string or null",
  "tags": "comma,separated,tags",
  "category_suggestion": "one of: music, sports, tech, food-drink, arts, business, fitness, networking",
  "ticket_types": [
    {
      "name": "string",
      "description": "string",
      "is_free": "boolean",
      "price": "number",
      "currency": "string",
      "capacity": "number or null",
      "sale_end": "ISO8601 datetime or null"
    }
  ],
  "agenda_items": [
    {
      "title": "string",
      "description": "string",
      "speaker_name": "string",
      "speaker_title": "string",
      "start_time": "ISO8601 datetime",
      "end_time": "ISO8601 datetime or null",
      "location": "string",
      "type": "one of talk,keynote,panel,workshop,break,networking"
    }
  ],
  "sponsors": [
    {
      "name": "string",
      "description": "string",
      "website_url": "string",
      "tier": "one of platinum,gold,silver,bronze,community"
    }
  ]
}

Rules:
- Keep output realistic and concise.
- Use ONLY information present or clearly implied by the prompt.
- Do NOT invent people names, sponsor brand names, company names, or specific links.
- If speaker/sponsor details are not explicitly present, leave speaker_name/speaker_title empty and sponsors as [].
- Do not add random agenda/ticket entries; add only if prompt explicitly requests or contains enough concrete context.
- If exact dates/times are not present, infer only when clearly possible from prompt context; otherwise return null/empty values.
- Return strict JSON only.`;

  try {
    const raw = await callGemini(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(422).json({ error: 'Could not parse event details' });
      return;
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    res.json(parsed);
  } catch (err) {
    console.error('AI generate event error:', err);
    res.status(500).json({ error: 'Failed to generate event details' });
  }
};

export const aiGenerateInviteCreative = async (req: AuthRequest, res: Response): Promise<void> => {
  const { template, title, short_description, description, city, start_date, color_palette } = req.body as {
    template?: string;
    title?: string;
    short_description?: string;
    description?: string;
    city?: string;
    start_date?: string;
    color_palette?: string[];
  };

  const templateKey = String(template || 'custom').toLowerCase();
  const palette = Array.isArray(color_palette)
    ? color_palette.filter((c) => /^#[0-9a-fA-F]{6}$/.test(String(c))).slice(0, 4)
    : [];

  const themeByTemplate: Record<string, 'celebration' | 'wedding' | 'enterprise' | 'sports' | 'community' | 'general'> = {
    birthday: 'celebration',
    wedding: 'wedding',
    corporate: 'enterprise',
    anniversary: 'sports',
    housewarming: 'community',
    custom: 'general',
  };
  const theme = themeByTemplate[templateKey] || 'general';

  const mediaCatalog: Record<string, { gif: string[]; photo: string[] }> = {
    celebration: {
      gif: [
        'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif',
        'https://media.giphy.com/media/3o7aD2saalBwwftBIY/giphy.gif',
        'https://media.giphy.com/media/26u4cqiYI30juCOGY/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3',
        'https://images.unsplash.com/photo-1519671482749-fd09be7ccebf',
      ],
    },
    wedding: {
      gif: [
        'https://media.giphy.com/media/3o6nV1ouOsNLBTEqQM/giphy.gif',
        'https://media.giphy.com/media/3ohs4BSacFKI7A717y/giphy.gif',
        'https://media.giphy.com/media/xTiTnEHBh7qapyuvwQ/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1519741497674-611481863552',
        'https://images.unsplash.com/photo-1520854221256-17451cc331bf',
      ],
    },
    enterprise: {
      gif: [
        'https://media.giphy.com/media/l0HlPjezGYG3rS6Fq/giphy.gif',
        'https://media.giphy.com/media/xT0xezQGU5xCDJuCPe/giphy.gif',
        'https://media.giphy.com/media/3o7TKtnuHOHHUjR38Y/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1521737604893-d14cc237f11d',
        'https://images.unsplash.com/photo-1497366754035-f200968a6e72',
      ],
    },
    sports: {
      gif: [
        'https://media.giphy.com/media/3o6Ztb7M4R2FF7wQyk/giphy.gif',
        'https://media.giphy.com/media/l0MYGb1LuZ3n7dRnO/giphy.gif',
        'https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1461896836934-ffe607ba8211',
        'https://images.unsplash.com/photo-1517649763962-0c623066013b',
      ],
    },
    community: {
      gif: [
        'https://media.giphy.com/media/l4FGpP4lxGGgK5CBW/giphy.gif',
        'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif',
        'https://media.giphy.com/media/l4FGI8GoTL7N4DsyI/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1529156069898-49953e39b3ac',
        'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2',
      ],
    },
    general: {
      gif: [
        'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif',
        'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif',
        'https://media.giphy.com/media/3o7TKsQ8UQYx8F4nYY/giphy.gif',
      ],
      photo: [
        'https://images.unsplash.com/photo-1511578314322-379afb476865',
        'https://images.unsplash.com/photo-1503428593586-e225b39bddfe',
      ],
    },
  };
  const catalog = mediaCatalog[theme] || mediaCatalog.general;
  const fallbackGif = catalog.gif[0];
  const fallbackPhoto = catalog.photo[0];

  const prompt = `Create a concise WhatsApp invitation copy for an invite-only event.
Return ONLY valid JSON:
{
  "message": "short invitation text under 450 chars, professional and clear",
  "gif_theme_keywords": "3 to 5 words, lowercase"
}
Template: ${templateKey}
Title: ${title || ''}
Short Description: ${short_description || ''}
Description: ${description || ''}
City: ${city || ''}
Start Date: ${start_date || ''}
Brand Color Palette: ${palette.length ? palette.join(', ') : 'default'}.
The copy must work for personal, enterprise, sports, or community events.`;

  try {
    const raw = await callGemini(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as { message?: string; gif_theme_keywords?: string } : {};
    const message = String(parsed.message || '').trim()
      || `You're invited to ${title || 'our event'}${city ? ` in ${city}` : ''}.`;
    const mediaOptions = [
      { kind: 'gif', label: 'GIF 1', url: catalog.gif[0] || fallbackGif },
      { kind: 'gif', label: 'GIF 2', url: catalog.gif[1] || fallbackGif },
      { kind: 'animated_photo', label: 'Animated Photo 1', url: catalog.photo[0] || fallbackPhoto },
      { kind: 'animated_photo', label: 'Animated Photo 2', url: catalog.photo[1] || fallbackPhoto },
    ];
    res.json({
      message,
      gif_url: fallbackGif,
      animated_photo_url: fallbackPhoto,
      media_options: mediaOptions,
      gif_theme_keywords: String(parsed.gif_theme_keywords || templateKey).trim(),
    });
  } catch (err) {
    console.error('AI generate invite creative error:', err);
    const mediaOptions = [
      { kind: 'gif', label: 'GIF 1', url: catalog.gif[0] || fallbackGif },
      { kind: 'gif', label: 'GIF 2', url: catalog.gif[1] || fallbackGif },
      { kind: 'animated_photo', label: 'Animated Photo 1', url: catalog.photo[0] || fallbackPhoto },
      { kind: 'animated_photo', label: 'Animated Photo 2', url: catalog.photo[1] || fallbackPhoto },
    ];
    res.json({
      message: `You're invited to ${title || 'our event'}${city ? ` in ${city}` : ''}.`,
      gif_url: fallbackGif,
      animated_photo_url: fallbackPhoto,
      media_options: mediaOptions,
      gif_theme_keywords: templateKey,
    });
  }
};
