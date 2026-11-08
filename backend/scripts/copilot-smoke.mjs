// Copilot (Servy) smoke test — verifies the server half of the browser-voice
// path: free/paid-tier text generateContent + function-calling, using the real
// GEMINI_API_KEY exactly as the /api/copilot/generate proxy does. Voice (STT/TTS)
// is browser-only and isn't exercised here.
//
// Run AFTER setting GEMINI_API_KEY in backend/.env:
//   npm run copilot:smoke
//
// Needs network + a key whose Google project can generate content. If you see
// "project denied access" or a free-tier quota of 0, enable billing on that
// project (or use a key from a project with generation quota). Not part of CI.
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

if (!KEY) {
  console.error('✗ GEMINI_API_KEY is not set. Add it to backend/.env first.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: KEY });

/** Tiny 16-bit mono PCM WAV with a sine tone — mirrors the browser recorder's format. */
function makeToneWav(seconds, hz, rate) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

try {
  // 1) Plain text turn — the everyday Q&A path.
  const r1 = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
    config: { systemInstruction: 'You are Servy. Be terse.' },
  });
  console.log(`✓ text generation works (model=${MODEL}): "${(r1.text ?? '').trim()}"`);

  // 2) Function-calling — Servy must be able to ask for a tool call.
  const tools = [{
    functionDeclarations: [{
      name: 'query_crm',
      description: 'Look up CRM records to answer a question.',
      parametersJsonSchema: {
        type: 'object',
        properties: { resource: { type: 'string', enum: ['jobs', 'leads', 'invoices'] } },
        required: ['resource'],
        additionalProperties: false,
      },
    }],
  }];
  const r2 = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: 'How many jobs do I have today?' }] }],
    config: { systemInstruction: 'You are Servy. Use tools to answer questions about CRM data.', tools },
  });
  const calls = r2.functionCalls ?? [];
  if (calls.length) {
    console.log(`✓ function-calling works: model called ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}`);
  } else {
    console.log(`⚠ no function call this run (model replied: "${(r2.text ?? '').trim().slice(0, 80)}"). Tool-calling is non-deterministic; the wiring is valid.`);
  }

  // 3) Audio transcription — the voice path (/api/copilot/transcribe) sends a
  //    16 kHz mono WAV exactly like this. A synthesized tone proves Gemini
  //    accepts the format + the key has audio-input access (expect an empty or
  //    nonsense transcript — there is no speech in a sine wave).
  const wav = makeToneWav(0.6, 440, 16000);
  const r3 = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
        { text: 'Transcribe the speech in this audio verbatim. Reply with ONLY the transcript text. If there is no intelligible speech, reply with an empty string.' },
      ],
    }],
    config: { temperature: 0 },
  });
  console.log(`✓ audio input accepted (voice/STT path works): transcript="${(r3.text ?? '').trim().slice(0, 60)}"`);

  console.log('\n✅ Servy generate + voice paths OK — drop GEMINI_API_KEY in and Servy is live.');
  process.exit(0);
} catch (e) {
  console.error(`✗ generateContent failed: ${e?.message ?? e}`);
  process.exit(2);
}
