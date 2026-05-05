export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  const { system, user } = req.body || {};
  if (!user) {
    return res.status(400).json({ error: 'Missing user message.' });
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
    }),
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => '');
    return res.status(groqRes.status).json({ error: `Groq error ${groqRes.status}: ${errText.slice(0, 300)}` });
  }

  const data = await groqRes.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return res.status(200).json({ text });
}
