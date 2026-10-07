import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAIService, AIError, safeModelError } from '../server/ai.js';

test('真实上游的模型不支持错误不会误导用户重新授权，也不泄露原始错误', () => {
  const error = safeModelError(new Error("OpenAI API error (400): 400 {\"detail\":\"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.\"}"));
  assert.equal(error.code, 'MODEL_UNAVAILABLE');
  assert.match(error.message, /切换模型/);
  assert.ok(!error.message.includes('OpenAI API error'));
});

// These verify the real SDK wiring and auth boundaries. They do not call a model.
test('Pi service: no implicit credentials, safe model status, persistent configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-ai-test-'));
  try {
    const ai = await createAIService(dir);
    const state = ai.status();
    assert.equal(state.ready, false);
    assert.equal(state.provider, 'openai');
    assert.ok(state.models.some(m => m.provider === 'openai' && m.id === state.model));
    await assert.rejects(ai.run({ mode: 'chat', messages: [{ role: 'user', content: 'hello' }] }), (error: unknown) => error instanceof AIError && error.code === 'AUTH_REQUIRED');
    await assert.rejects(ai.run({ mode: 'revise', messages: [{ role: 'user', content: 'change it' }] }), (error: unknown) => error instanceof AIError && error.code === 'SELECTION_REQUIRED');
    await assert.rejects(ai.configure({ model: 'does-not-exist' }), (error: unknown) => error instanceof AIError && error.code === 'INVALID_MODEL');
    await ai.configure({ model: state.model });
    const restored = await createAIService(dir);
    assert.equal(restored.status().model, state.model);
    const saved = JSON.parse(await readFile(join(dir, 'ai-credentials.json'), 'utf8'));
    assert.deepEqual(saved.credentials, {});
    assert.ok(saved.deviceId);
    assert.equal((await stat(join(dir, 'ai-credentials.json'))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(state).includes(saved.deviceId));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Pi Sign in with ChatGPT creates current SIWC authorization URL and cancels callback server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-ai-login-test-'));
  const ai = await createAIService(dir);
  let id: string | undefined;
  try {
    const login = ai.startLogin(); id = login.id;
    assert.equal(login.status, 'starting');
    let state = login;
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      state = ai.loginState(id);
      if (state.status !== 'starting') break;
    }
    assert.equal(state.status, 'waiting', state.error);
    const url = new URL(state.url!);
    assert.equal(url.origin, 'https://auth.openai.com');
    assert.equal(url.pathname, '/api/accounts/authorize');
    assert.ok(url.searchParams.get('scope')?.includes('chatgpt.tokens.use.direct'));
    assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
    assert.throws(() => ai.submitLoginInput(id!, 'http://127.0.0.1:1455/auth/callback?code=invalid&state=wrong'), (error: unknown) => error instanceof AIError && error.code === 'INVALID_CALLBACK');
    assert.equal(ai.cancelLogin(id).status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(ai.status().ready, false);
    // Starting a new callback server proves cancellation released port 1455.
    id = ai.startLogin().id;
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      state = ai.loginState(id);
      if (state.status !== 'starting') break;
    }
    assert.equal(state.status, 'waiting', state.error);
  } finally {
    if (id) ai.cancelLogin(id);
    await new Promise(resolve => setTimeout(resolve, 100));
    await rm(dir, { recursive: true, force: true });
  }
});
