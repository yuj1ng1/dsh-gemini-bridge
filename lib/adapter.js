// dsh-gemini-bridge adapter — a DeepSeek Harness LLM provider that routes
// model calls to the user's logged-in Gemini web app (gemini.google.com) via
// the CDP bridge. Registers provider "gemini-bridge" / model "gemini-web".
//
// The model declares both text and image input modalities, so pasting an image
// into the composer is accepted by the harness; the image bytes are written to
// a temp file and sent to Gemini, whose reply streams back as chunks.
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const PROVIDER = 'gemini-bridge';
export const MODEL = 'gemini-web';
export const MODEL_NAME = 'Gemini (Web / Pro)';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bridgePath() {
  const globalPath = path.join(os.homedir(), '.dsh', 'gemini-bridge', 'gemini-bridge.mjs');
  if (existsSync(globalPath)) return globalPath;
  return path.join(__dirname, 'gemini-bridge.mjs');
}

// Run the bridge with a command + args JSON; resolves parsed JSON.
function runBridge(command, payload, signal) {
  return new Promise((resolve, reject) => {
    const bridge = bridgePath();
    if (!existsSync(bridge)) {
      reject(new Error('gemini bridge missing at ' + bridge));
      return;
    }
    const argsJson = JSON.stringify(payload);
    const argsFile = path.join(os.tmpdir(), 'dsh-gemini-adapter-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
    writeFileSync(argsFile, argsJson, 'utf8');
    const child = spawn(process.execPath, [bridge, command, argsFile], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const onAbort = () => { child.kill(); };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      try { unlinkSync(argsFile); } catch {}
      reject(err);
    });
    child.on('close', (code) => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      try { unlinkSync(argsFile); } catch {}
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        reject(new Error('gemini bridge output not JSON (exit=' + code + ') ' + stderr.slice(0, 500)));
        return;
      }
      if (data.ok !== true) {
        reject(new Error(data.error || 'gemini bridge failed'));
        return;
      }
      resolve(data);
    });
  });
}

/**
 * A minimal LlmAdapter-shaped object. It ducks the abstract class so the
 * plugin needs no extra wiring: LlmRuntime only calls the documented methods.
 */
export function createGeminiWebAdapter(attachments) {
  return {
    providerInfo(provider) {
      return { id: provider, name: 'Gemini (Web)' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    async listModels(provider) {
      return [{ provider, id: MODEL, name: MODEL_NAME, inputModalities: ['text', 'image'] }];
    },
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model === MODEL ? MODEL_NAME : model,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 1000000 },
      };
    },
    async *stream(options) {
      const { messages, system, signal } = options;

      // Extract the last user message: its text blocks plus any image refs.
      let promptParts = [];
      let imageRef = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const content = Array.isArray(msg && msg.content) ? msg.content : [];
        const hasImage = content.some((b) => b && b.type === 'image');
        const textParts = content.filter((b) => b && b.type === 'text').map((b) => b.text);
        if (hasImage && imageRef === null) {
          const imgBlock = content.find((b) => b && b.type === 'image');
          imageRef = imgBlock.attachment;
        }
        promptParts = [...textParts, ...promptParts];
        if (hasImage) break;
        if (textParts.length > 0) break;
      }
      const systemText = system && system.length > 0 ? system : '';
      const userText = promptParts.join('\n');
      const finalPrompt = [systemText, userText].filter((s) => s.length > 0).join('\n\n');

      // If there is an image, write it to a temp file and send via vision.
      let imagePath = null;
      if (imageRef && attachments) {
        try {
          const stored = await attachments.readImage(imageRef, signal);
          const mediaType = stored.ref && stored.ref.mediaType ? stored.ref.mediaType : 'image/png';
          const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mediaType] || '.png';
          imagePath = path.join(os.tmpdir(), 'dsh-gemini-adapter-img-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
          writeFileSync(imagePath, Buffer.from(stored.data));
        } catch (e) {
          imagePath = null;
        }
      }

      const payload = {
        filePath: imagePath,
        imagePath,
        prompt: finalPrompt.length > 0 ? finalPrompt : 'Hello, please introduce yourself briefly.',
        newChat: true,
        port: 9229,
        edgePath: process.env.DSH_GEMINI_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        profileDir: path.join(os.homedir(), '.dsh', 'gemini-bridge', 'edge-profile'),
        headless: false,
        timeoutMs: 250000,
      };

      try {
        const data = await runBridge('vision', payload, signal);
        const text = data && data.text ? data.text : '';
        if (imagePath) { try { unlinkSync(imagePath); } catch {} }
        if (text.length === 0) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Gemini returned no text' } } };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (e) {
        if (imagePath) { try { unlinkSync(imagePath); } catch {} }
        const message = e instanceof Error ? e.message : String(e);
        yield { type: 'finish', reason: { kind: 'error', failure: { message } } };
      }
    },
  };
}
