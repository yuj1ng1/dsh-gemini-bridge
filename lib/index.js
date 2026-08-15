// dsh-gemini-bridge — global DeepSeek Harness plugin.
// Drives the logged-in Google Gemini web app (gemini.google.com) via an Edge
// CDP bridge script. Registers five model tools:
//   gemini_ask        — ask Gemini anything (web search, deep analysis, optional file/image, optional chat continuation)
//   gemini_vision     — multimodal analysis of a local image
//   gemini_screen     — capture the screen and analyze it
//   gemini_chats      — list Gemini conversation history
//   gemini_chat_read  — read one conversation's content
//
// This is a STANDARD host plugin (not the dynamic vm-sandbox form): it runs in
// the harness process, so it may import Node built-ins and spawn child
// processes directly.
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-gemini-bridge';
export const inject = ['tools'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bridge script location: the global install wins (so an upgrade there is
// picked up), falling back to the copy shipped inside this package.
function bridgePath() {
  const globalPath = path.join(os.homedir(), '.dsh', 'gemini-bridge', 'gemini-bridge.mjs');
  if (existsSync(globalPath)) return globalPath;
  return path.join(__dirname, 'gemini-bridge.mjs');
}

function workspaceRootOf(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  } catch {}
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

// Resolve an absolute node path. Prefer the configured/known node, fall back
// to PATH resolution.
async function nodeExecutable() {
  const candidates = [process.env.DSH_GEMINI_NODE, process.execPath];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return process.execPath;
}

// Run the bridge script with a command and an args object; returns parsed JSON.
function runBridge(command, payload, exec) {
  return new Promise((resolve, reject) => {
    const root = workspaceRootOf(exec);
    if (!root) {
      reject(new Error('gemini tool: cannot determine the session workspace root'));
      return;
    }
    const bridge = bridgePath();
    if (!existsSync(bridge)) {
      reject(new Error('gemini bridge missing at ' + bridge));
      return;
    }

    // Attachment (image_path legacy alias or file_path generic).
    let attachPath = null;
    const attachArg = typeof payload.file_path === 'string' && payload.file_path.length > 0
      ? payload.file_path
      : (typeof payload.image_path === 'string' && payload.image_path.length > 0 ? payload.image_path : null);
    if (attachArg) {
      const abs = path.isAbsolute(attachArg) ? attachArg : path.resolve(root, attachArg);
      if (!existsSync(abs)) {
        reject(new Error('file not found: ' + attachArg));
        return;
      }
      attachPath = abs;
    }

    const prompt = typeof payload.prompt === 'string' && payload.prompt.length > 0
      ? payload.prompt
      : (attachPath ? 'Please describe this image or document in detail.' : 'Hello, please introduce yourself briefly.');

    const argsJson = JSON.stringify({
      filePath: attachPath,
      imagePath: attachPath,
      prompt,
      newChat: payload.new_chat === true,
      chatId: typeof payload.chat_id === 'string' ? payload.chat_id : '',
      outPath: typeof payload.out_path === 'string' ? payload.out_path : '',
      port: 9229,
      edgePath: process.env.DSH_GEMINI_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      profileDir: path.join(os.homedir(), '.dsh', 'gemini-bridge', 'edge-profile'),
      headless: false,
      timeoutMs: 250000,
    });

    // Write args to a temp file, then spawn node bridge <command> <argsFile>.
    const argsFile = path.join(os.tmpdir(), 'dsh-gemini-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
    writeFileSync(argsFile, argsJson, 'utf8');

    nodeExecutable().then((nodePath) => {
      const child = spawn(nodePath, [bridge, command, argsFile], {
        cwd: root,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const onAbort = () => { child.kill(); };
      exec.signal && exec.signal.addEventListener('abort', onAbort);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        exec.signal && exec.signal.removeEventListener('abort', onAbort);
        try { unlinkSync(argsFile); } catch {}
        reject(err);
      });
      child.on('close', (code) => {
        exec.signal && exec.signal.removeEventListener('abort', onAbort);
        try { unlinkSync(argsFile); } catch {}
        const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          reject(new Error('gemini bridge output not JSON (exit=' + code + ') stdout=' + stdout.slice(0, 1200) + ' stderr=' + stderr.slice(0, 800)));
          return;
        }
        if (data.ok !== true) {
          const hint = data.needsLogin
            ? ' Please log in to gemini.google.com with your Google account (Gemini Pro) in the automation Edge window, then retry.'
            : '';
          reject(new Error((data.error || 'gemini tool failed') + hint));
          return;
        }
        resolve(data);
      });
    }).catch(reject);
  });
}

export function apply(ctx) {
  const tools = ctx.tools;
  if (tools === undefined) {
    throw new Error('dsh-gemini-bridge: tools service unavailable');
  }

  const output = {
    text: { type: 'string', required: true, description: 'Gemini reply text' },
    url: { type: 'string', description: 'Conversation URL' },
  };

  tools.register(defineTool({
    name: 'gemini_vision',
    description: 'Send a local image to the Google Gemini website (gemini.google.com, your logged-in Pro account) on this computer for multimodal analysis; returns Gemini text reply. Use for viewing images, OCR of screenshots, understanding charts/UI/objects. image_path is the local image path (absolute or workspace-relative; PNG/JPG/WebP/GIF).',
    parameters: {
      image_path: { type: 'string', required: true, description: 'Absolute or workspace-relative path to the image file' },
      prompt: { type: 'string', description: 'Instruction for Gemini; default asks to describe the image in detail' },
      new_chat: { type: 'boolean', description: 'Start a new chat first (default false)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: output },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const data = await runBridge('vision', args, exec);
      return { text: String(data.text || ''), url: String(data.url || '') };
    },
  }));

  tools.register(defineTool({
    name: 'gemini_ask',
    description: 'Ask the Google Gemini website (gemini.google.com, your logged-in Pro account) on this computer a question and return Gemini full text reply. Use for: live/up-to-date information (Gemini web app can search the web itself), deep long-text analysis and writing, translation, code explanation, multimodal understanding (optional image/file). Prefer this when you need a second model view/answer, latest news, or information I (DeepSeek) cannot confirm. Optional: file_path to attach any local file (image/PDF/doc/code); chat_id to continue a conversation from gemini_chats.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Question or instruction for Gemini' },
      file_path: { type: 'string', description: 'Optional local file path (image/PDF/text/code) to attach for analysis' },
      image_path: { type: 'string', description: 'Optional image path (alias of file_path)' },
      chat_id: { type: 'string', description: 'Optional chat ID to continue an existing conversation (from gemini_chats)' },
      new_chat: { type: 'boolean', description: 'Start a new chat first (default false)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: output },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const data = await runBridge('vision', args, exec);
      return { text: String(data.text || ''), url: String(data.url || '') };
    },
  }));

  tools.register(defineTool({
    name: 'gemini_screen',
    description: 'Capture the current screen of this computer and send the screenshot to the Google Gemini website (gemini.google.com, your logged-in Pro account) for analysis; returns Gemini description of the screen. Use for: viewing the current screen state, diagnosing error screens, reading code/text shown on screen. Make sure the content you want analyzed is visible on screen first (the automation Edge window may cover it; it is minimized during capture).',
    parameters: {
      prompt: { type: 'string', description: 'Instruction for Gemini; default asks to describe the screenshot in detail' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: output },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' && args.prompt.length > 0
        ? args.prompt
        : 'Describe this screenshot in detail: all visible windows, text, and UI elements.';
      const data = await runBridge('screenshot', { prompt }, exec);
      return { text: String(data.text || ''), url: String(data.url || '') };
    },
  }));

  tools.register(defineTool({
    name: 'gemini_chats',
    description: 'List the conversation history on the Google Gemini website (gemini.google.com) on this computer: each conversation title and ID. Use with gemini_chat_read: list chats to find the chat_id, then read its content or continue it.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chats: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.chats || []).map((c, i) => `${i + 1}. ${c.title} (${c.id})`).join('\n'),
      }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const data = await runBridge('chats', {}, exec);
      return { chats: data.chats || [] };
    },
  }));

  tools.register(defineTool({
    name: 'gemini_chat_read',
    description: 'Read the full content of a conversation on the Google Gemini website (gemini.google.com) on this computer: two arrays users (user questions) and models (Gemini replies) in chronological order. chat_id comes from gemini_chats output.',
    parameters: {
      chat_id: { type: 'string', required: true, description: 'Conversation ID (from gemini_chats list)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              users: { type: 'array', items: { type: 'string' } },
              models: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (args, value) => {
        const c = value.chat || {};
        const parts = [];
        const users = c.users || [];
        const models = c.models || [];
        const n = Math.max(users.length, models.length);
        for (let i = 0; i < n; i++) {
          if (i < users.length) parts.push('User: ' + users[i]);
          if (i < models.length) parts.push('Gemini: ' + models[i]);
        }
        return [{ type: 'text', text: 'Title: ' + (c.title || '') + '\n' + parts.join('\n\n') }];
      },
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const data = await runBridge('read', { chat_id: args.chat_id }, exec);
      return { chat: data.chat || {} };
    },
  }));

  console.log('dsh-gemini-bridge: gemini_ask / gemini_vision / gemini_screen / gemini_chats / gemini_chat_read registered');
}
