let token = '';
async function authorizedFetch(path: string, body: unknown, method: string) {
  const refresh = async () => { const session = await fetch('/api/session').then(r => r.json()); token = session.token; };
  if (!token) await refresh();
  const request = () => fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body) });
  let response = await request();
  if (response.status === 403) { const error = await response.clone().json().catch(() => ({})); if (error.message === '会话已过期，请刷新页面。') { await refresh(); response = await request(); } }
  return response;
}
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = body === undefined ? await fetch(path) : await authorizedFetch(path, body, method);
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || error.message || `请求失败（${response.status}）`); }
  return response.json();
}
export async function stream(path: string, body: unknown, event: (type: string, value: any) => void) {
  const response = await authorizedFetch(path, body, 'POST');
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || err.message || `请求失败（${response.status}）`); }
  if (!response.body) throw new Error('未收到模型响应');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', streamError = ''; let completed = false;
  while (true) {
    const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      const type = block.match(/^event: ?(.+)$/m)?.[1] || 'message';
      const raw = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (raw) { const data = JSON.parse(raw); if (type === 'error') { streamError = data.message || '模型请求失败'; } else { if (type === 'done') completed = true; event(type, data); } }
    }
    if (done) break;
  }
  if (streamError) throw new Error(streamError);
  if (!completed) throw new Error('连接已中断，未收到完成确认。请检查文档后重试。');
}
