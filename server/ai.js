// Claude-powered aircraft lookup. Streams an answer about the selected plane
// (aircraft facts + current flight) using the Anthropic SDK with web search so
// answers can include up-to-date information.
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config.js';

export function aiAvailable() {
  return !!getConfig().anthropic.apiKey;
}

export async function streamAircraftFacts(detail, res) {
  const cfg = getConfig();
  if (!cfg.anthropic.apiKey) {
    res.write(`data: ${JSON.stringify({ error: 'No Anthropic API key configured (Settings → AI).' })}\n\n`);
    res.end();
    return;
  }
  const client = new Anthropic({ apiKey: cfg.anthropic.apiKey });

  const facts = {
    icaoHex: detail.hex,
    callsign: detail.flight,
    registration: detail.registration,
    type: detail.type,
    typeName: detail.typeName,
    operator: detail.operator,
    airline: detail.airline,
    category: detail.classification,
    altitudeFt: detail.alt,
    groundSpeedKt: detail.gs,
    verticalRateFpm: detail.vr,
    squawk: detail.squawk,
    route: detail.route
      ? {
          from: detail.route.origin ? `${detail.route.origin.name} (${detail.route.origin.icao}), ${detail.route.origin.country}` : null,
          to: detail.route.destination ? `${detail.route.destination.name} (${detail.route.destination.icao}), ${detail.route.destination.country}` : null,
          airline: detail.route.airline?.name
        }
      : null,
    estimatedTimeToDestinationMin: detail.etaDestSec ? Math.round(detail.etaDestSec / 60) : null
  };

  const prompt = `Here is live ADS-B data for an aircraft I am currently tracking with my own receiver:

${JSON.stringify(facts, null, 2)}

Tell me about this aircraft and its current travel. Include:
- What aircraft this is (model, typical use, interesting facts — engines, range, capacity, first flight, notable history of this specific airframe or operator if known)
- The operator/airline and anything notable about it
- This flight/route: what route it likely flies, anything notable about origin/destination
- Anything special about this particular plane (registration ${facts.registration || 'unknown'}) if you can find it

Keep it engaging and concise (a few short paragraphs). If live data conflicts with what you find online, trust my live data.`;

  try {
    const stream = client.messages.stream({
      model: cfg.anthropic.model || 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system:
        'You are an enthusiastic but accurate aviation expert embedded in a personal flight-tracking app. Use web search when it helps (registration lookups, operator news, route info). Never invent specifics you cannot verify; say when something is uncertain.',
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: prompt }]
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      res.write(`data: ${JSON.stringify({ error: 'Claude declined this request.' })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: `Claude lookup failed: ${e.message}` })}\n\n`);
  } finally {
    res.end();
  }
}
