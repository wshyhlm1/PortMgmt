export async function qwenJson(task) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is missing');
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || 'https://coding.dashscope.aliyuncs.com/v1').replace(/\/+$/, '');
  const model = process.env.QWEN_MODEL || 'qwen3.6-plus';
  const effort = process.env.QWEN_REASONING_EFFORT || 'high';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      reasoning_effort: effort,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是投研数据清洗助手。只输出 JSON，不输出 Markdown 或解释。' },
        { role: 'user', content: JSON.stringify(task) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Qwen HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('Qwen returned empty content');
  return JSON.parse(content);
}
