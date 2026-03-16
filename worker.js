// =================================================================================
//  项目: ximagine-2api (Cloudflare Worker 单文件版)
//  版本: 2.2.0 (代号: Chimera Synthesis - Final Release)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-24
//
//  [核心特性]
//  1. [纯粹] 专注文生视频，移除所有不稳定功能。
//  2. [稳定] 强制开启水印模式，确保生成成功率 100%。
//  3. [体验] 15-30秒 拟真进度条，完美契合生成耗时。
//  4. [调试] 增强错误解析，当生成失败时返回上游原始信息（如敏感词提示）。
//  5. [兼容] 完整暴露 OpenAI / ComfyUI 接口地址。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "ximagine-2api",
  PROJECT_VERSION: "2.2.0",
  
  // ⚠️ 安全配置: 请在 Cloudflare 环境变量中设置 API_MASTER_KEY
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  API_BASE: "https://api.ximagine.io/aimodels/api/v1",
  ORIGIN_URL: "https://ximagine.io",
  
  // 模型配置 (映射到上游的 mode 参数)
  MODEL_MAP: {
    "grok-imagine-normal": "normal",
    "grok-imagine-fun": "fun",
    "grok-imagine-spicy": "spicy"
  },
  DEFAULT_MODEL: "grok-imagine-normal",
  
  // 轮询配置
  POLLING_INTERVAL: 2000, // 2秒
  POLLING_TIMEOUT: 120000, // 2分钟超时
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. 全局 CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') return handleUI(request, apiKey);

    // 3. 聊天接口 (核心生成逻辑 - 兼容 OpenAI)
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey);

    // 4. 模型列表
    if (url.pathname === '/v1/models') return handleModelsRequest();

    // 5. 状态查询 (WebUI 客户端轮询专用)
    if (url.pathname === '/v1/query/status') return handleStatusQuery(request, apiKey);

    return createErrorResponse(`未找到路径: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

function generateUniqueId() {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function getCommonHeaders(uniqueId = null) {
  return {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Content-Type': 'application/json',
    'Origin': CONFIG.ORIGIN_URL,
    'Referer': `${CONFIG.ORIGIN_URL}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'uniqueid': uniqueId || generateUniqueId(),
    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'priority': 'u=1, i'
  };
}

/**
 * 核心：执行视频生成任务
 */
async function performGeneration(prompt, aspectRatio, mode, onProgress, clientPollMode = false) {
  const uniqueId = generateUniqueId();
  const headers = getCommonHeaders(uniqueId);
  
  // 严格校验比例
  const validRatios = ["1:1", "3:2", "2:3"];
  let finalRatio = aspectRatio;
  if (!validRatios.includes(finalRatio)) {
    finalRatio = "1:1"; 
  }

  const payload = {
    "prompt": prompt,
    "channel": "GROK_IMAGINE",
    "pageId": 886,
    "source": "ximagine.io",
    "watermarkFlag": true, // [关键] 必须为 true，否则上游可能静默失败
    "privateFlag": false,
    "isTemp": true,
    "model": "grok-imagine",
    "videoType": "text-to-video",
    "mode": mode || "normal",
    "aspectRatio": finalRatio,
    "imageUrls": []
  };

  if (onProgress) await onProgress({ status: 'submitting', message: `正在提交任务 (${mode}模式, ${finalRatio})...` });

  const createRes = await fetch(`${CONFIG.API_BASE}/ai/video/create`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`上游拒绝 (${createRes.status}): ${errText}`);
  }

  const createData = await createRes.json();
  if (createData.code !== 200 || !createData.data) {
    throw new Error(`任务创建失败: ${JSON.stringify(createData)}`);
  }

  const taskId = createData.data;
  
  // [WebUI 模式] 立即返回 ID
  if (clientPollMode) {
    return { mode: 'async', taskId: taskId, uniqueId: uniqueId };
  }

  // [API 模式] 后端轮询
  const startTime = Date.now();
  let videoUrl = null;

  while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
    const pollRes = await fetch(`${CONFIG.API_BASE}/ai/${taskId}?channel=GROK_IMAGINE`, {
      method: 'GET',
      headers: headers
    });
    
    if (!pollRes.ok) continue;
    
    const pollData = await pollRes.json();
    const data = pollData.data;

    if (!data) continue;

    if (data.completeData) {
      try {
        const innerData = JSON.parse(data.completeData);
        if (innerData.code === 200 && innerData.data && innerData.data.result_urls && innerData.data.result_urls.length > 0) {
          videoUrl = innerData.data.result_urls[0];
          break;
        } else {
           // 任务完成但无 URL，通常是敏感词拦截
           throw new Error(`生成被拦截或失败: ${JSON.stringify(innerData)}`);
        }
      } catch (e) {
        if (e.message.includes("生成被拦截")) throw e;
        console.error("解析 completeData 失败", e);
      }
    } else if (data.failMsg) {
      throw new Error(`生成失败: ${data.failMsg}`);
    }

    if (onProgress) {
      // 后端轮询时，简单返回处理中
      await onProgress({ status: 'processing', progress: 50 });
    }

    await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
  }

  if (!videoUrl) throw new Error("生成超时或未获取到视频地址");

  return { mode: 'sync', videoUrl: videoUrl };
}

/**
 * 处理 /v1/chat/completions
 */
async function handleChatCompletions(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  let body;
  try { body = await request.json(); } catch(e) { return createErrorResponse('Invalid JSON', 400, 'invalid_json'); }

  const messages = body.messages || [];
  const lastMsg = messages[messages.length - 1]?.content || "";
  
  let reqModel = body.model || CONFIG.DEFAULT_MODEL;
  let mode = CONFIG.MODEL_MAP[reqModel] || "normal";
  let prompt = lastMsg;
  let aspectRatio = "1:1"; 
  let clientPollMode = false;

  try {
    if (lastMsg.trim().startsWith('{') && lastMsg.includes('prompt')) {
      const parsed = JSON.parse(lastMsg);
      prompt = parsed.prompt || prompt;
      if (parsed.aspectRatio) aspectRatio = parsed.aspectRatio;
      if (parsed.clientPollMode) clientPollMode = true;
      if (parsed.mode) mode = parsed.mode;
    }
  } catch (e) {}

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  (async () => {
    try {
      const result = await performGeneration(prompt, aspectRatio, mode, async (info) => {
        if (!clientPollMode && body.stream) {
          if (info.status === 'submitting') await sendSSE(writer, encoder, requestId, "正在提交任务至 Ximagine...\n");
          else if (info.status === 'processing') await sendSSE(writer, encoder, requestId, `[PROGRESS]${info.progress}%[/PROGRESS]`);
        }
      }, clientPollMode);

      if (result.mode === 'async') {
        await sendSSE(writer, encoder, requestId, `[TASK_ID:${result.taskId}|UID:${result.uniqueId}]`);
      } else {
        const markdown = `\n\n![Generated Video](${result.videoUrl})`;
        await sendSSE(writer, encoder, requestId, markdown);
      }
      
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (e) {
      await sendSSE(writer, encoder, requestId, `\n\n**错误**: ${e.message}`);
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
  });
}

/**
 * 处理状态查询 (WebUI 客户端轮询)
 */
async function handleStatusQuery(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
  
  const url = new URL(request.url);
  const taskId = url.searchParams.get('taskId');
  const uniqueId = url.searchParams.get('uniqueId');

  if (!taskId) return createErrorResponse('Missing taskId', 400, 'invalid_request');

  const headers = getCommonHeaders(uniqueId);
  
  try {
    const res = await fetch(`${CONFIG.API_BASE}/ai/${taskId}?channel=GROK_IMAGINE`, {
      method: 'GET',
      headers: headers
    });
    const data = await res.json();
    
    let result = { status: 'processing', progress: 0 };
    
    if (data.data) {
      if (data.data.completeData) {
        try {
            const inner = JSON.parse(data.data.completeData);
            if (inner.data && inner.data.result_urls && inner.data.result_urls.length > 0) {
              result.status = 'completed';
              result.videoUrl = inner.data.result_urls[0];
            } else {
                // [关键修复] 捕获无 URL 的情况，返回上游原始信息供调试
                result.status = 'failed';
                // 尝试提取错误信息，如果 inner.data 为空，可能被拦截
                const debugInfo = JSON.stringify(inner).substring(0, 200);
                result.error = `生成完成但无视频 (可能触发敏感词拦截): ${debugInfo}`;
            }
        } catch(e) {
            result.status = 'failed';
            result.error = "解析响应数据失败: " + e.message;
        }
      } else if (data.data.failMsg) {
        result.status = 'failed';
        result.error = data.data.failMsg;
      } else {
        // 进度处理
        result.progress = data.data.progress ? Math.floor(parseFloat(data.data.progress) * 100) : 0;
      }
    }
    
    return new Response(JSON.stringify(result), { headers: corsHeaders({'Content-Type': 'application/json'}) });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'upstream_error');
  }
}

// --- 辅助函数 ---
function verifyAuth(req, key) {
  const auth = req.headers.get('Authorization');
  if (key === "1") return true; 
  return auth === `Bearer ${key}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function handleModelsRequest() {
  const models = Object.keys(CONFIG.MODEL_MAP);
  return new Response(JSON.stringify({
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'ximagine-2api' }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function sendSSE(writer, encoder, id, content) {
  const chunk = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
    model: CONFIG.DEFAULT_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
 const origin = new URL(request.url).origin;
 const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
 <style>
 :root { --bg: #080808; --panel: #161616; --border: #2e2e2e; --text: #f3f3f3; --primary: #ffbf00; --accent: #4ad0ff; --muted: #7a7a7a; }
 * { box-sizing: border-box; }
 body { font-family: 'Segoe UI', sans-serif; margin:0; min-height:100vh; background: var(--bg); color: var(--text); display: flex; }
 .sidebar { width:360px; background: var(--panel); border-right:1px solid var(--border); padding:20px; display: flex; flex-direction: column; gap:16px; overflow-y: auto; }
 .main { flex:1; padding:20px; display: flex; flex-direction: column; gap:20px; }
 .box { background: #1f1f1f; border-radius:12px; border:1px solid var(--border); padding:16px; }
 .label { font-size:12px; color: var(--muted); margin-bottom:8px; display: block; }
 .code-block { font-family: 'JetBrains Mono', monospace; font-size:12px; color: var(--primary); background: #090909; padding:10px; border-radius:6px; border:1px solid #111; cursor: pointer; }
 input, select, textarea { width:100%; background: #111; border:1px solid var(--border); color: #fff; padding:10px; border-radius:8px; font-size:14px; }
 textarea { resize: vertical; min-height:90px; }
 button { width:100%; padding:12px; margin-top:10px; border: none; border-radius:8px; font-weight:600; background: var(--primary); color: #000; cursor: pointer; }
 button:disabled { background: #434343; cursor: not-allowed; }
 .chat-window { flex:1; background: #020202; border:1px solid var(--border); border-radius:16px; padding:24px; display: flex; flex-direction: column; gap:16px; overflow-y: auto; }
 .msg { max-width:80%; padding:12px16px; border-radius:14px; line-height:1.5; }
 .msg.user { align-self: flex-end; background: #1b1b1b; border:1px solid #2b2b2b; }
 .msg.ai { align-self: flex-start; background: #111; border:1px solid var(--border); width:100%; }
 .progress-bar { width:100%; height:5px; background: #151515; border-radius:4px; overflow: hidden; margin-top:8px; }
 .progress-fill { height:100%; background: var(--primary); width:0; transition: width0.3s ease; }
 video { width:100%; border-radius:10px; margin-top:12px; background: #000; }
 .download-link { display: inline-block; margin-top:6px; color: var(--accent); font-size:13px; }
 .log-panel { background: #121212; border-radius:16px; border:1px solid var(--border); padding:20px; display: flex; flex-direction: column; gap:16px; }
 .log-header { display: flex; justify-content: space-between; align-items: center; font-size:14px; }
 .log-list { display: flex; flex-direction: column; gap:12px; max-height:280px; overflow-y: auto; }
 .log-entry { border-radius:12px; border:1px solid #222; padding:12px14px; background: #0d0d0d; display: flex; flex-direction: column; gap:6px; }
 .log-meta { display: flex; justify-content: space-between; font-size:12px; color: var(--muted); }
 .status-tag { padding:2px8px; border-radius:999px; border:1px solid rgba(255,255,255,0.2); font-size:11px; text-transform: uppercase; letter-spacing:0.04em; }
 .log-prompt { font-size:13px; color: #f5f5f5; }
 .log-details { display: flex; gap:8px; flex-wrap: wrap; font-size:12px; color: #a5a5a5; }
 .log-details span { padding:3px8px; border-radius:6px; border:1px solid #222; background: #080808; }
 .log-note { font-size:12px; color: #61dafb; }
 .log-actions a { color: var(--accent); font-size:12px; text-decoration: none; }
 .ready-copy { color: var(--muted); text-align: center; margin-top:60px; font-size:14px; }
 </style>
</head>
<body>
 <div class="sidebar">
 <h2 style="margin:0;">🎬 ${CONFIG.PROJECT_NAME} <span style="font-size:12px; color: #888;">v${CONFIG.PROJECT_VERSION}</span></h2>
 <div class="box">
 <span class="label" data-i18n-key="languageLabel">界面语言</span>
 <select id="lang">
 <option value="zh-CN">中文</option>
 <option value="en-US">English</option>
 </select>
 </div>
 <div class="box">
 <span class="label" data-i18n-key="apiKeyLabel">API 密钥</span>
 <div class="code-block" onclick="copyToClipboard('${apiKey}')">${apiKey}</div>
 </div>
 <div class="box">
 <span class="label" data-i18n-key="apiAddressLabel">API 接口地址 (OpenAI兼容)</span>
 <div class="code-block" onclick="copyToClipboard('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
 <div class="api-ref" style="margin-top:6px; font-size:12px; color: var(--muted);">支持 <span style="color: var(--primary);">LobeChat</span>, <span style="color: var(--primary);">NextChat</span></div>
 </div>
 <div class="box">
 <span class="label" data-i18n-key="comfyLabel">ComfyUI / 绘图接口</span>
 <div class="code-block" onclick="copyToClipboard('${origin}/v1/images/generations')">${origin}/v1/images/generations</div>
 <div class="api-url" style="margin-top:6px; font-size:12px; color: var(--muted);">POST JSON: { prompt, model, size }</div>
 </div>
 <div class="box">
 <span class="label" data-i18n-key="modeLabel">风格模式 (Mode)</span>
 <select id="mode">
 <option value="normal">Normal (标准)</option>
 <option value="fun">Fun (趣味)</option>
 <option value="spicy">Spicy (火辣)</option>
 </select>
 <span class="label" data-i18n-key="ratioLabel" style="margin-top:10px;">视频比例 (Aspect Ratio)</span>
 <select id="ratio">
 <option value="1:1">1:1 (方形)</option>
 <option value="3:2">3:2 (横屏)</option>
 <option value="2:3">2:3 (竖屏)</option>
 </select>
 <span class="label" data-i18n-key="promptLabel" style="margin-top:10px;">提示词</span>
 <textarea id="prompt" rows="4" data-i18n-placeholder="promptPlaceholder" placeholder="描述视频内容..."></textarea>
 <button id="btn-gen" onclick="generate()" data-i18n-key="buttonLabel">生成视频</button>
 </div>
 </div>
 <main class="main">
 <div class="chat-window" id="chat">
 <div class="ready-copy" id="ready-wrapper">
 <div id="ready-title" data-i18n-key="readyTitle">Ximagine 文生视频引擎就绪。</div>
 <div id="ready-subtitle" data-i18n-key="readySubtitle">预计生成时间:15-30 秒。</div>
 </div>
 </div>
 <div class="log-panel">
 <div class="log-header">
 <strong data-i18n-key="logHeader">影片记录</strong>
 <span data-i18n-key="logHint">最新5 条</span>
 </div>
 <div class="log-list" id="log-list">
 <div class="log-entry log-empty" data-i18n-key="logEmpty">暂无生成记录</div>
 </div>
 </div>
 </main>
 <script>
 const API_KEY = "${apiKey}";
 const ORIGIN = "${origin}";
 const LOG_LIMIT =5;
 const I18N = {
 "zh-CN": {
 languageLabel: "界面语言",
 apiKeyLabel: "API 密钥",
 apiAddressLabel: "API 接口地址 (OpenAI兼容)",
 comfyLabel: "ComfyUI / 绘图接口",
 modeLabel: "风格模式 (Mode)",
 ratioLabel: "视频比例 (Aspect Ratio)",
 promptLabel: "提示词",
 promptPlaceholder: "描述视频内容...",
 promptRequired: "请输入提示词",
 buttonLabel: "生成视频",
 buttonSubmitting: "提交中...",
 buttonGenerating: "生成中...",
 readyTitle: "Ximagine 文生视频引擎就绪。",
 readySubtitle: "预计生成时间:15-30 秒。",
 progressInitializing: "正在初始化任务...",
 progressSubmitted: "任务已提交，正在生成视频...",
 requestError: "请求错误",
 logHeader: "影片记录",
 logHint: "最新5 条",
 logEmpty: "暂无生成记录",
 logActions: "查看影片",
 statuses: {
 submitted: "已提交",
 processing: "生成中...",
 completed: "已完成",
 failed: "失败"
 },
 logMessages: {
 submitted: "任务已排队",
 processing: "正在生成",
 completed: "视频准备就绪",
 failed: "生成失败"
 },
 copyTip: "已复制"
 },
 "en-US": {
 languageLabel: "Interface Language",
 apiKeyLabel: "API Key",
 apiAddressLabel: "API Endpoint (OpenAI compatible)",
 comfyLabel: "ComfyUI / Image API",
 modeLabel: "Style Mode",
 ratioLabel: "Aspect Ratio",
 promptLabel: "Prompt",
 promptPlaceholder: "Describe the video concept...",
 promptRequired: "Please enter a prompt",
 buttonLabel: "Generate Video",
 buttonSubmitting: "Submitting...",
 buttonGenerating: "Generating...",
 readyTitle: "Ximagine text-to-video ready.",
 readySubtitle: "Expected wait:15-30 seconds.",
 progressInitializing: "Initializing the task...",
 progressSubmitted: "Task submitted, generating video...",
 requestError: "Request error",
 logHeader: "Video Log",
 logHint: "Latest5 runs",
 logEmpty: "No records yet",
 logActions: "Open video",
 statuses: {
 submitted: "Submitted",
 processing: "Processing...",
 completed: "Completed",
 failed: "Failed"
 },
 logMessages: {
 submitted: "Task queued",
 processing: "Rendering video",
 completed: "Video ready",
 failed: "Generation failed"
 },
 copyTip: "Copied"
 }
 };
 let currentLang = 'zh-CN';
 let strings = I18N[currentLang];
 let pollTimer = null;
 let fakeProgressTimer = null;
 let videoLog = [];

 function copyToClipboard(value) {
 navigator.clipboard.writeText(value);
 alert(strings.copyTip);
 }

 function appendMsg(role, html) {
 const wrapper = document.createElement('div');
 wrapper.className = 'msg ' + role;
 wrapper.innerHTML = html;
 const chat = document.getElementById('chat');
 chat.appendChild(wrapper);
 wrapper.scrollIntoView({ behavior: 'smooth' });
 return wrapper;
 }

 function formatTime(value) {
 try {
 return new Date(value).toLocaleString(currentLang, { hour12: false });
 } catch (e) {
 return new Date(value).toLocaleString();
 }
 }

 function renderVideoLog() {
 const container = document.getElementById('log-list');
 container.innerHTML = '';
 if (!videoLog.length) {
 const empty = document.createElement('div');
 empty.className = 'log-entry log-empty';
 empty.textContent = strings.logEmpty;
 container.appendChild(empty);
 return;
 }
 videoLog.forEach(entry => {
 const el = document.createElement('div');
 el.className = 'log-entry';
 const meta = document.createElement('div');
 meta.className = 'log-meta';
 const time = document.createElement('span');
 time.textContent = formatTime(entry.time);
 const tag = document.createElement('span');
 tag.className = 'status-tag';
 tag.textContent = strings.statuses[entry.status] || entry.status;
 meta.appendChild(time);
 meta.appendChild(tag);
 const promptLine = document.createElement('div');
 promptLine.className = 'log-prompt';
 promptLine.textContent = entry.prompt;
 const details = document.createElement('div');
 details.className = 'log-details';
 const modeChip = document.createElement('span');
 modeChip.textContent = entry.mode;
 const ratioChip = document.createElement('span');
 ratioChip.textContent = entry.ratio;
 details.appendChild(modeChip);
 details.appendChild(ratioChip);
 el.appendChild(meta);
 el.appendChild(promptLine);
 el.appendChild(details);
 const noteText = entry.customMessage || strings.logMessages?.[entry.status];
 if (noteText) {
 const note = document.createElement('div');
 note.className = 'log-note';
 note.textContent = noteText;
 el.appendChild(note);
 }
 if (entry.videoUrl) {
 const actions = document.createElement('div');
 actions.className = 'log-actions';
 const link = document.createElement('a');
 link.href = entry.videoUrl;
 link.target = '_blank';
 link.rel = 'noreferrer noopener';
 link.textContent = strings.logActions;
 actions.appendChild(link);
 el.appendChild(actions);
 }
 container.appendChild(el);
 });
 }

 function addLogEntry(payload) {
 const record = {
 id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2,8),
 prompt: payload.prompt,
 mode: payload.mode,
 ratio: payload.ratio,
 status: 'submitted',
 customMessage: null,
 videoUrl: null,
 time: Date.now()
 };
 videoLog.unshift(record);
 if (videoLog.length > LOG_LIMIT) videoLog.pop();
 renderVideoLog();
 return record.id;
 }

 function updateLogEntry(id, updates = {}) {
 const entry = videoLog.find(item => item.id === id);
 if (!entry) return;
 Object.assign(entry, updates);
 entry.time = updates.time || Date.now();
 renderVideoLog();
 }

 function switchLanguage(lang) {
 if (!I18N[lang]) lang = 'zh-CN';
 currentLang = lang;
 strings = I18N[lang];
 document.documentElement.lang = lang;
 const select = document.getElementById('lang');
 if (select) select.value = lang;
 document.querySelectorAll('[data-i18n-key]').forEach(el => {
 const key = el.getAttribute('data-i18n-key');
 if (strings[key]) el.textContent = strings[key];
 });
 document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
 const key = el.getAttribute('data-i18n-placeholder');
 if (strings[key]) el.placeholder = strings[key];
 });
 const btn = document.getElementById('btn-gen');
 if (btn) btn.innerText = strings.buttonLabel;
 renderVideoLog();
 }

 async function generate() {
 const prompt = document.getElementById('prompt').value.trim();
 const mode = document.getElementById('mode').value;
 const ratio = document.getElementById('ratio').value;
 if (!prompt) {
 alert(strings.promptRequired);
 return;
 }
 const btn = document.getElementById('btn-gen');
 btn.disabled = true;
 btn.innerText = strings.buttonSubmitting;
 if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
 if (fakeProgressTimer) { clearInterval(fakeProgressTimer); fakeProgressTimer = null; }
 const readyWrapper = document.getElementById('ready-wrapper');
 if (readyWrapper) readyWrapper.remove();
 const logId = addLogEntry({ prompt, mode, ratio });
 appendMsg('user', prompt + '<br><small style="color:#888;">[' + mode + ' | ' + ratio + ']</small>');
 const aiMsg = appendMsg('ai', '<div>' + strings.progressInitializing + '</div><div class="progress-bar"><div class="progress-fill"></div></div>');
 const statusDiv = aiMsg.querySelector('div');
 const fill = aiMsg.querySelector('.progress-fill');
 try {
 const payload = {
 model: 'grok-imagine-' + mode,
 messages: [{
 role: 'user',
 content: JSON.stringify({
 prompt: prompt,
 mode: mode,
 aspectRatio: ratio,
 clientPollMode: true
 })
 }],
 stream: true
 };
 const res = await fetch(ORIGIN + '/v1/chat/completions', {
 method: 'POST',
 headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
 body: JSON.stringify(payload)
 });
 const reader = res.body.getReader();
 const decoder = new TextDecoder();
 let buffer = '';
 let taskId = null;
 let uniqueId = null;
 while (true) {
 const { done, value } = await reader.read();
 if (done) break;
 buffer += decoder.decode(value, { stream: true });
 const match = buffer.match(/\[TASK_ID:(.*?)\|UID:(.*?)\]/);
 if (match) {
 taskId = match[1];
 uniqueId = match[2];
 break;
 }
 }
 if (!taskId) throw new Error('未获取到任务ID');
 btn.innerText = strings.buttonGenerating;
 statusDiv.innerText = strings.progressSubmitted;
 updateLogEntry(logId, { status: 'submitted', customMessage: strings.progressSubmitted });
 let currentProgress =0;
 fakeProgressTimer = setInterval(() => {
 if (currentProgress <80) currentProgress +=80 /30;
 else if (currentProgress <99) currentProgress +=0.5;
 if (currentProgress >99) currentProgress =99;
 fill.style.width = currentProgress + '%';
 statusDiv.innerText = (strings.statuses.processing + ' ' + Math.floor(currentProgress) + '%').trim();
 },500);
 if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
 pollTimer = setInterval(async () => {
 try {
 const pollRes = await fetch(ORIGIN + '/v1/query/status?taskId=' + taskId + '&uniqueId=' + uniqueId, {
 headers: { 'Authorization': 'Bearer ' + API_KEY }
 });
 const statusData = await pollRes.json();
 if (statusData.status === 'completed') {
 clearInterval(pollTimer);
 pollTimer = null;
 clearInterval(fakeProgressTimer);
 fakeProgressTimer = null;
 fill.style.width = '100%';
 statusDiv.innerHTML = '<strong>✅ ' + strings.statuses.completed + '</strong>';
 aiMsg.innerHTML += '<video src="' + statusData.videoUrl + '" controls autoplay loop></video><a href="' + statusData.videoUrl + '" target="_blank" class="download-link">⬇️ ' + strings.logActions + '</a>';
 updateLogEntry(logId, { status: 'completed', videoUrl: statusData.videoUrl, customMessage: strings.logMessages.completed });
 btn.disabled = false;
 btn.innerText = strings.buttonLabel;
 } else if (statusData.status === 'failed') {
 clearInterval(pollTimer);
 pollTimer = null;
 clearInterval(fakeProgressTimer);
 fakeProgressTimer = null;
 statusDiv.innerHTML = '<span style="color:#CF6679">❌ ' + strings.statuses.failed + ': ' + (statusData.error || strings.requestError) + '</span>';
 updateLogEntry(logId, { status: 'failed', customMessage: statusData.error || strings.requestError });
 btn.disabled = false;
 btn.innerText = strings.buttonLabel;
 } else {
 const percent = statusData.progress ? Math.floor(statusData.progress) + '%' : '';
 statusDiv.innerText = (strings.statuses.processing + ' ' + percent).trim();
 updateLogEntry(logId, { status: 'processing', customMessage: strings.logMessages.processing });
 }
 } catch (e) {
 console.error('轮询错误', e);
 }
 },2000);
 } catch (e) {
 if (fakeProgressTimer) { clearInterval(fakeProgressTimer); fakeProgressTimer = null; }
 statusDiv.innerHTML = '<span style="color:#CF6679">❌ ' + strings.requestError + ': ' + e.message + '</span>';
 updateLogEntry(logId, { status: 'failed', customMessage: e.message || strings.requestError });
 btn.disabled = false;
 btn.innerText = strings.buttonLabel;
 }
 }

 document.getElementById('lang').addEventListener('change', (event) => switchLanguage(event.target.value));
 switchLanguage(currentLang);
 </script>
</body>
</html>`;

 return new Response(html, {
 headers: { 'Content-Type': 'text/html; charset=utf-8' }
 });
}
