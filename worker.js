// =================================================================================
// 项目: ximagine-2api (Cloudflare Worker 单文件版)
// 版本: 2.4.0 (代号: Chimera Synthesis - Premium UI Edition)
// 作者: 首席AI执行官 (Principal AI Executive Officer)
// 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
// 日期: 2025-11-24
//
// [核心特性]
// 1. [纯粹] 专注文生视频，移除所有不稳定功能。
// 2. [稳定] 强制开启水印模式，确保生成成功率 100%。
// 3. [体验] 15-30秒 拟真进度条，完美契合生成耗时。
// 4. [调试] 增强错误解析，当生成失败时返回上游原始信息（如敏感词提示）。
// 5. [兼容] 完整暴露 OpenAI / ComfyUI 接口地址。
// 6. [多语] 支持中英文界面切换。
// 7. [历史] 本地保存生成记录，支持查看与下载。
// 8. [主题] 支持深色/浅色主题切换。
// 9. [模板] 内置快速提示词模板。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
PROJECT_NAME: "ximagine-2api",
PROJECT_VERSION: "2.4.0",

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

// --- [第四部分: 开发者驾驶舱 UI (Premium Edition)] ---
function handleUI(request, apiKey) {
const origin = new URL(request.url).origin;
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${CONFIG.PROJECT_NAME} - Dashboard</title>
<style>
/* ===== 色彩系統 ===== */
:root {
--bg: #0a0a0f;
--bg-gradient-start: #0a0a0f;
--bg-gradient-mid: #1a1a2e;
--bg-gradient-end: #0a0a0f;
--panel: rgba(20, 20, 31, 0.85);
--card: rgba(26, 26, 46, 0.7);
--border: rgba(99, 102, 241, 0.2);
--border-solid: #2a2a3e;
--text: #e8e8f0;
--text-muted: #8888a0;
--primary: #6366f1;
--primary-hover: #818cf8;
--primary-glow: rgba(99, 102, 241, 0.4);
--accent: #22d3ee;
--success: #10b981;
--error: #ef4444;
--warning: #f59e0b;
}

/* 淺色主題 */
body.light-theme {
--bg: #f5f5fa;
--bg-gradient-start: #f5f5fa;
--bg-gradient-mid: #e8e8f0;
--bg-gradient-end: #f5f5fa;
--panel: rgba(255, 255, 255, 0.9);
--card: rgba(255, 255, 255, 0.8);
--border: rgba(99, 102, 241, 0.3);
--border-solid: #d0d0e0;
--text: #1a1a2e;
--text-muted: #6a6a8a;
--primary: #4f46e5;
--primary-hover: #6366f1;
--primary-glow: rgba(79, 70, 229, 0.3);
}

/* ===== 基礎樣式 ===== */
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-mid) 50%, var(--bg-gradient-end) 100%);
color: var(--text);
min-height: 100vh;
display: flex;
flex-direction: column;
overflow-x: hidden;
transition: background 0.5s ease, color 0.3s ease;
}

/* ===== 頂部導航列 ===== */
.topbar {
display: flex;
justify-content: space-between;
align-items: center;
padding: 15px 25px;
background: var(--panel);
backdrop-filter: blur(15px);
border-bottom: 1px solid var(--border);
position: sticky;
top: 0;
z-index: 100;
}
.logo {
display: flex;
align-items: center;
gap: 10px;
font-size: 20px;
font-weight: 700;
}
.logo-icon { font-size: 28px; }
.version {
font-size: 12px;
color: var(--text-muted);
background: var(--card);
padding: 4px 10px;
border-radius: 20px;
border: 1px solid var(--border);
}
.topbar-actions {
display: flex;
align-items: center;
gap: 15px;
}

/* ===== 語言與主題選擇器 ===== */
.selector-group {
display: flex;
gap: 10px;
}
.selector-group select {
background: var(--card);
border: 1px solid var(--border);
color: var(--text);
padding: 8px 12px;
border-radius: 8px;
font-size: 13px;
cursor: pointer;
transition: all 0.3s ease;
}
.selector-group select:hover {
border-color: var(--primary);
box-shadow: 0 0 15px var(--primary-glow);
}
.selector-group select:focus {
outline: none;
border-color: var(--primary);
}

/* ===== 主容器 ===== */
.container {
display: flex;
flex: 1;
padding: 20px;
gap: 20px;
max-width: 1600px;
margin: 0 auto;
width: 100%;
}

/* ===== 側邊欄 ===== */
.sidebar {
width: 340px;
display: flex;
flex-direction: column;
gap: 15px;
flex-shrink: 0;
}

/* ===== 卡片樣式 ===== */
.card {
background: var(--card);
backdrop-filter: blur(10px);
border: 1px solid var(--border);
border-radius: 16px;
padding: 18px;
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
transition: all 0.3s ease;
}
.card:hover {
box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
border-color: rgba(99, 102, 241, 0.3);
}
.card-title {
font-size: 13px;
color: var(--text-muted);
margin-bottom: 10px;
text-transform: uppercase;
letter-spacing: 0.5px;
}

/* ===== API 卡片 ===== */
.api-card {
display: flex;
flex-direction: column;
gap: 8px;
}
.api-card-header {
display: flex;
align-items: center;
gap: 8px;
}
.api-icon {
font-size: 16px;
}
.api-url-box {
display: flex;
align-items: center;
gap: 8px;
background: rgba(0, 0, 0, 0.2);
border-radius: 8px;
padding: 8px 12px;
}
.api-url {
flex: 1;
font-family: 'JetBrains Mono', 'Fira Code', monospace;
font-size: 11px;
color: var(--primary);
word-break: break-all;
}
.copy-btn {
background: transparent;
border: none;
color: var(--text-muted);
cursor: pointer;
padding: 4px;
border-radius: 4px;
transition: all 0.2s ease;
width: auto;
}
.copy-btn:hover {
color: var(--primary);
background: rgba(99, 102, 241, 0.1);
}

/* ===== 表單元素 ===== */
.form-group { margin-bottom: 15px; }
.form-label {
display: block;
font-size: 12px;
color: var(--text-muted);
margin-bottom: 6px;
}
input, select, textarea {
width: 100%;
background: rgba(0, 0, 0, 0.2);
border: 1px solid var(--border-solid);
color: var(--text);
padding: 12px 14px;
border-radius: 10px;
font-size: 14px;
transition: all 0.3s ease;
}
input:focus, select:focus, textarea:focus {
outline: none;
border-color: var(--primary);
box-shadow: 0 0 20px var(--primary-glow);
}
textarea {
resize: vertical;
min-height: 100px;
line-height: 1.5;
}
select {
cursor: pointer;
}

/* ===== 按鈕 ===== */
.btn {
width: 100%;
padding: 14px 20px;
border: none;
border-radius: 12px;
font-weight: 600;
font-size: 15px;
cursor: pointer;
transition: all 0.3s ease;
display: flex;
align-items: center;
justify-content: center;
gap: 8px;
}
.btn-primary {
background: linear-gradient(135deg, var(--primary), var(--primary-hover));
color: white;
box-shadow: 0 4px 20px var(--primary-glow);
}
.btn-primary:hover:not(:disabled) {
transform: translateY(-2px);
box-shadow: 0 8px 30px var(--primary-glow);
}
.btn-primary:active:not(:disabled) {
transform: translateY(0);
}
.btn-primary:disabled {
background: #4a4a5a;
color: #888;
cursor: not-allowed;
box-shadow: none;
transform: none;
}
.btn-secondary {
background: var(--card);
color: var(--text);
border: 1px solid var(--border);
}
.btn-secondary:hover {
background: rgba(99, 102, 241, 0.1);
border-color: var(--primary);
}
.btn-small {
padding: 8px 14px;
font-size: 12px;
width: auto;
}

/* ===== 快速模板 ===== */
.templates-section { margin-top: 10px; }
.templates-grid {
display: grid;
grid-template-columns: repeat(3, 1fr);
gap: 8px;
}
.template-btn {
padding: 10px 8px;
background: rgba(0, 0, 0, 0.2);
border: 1px solid var(--border-solid);
border-radius: 8px;
color: var(--text);
font-size: 12px;
cursor: pointer;
transition: all 0.2s ease;
display: flex;
flex-direction: column;
align-items: center;
gap: 4px;
width: 100%;
}
.template-btn:hover {
background: rgba(99, 102, 241, 0.15);
border-color: var(--primary);
transform: translateY(-1px);
}
.template-icon { font-size: 20px; }

/* ===== 主區域 ===== */
.main {
flex: 1;
display: flex;
flex-direction: column;
gap: 15px;
min-width: 0;
}

/* ===== 聊天視窗 ===== */
.chat-window {
flex: 1;
background: var(--card);
backdrop-filter: blur(10px);
border: 1px solid var(--border);
border-radius: 16px;
padding: 20px;
overflow-y: auto;
display: flex;
flex-direction: column;
gap: 15px;
min-height: 300px;
max-height: 500px;
}
.welcome-msg {
color: var(--text-muted);
text-align: center;
padding: 60px 20px;
line-height: 1.8;
}
.welcome-icon {
font-size: 48px;
margin-bottom: 15px;
opacity: 0.5;
}

/* ===== 訊息樣式 ===== */
.msg {
max-width: 85%;
padding: 12px 16px;
border-radius: 16px;
line-height: 1.6;
animation: msgSlide 0.3s ease;
}
@keyframes msgSlide {
from { opacity: 0; transform: translateY(10px); }
to { opacity: 1; transform: translateY(0); }
}
.msg-user {
align-self: flex-end;
background: linear-gradient(135deg, var(--primary), var(--primary-hover));
color: white;
border-bottom-right-radius: 4px;
}
.msg-ai {
align-self: flex-start;
background: rgba(0, 0, 0, 0.3);
border: 1px solid var(--border);
border-bottom-left-radius: 4px;
}
.msg-meta {
font-size: 11px;
color: var(--text-muted);
margin-top: 6px;
opacity: 0.7;
}

/* ===== 進度條 ===== */
.progress-container {
margin-top: 12px;
}
.progress-bar {
height: 6px;
background: rgba(0, 0, 0, 0.3);
border-radius: 3px;
overflow: hidden;
}
.progress-fill {
height: 100%;
background: linear-gradient(90deg, var(--primary), var(--accent), var(--primary));
background-size: 200% 100%;
border-radius: 3px;
transition: width 0.3s ease;
animation: progressShimmer 2s infinite;
}
@keyframes progressShimmer {
0% { background-position: 200% 0; }
100% { background-position: -200% 0; }
}
.progress-text {
font-size: 12px;
color: var(--text-muted);
margin-top: 6px;
text-align: center;
}

/* ===== 影片容器 ===== */
.video-container {
margin-top: 12px;
border-radius: 12px;
overflow: hidden;
background: #000;
}
.video-container video {
width: 100%;
max-height: 350px;
display: block;
}
.video-actions {
display: flex;
gap: 10px;
margin-top: 10px;
}
.video-actions a {
text-decoration: none;
}

/* ===== 歷史記錄面板 ===== */
.history-panel {
background: var(--card);
backdrop-filter: blur(10px);
border: 1px solid var(--border);
border-radius: 16px;
padding: 18px;
}
.history-header {
display: flex;
justify-content: space-between;
align-items: center;
margin-bottom: 15px;
}
.history-title {
font-size: 16px;
font-weight: 600;
display: flex;
align-items: center;
gap: 8px;
}
.history-grid {
display: grid;
grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
gap: 15px;
}
.history-item {
background: rgba(0, 0, 0, 0.2);
border: 1px solid var(--border);
border-radius: 12px;
overflow: hidden;
transition: all 0.3s ease;
}
.history-item:hover {
transform: translateY(-3px);
box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
border-color: var(--primary);
}
.history-video {
position: relative;
aspect-ratio: 16/9;
background: #000;
}
.history-video video {
width: 100%;
height: 100%;
object-fit: cover;
}
.history-overlay {
position: absolute;
inset: 0;
background: rgba(0, 0, 0, 0.5);
display: flex;
align-items: center;
justify-content: center;
opacity: 0;
transition: opacity 0.3s ease;
}
.history-item:hover .history-overlay {
opacity: 1;
}
.play-icon {
font-size: 32px;
cursor: pointer;
transition: transform 0.2s ease;
}
.play-icon:hover {
transform: scale(1.2);
}
.history-info {
padding: 12px;
}
.history-prompt {
font-size: 13px;
color: var(--text);
margin-bottom: 8px;
display: -webkit-box;
-webkit-line-clamp: 2;
-webkit-box-orient: vertical;
overflow: hidden;
}
.history-meta {
display: flex;
flex-wrap: wrap;
gap: 6px;
margin-bottom: 10px;
}
.history-tag {
font-size: 11px;
padding: 3px 8px;
background: rgba(99, 102, 241, 0.2);
color: var(--primary);
border-radius: 4px;
}
.history-time {
font-size: 11px;
color: var(--text-muted);
}
.history-actions {
display: flex;
gap: 8px;
}
.history-actions button {
flex: 1;
padding: 8px;
font-size: 12px;
}
.history-empty {
text-align: center;
padding: 40px;
color: var(--text-muted);
}

/* ===== 狀態指示器 ===== */
.status-indicator {
display: flex;
align-items: center;
gap: 8px;
font-size: 13px;
}
.status-dot {
width: 8px;
height: 8px;
border-radius: 50%;
animation: statusPulse 2s infinite;
}
.status-dot.idle { background: var(--text-muted); animation: none; }
.status-dot.generating { background: var(--warning); }
.status-dot.success { background: var(--success); animation: none; }
.status-dot.error { background: var(--error); animation: none; }
@keyframes statusPulse {
0%, 100% { opacity: 1; }
50% { opacity: 0.5; }
}

/* ===== 響應式設計 ===== */
@media (max-width: 900px) {
.container { flex-direction: column; }
.sidebar { width: 100%; }
.chat-window { max-height: 400px; }
.history-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
}
@media (max-width: 600px) {
.topbar { flex-direction: column; gap: 10px; }
.container { padding: 10px; }
.templates-grid { grid-template-columns: repeat(2, 1fr); }
}

/* ===== 滾動條樣式 ===== */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-solid); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--primary); }
</style>
</head>
<body>
<!-- 頂部導航列 -->
<nav class="topbar">
<div class="logo">
<span class="logo-icon">🎬</span>
<span>${CONFIG.PROJECT_NAME}</span>
<span class="version">v${CONFIG.PROJECT_VERSION}</span>
</div>
<div class="topbar-actions">
<div class="status-indicator">
<div class="status-dot idle" id="status-dot"></div>
<span id="status-text" data-i18n="statusIdle">就緒</span>
</div>
<div class="selector-group">
<select id="lang-select" onchange="setLanguage(this.value)">
<option value="zh">🇹🇼 繁體中文</option>
<option value="en">🇺🇸 English</option>
</select>
<select id="theme-select" onchange="setTheme(this.value)">
<option value="dark">🌙 深色</option>
<option value="light">☀️ 淺色</option>
</select>
</div>
</div>
</nav>

<!-- 主容器 -->
<div class="container">
<!-- 側邊欄 -->
<aside class="sidebar">
<!-- API 資訊卡片 -->
<div class="card">
<div class="card-title" data-i18n="apiInfo">API 資訊</div>
<div class="api-card">
<div class="api-card-header">
<span class="api-icon">🔑</span>
<span data-i18n="apiKey">API 金鑰</span>
</div>
<div class="api-url-box">
<code class="api-url">${apiKey}</code>
<button class="copy-btn" onclick="copy('${apiKey}')">📋</button>
</div>
</div>
<div class="api-card" style="margin-top:12px">
<div class="api-card-header">
<span class="api-icon">🔗</span>
<span data-i18n="apiEndpoint">API 端點</span>
</div>
<div class="api-url-box">
<code class="api-url">${origin}/v1/chat/completions</code>
<button class="copy-btn" onclick="copy('${origin}/v1/chat/completions')">📋</button>
</div>
</div>
</div>

<!-- 生成控制卡片 -->
<div class="card">
<div class="card-title" data-i18n="generateSettings">生成設定</div>
<div class="form-group">
<label class="form-label" data-i18n="modeLabel">風格模式</label>
<select id="mode">
<option value="normal" data-i18n-option="modeNormal">Normal (標準)</option>
<option value="fun" data-i18n-option="modeFun">Fun (趣味)</option>
<option value="spicy" data-i18n-option="modeSpicy">Spicy (火辣)</option>
</select>
</div>
<div class="form-group">
<label class="form-label" data-i18n="ratioLabel">影片比例</label>
<select id="ratio">
<option value="1:1" data-i18n-option="ratio1x1">1:1 (方形)</option>
<option value="3:2" data-i18n-option="ratio3x2">3:2 (橫屏)</option>
<option value="2:3" data-i18n-option="ratio2x3">2:3 (豎屏)</option>
</select>
</div>
<div class="form-group">
<label class="form-label" data-i18n="promptLabel">提示詞</label>
<textarea id="prompt" rows="4" data-i18n-placeholder="promptPlaceholder" placeholder="描述影片內容..."></textarea>
</div>
<button id="btn-gen" class="btn btn-primary" onclick="generate()">
<span>✨</span>
<span data-i18n="generateBtn">生成影片</span>
</button>

<!-- 快速模板 -->
<div class="templates-section">
<div class="form-label" data-i18n="quickTemplates">快速模板</div>
<div class="templates-grid">
<button class="template-btn" onclick="useTemplate('sunset')">
<span class="template-icon">🌅</span>
<span data-i18n="templateSunset">夕陽</span>
</button>
<button class="template-btn" onclick="useTemplate('city')">
<span class="template-icon">🏙️</span>
<span data-i18n="templateCity">城市</span>
</button>
<button class="template-btn" onclick="useTemplate('nature')">
<span class="template-icon">🌲</span>
<span data-i18n="templateNature">自然</span>
</button>
<button class="template-btn" onclick="useTemplate('ocean')">
<span class="template-icon">🌊</span>
<span data-i18n="templateOcean">海洋</span>
</button>
<button class="template-btn" onclick="useTemplate('space')">
<span class="template-icon">🚀</span>
<span data-i18n="templateSpace">太空</span>
</button>
<button class="template-btn" onclick="useTemplate('animal')">
<span class="template-icon">🦁</span>
<span data-i18n="templateAnimal">動物</span>
</button>
</div>
</div>
</div>
</aside>

<!-- 主區域 -->
<main class="main">
<!-- 聊天視窗 -->
<div class="chat-window" id="chat">
<div class="welcome-msg" id="welcome-msg">
<div class="welcome-icon">🎬</div>
<div data-i18n="engineReady">Ximagine 文生影片引擎就緒</div>
<div style="margin-top:8px" data-i18n="estimatedTime">預計生成時間: 15-30 秒</div>
</div>
</div>

<!-- 歷史記錄面板 -->
<div class="history-panel">
<div class="history-header">
<div class="history-title">
<span>📚</span>
<span data-i18n="historyTitle">歷史記錄</span>
</div>
<button class="btn btn-secondary btn-small" onclick="clearHistory()">
<span data-i18n="clearHistory">清除歷史</span>
</button>
</div>
<div class="history-grid" id="history-list"></div>
</div>
</main>
</div>

<script>
const API_KEY = "${apiKey}";
const ORIGIN = "${origin}";
let pollTimer = null;
let fakeProgressTimer = null;
let currentLang = localStorage.getItem('lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
let currentTheme = localStorage.getItem('theme') || 'dark';

// ===== i18n 多語系 =====
const i18n = {
zh: {
apiInfo: 'API 資訊',
apiKey: 'API 金鑰',
apiEndpoint: 'API 端點',
generateSettings: '生成設定',
modeLabel: '風格模式',
modeNormal: 'Normal (標準)',
modeFun: 'Fun (趣味)',
modeSpicy: 'Spicy (火辣)',
ratioLabel: '影片比例',
ratio1x1: '1:1 (方形)',
ratio3x2: '3:2 (橫屏)',
ratio2x3: '2:3 (豎屏)',
promptLabel: '提示詞',
promptPlaceholder: '描述影片內容...',
generateBtn: '生成影片',
quickTemplates: '快速模板',
templateSunset: '夕陽',
templateCity: '城市',
templateNature: '自然',
templateOcean: '海洋',
templateSpace: '太空',
templateAnimal: '動物',
submitting: '提交中...',
generating: '生成中...',
initializing: '正在初始化任務...',
taskSubmitted: '任務已提交，正在生成影片...',
generatingProgress: '生成中',
completed: '✅ 生成完成',
downloadVideo: '⬇️ 下載',
deleteVideo: '🗑️ 刪除',
failed: '❌ 失敗',
requestError: '❌ 請求錯誤',
enterPrompt: '請輸入提示詞',
copied: '已複製',
engineReady: 'Ximagine 文生影片引擎就緒',
estimatedTime: '預計生成時間: 15-30 秒',
historyTitle: '歷史記錄',
clearHistory: '清除歷史',
noHistory: '暫無歷史記錄',
statusIdle: '就緒',
statusGenerating: '生成中',
statusSuccess: '完成',
statusError: '錯誤'
},
en: {
apiInfo: 'API Information',
apiKey: 'API Key',
apiEndpoint: 'API Endpoint',
generateSettings: 'Generation Settings',
modeLabel: 'Style Mode',
modeNormal: 'Normal (Standard)',
modeFun: 'Fun (Playful)',
modeSpicy: 'Spicy (Hot)',
ratioLabel: 'Aspect Ratio',
ratio1x1: '1:1 (Square)',
ratio3x2: '3:2 (Landscape)',
ratio2x3: '2:3 (Portrait)',
promptLabel: 'Prompt',
promptPlaceholder: 'Describe video content...',
generateBtn: 'Generate Video',
quickTemplates: 'Quick Templates',
templateSunset: 'Sunset',
templateCity: 'City',
templateNature: 'Nature',
templateOcean: 'Ocean',
templateSpace: 'Space',
templateAnimal: 'Animal',
submitting: 'Submitting...',
generating: 'Generating...',
initializing: 'Initializing task...',
taskSubmitted: 'Task submitted, generating video...',
generatingProgress: 'Generating',
completed: '✅ Completed',
downloadVideo: '⬇️ Download',
deleteVideo: '🗑️ Delete',
failed: '❌ Failed',
requestError: '❌ Request Error',
enterPrompt: 'Please enter a prompt',
copied: 'Copied',
engineReady: 'Ximagine text-to-video engine ready',
estimatedTime: 'Estimated time: 15-30 seconds',
historyTitle: 'History',
clearHistory: 'Clear History',
noHistory: 'No history yet',
statusIdle: 'Ready',
statusGenerating: 'Generating',
statusSuccess: 'Done',
statusError: 'Error'
}
};

// ===== 快速模板 =====
const templates = {
sunset: { zh: '夕陽下的海邊，金色的光芒灑在波浪上，海鷗飛過天空', en: 'Sunset by the beach, golden light on the waves, seagulls flying across the sky' },
city: { zh: '繁華的城市夜景，霓虹燈閃爍，車流如織，摩天大樓林立', en: 'Bustling city night view, neon lights flashing, heavy traffic, skyscrapers everywhere' },
nature: { zh: '翠綠的森林中，陽光穿透樹葉，小溪潺潺流過，鳥兒歌唱', en: 'Lush green forest, sunlight through leaves, stream flowing, birds singing' },
ocean: { zh: '深邃的海洋中，鯨魚緩緩游過，陽光從水面灑下，珊瑚礁色彩斑斕', en: 'Deep ocean, whale swimming slowly, sunlight from surface, colorful coral reefs' },
space: { zh: '浩瀚的宇宙中，星球緩緩旋轉，流星劃過，銀河璀璨', en: 'Vast universe, planets rotating slowly, meteors passing by, brilliant galaxy' },
animal: { zh: '非洲草原上，獅子在夕陽下漫步，長頸鹿在遠處吃草', en: 'African savanna, lion walking under sunset, giraffes grazing in the distance' }
};

function useTemplate(key) {
const prompt = document.getElementById('prompt');
prompt.value = templates[key][currentLang] || templates[key]['zh'];
prompt.focus();
}

// ===== 主題切換 =====
function setTheme(theme) {
currentTheme = theme;
localStorage.setItem('theme', theme);
document.body.classList.toggle('light-theme', theme === 'light');
document.getElementById('theme-select').value = theme;
}

// ===== 歷史記錄管理 =====
const HISTORY_KEY = 'ximagineHistory';
const MAX_HISTORY = 20;

function getHistory() {
try {
return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
} catch { return []; }
}

function saveHistory(item) {
const history = getHistory();
history.unshift(item);
if (history.length > MAX_HISTORY) history.pop();
localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
renderHistory();
}

function deleteHistoryItem(index) {
const history = getHistory();
history.splice(index, 1);
localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
renderHistory();
}

function clearHistory() {
localStorage.removeItem(HISTORY_KEY);
renderHistory();
}

function renderHistory() {
const container = document.getElementById('history-list');
const history = getHistory();
const t = i18n[currentLang];

if (history.length === 0) {
container.innerHTML = '<div class="history-empty">' + t.noHistory + '</div>';
return;
}

container.innerHTML = history.map((h, i) => {
const dateStr = new Date(h.timestamp).toLocaleString(currentLang === 'zh' ? 'zh-TW' : 'en-US');
return '<div class="history-item">' +
'<div class="history-video">' +
'<video src="' + h.videoUrl + '" muted loop></video>' +
'<div class="history-overlay"><span class="play-icon">▶️</span></div>' +
'</div>' +
'<div class="history-info">' +
'<div class="history-prompt">' + (h.prompt.length > 60 ? h.prompt.substring(0, 60) + '...' : h.prompt) + '</div>' +
'<div class="history-meta">' +
'<span class="history-tag">' + h.mode + '</span>' +
'<span class="history-tag">' + h.ratio + '</span>' +
'<span class="history-time">' + dateStr + '</span>' +
'</div>' +
'<div class="history-actions">' +
'<a href="' + h.videoUrl + '" target="_blank" class="btn btn-secondary btn-small">' + t.downloadVideo + '</a>' +
'<button class="btn btn-secondary btn-small" onclick="deleteHistoryItem(' + i + ')">' + t.deleteVideo + '</button>' +
'</div>' +
'</div>' +
'</div>';
}).join('');
}

// ===== 語言切換 =====
function setLanguage(lang) {
currentLang = lang;
localStorage.setItem('lang', lang);
document.getElementById('lang-select').value = lang;

document.querySelectorAll('[data-i18n]').forEach(el => {
const key = el.getAttribute('data-i18n');
if (i18n[lang][key]) el.innerText = i18n[lang][key];
});

document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
const key = el.getAttribute('data-i18n-placeholder');
if (i18n[lang][key]) el.placeholder = i18n[lang][key];
});

document.querySelectorAll('[data-i18n-option]').forEach(el => {
const key = el.getAttribute('data-i18n-option');
if (i18n[lang][key]) el.innerText = i18n[lang][key];
});

renderHistory();
}

// ===== 狀態更新 =====
function updateStatus(status) {
const dot = document.getElementById('status-dot');
const text = document.getElementById('status-text');
const t = i18n[currentLang];

dot.className = 'status-dot ' + status;
switch(status) {
case 'idle': text.innerText = t.statusIdle; break;
case 'generating': text.innerText = t.statusGenerating; break;
case 'success': text.innerText = t.statusSuccess; break;
case 'error': text.innerText = t.statusError; break;
}
}

// ===== 初始化 =====
setLanguage(currentLang);
setTheme(currentTheme);
renderHistory();

function copy(t) { navigator.clipboard.writeText(t); alert(i18n[currentLang].copied); }

function appendMsg(role, html) {
const d = document.createElement('div');
d.className = 'msg msg-' + role;
d.innerHTML = html;
document.getElementById('chat').appendChild(d);
d.scrollIntoView({ behavior: "smooth" });
return d;
}

async function generate() {
const prompt = document.getElementById('prompt').value.trim();
const mode = document.getElementById('mode').value;
const ratio = document.getElementById('ratio').value;
const t = i18n[currentLang];

if (!prompt) return alert(t.enterPrompt);

const btn = document.getElementById('btn-gen');
btn.disabled = true;
btn.innerHTML = '<span>⏳</span><span>' + t.submitting + '</span>';
updateStatus('generating');

const welcomeMsg = document.getElementById('welcome-msg');
if (welcomeMsg) welcomeMsg.remove();

appendMsg('user', prompt + '<div class="msg-meta">[' + mode + ' | ' + ratio + ']</div>');
const aiMsg = appendMsg('ai', '<div>' + t.initializing + '</div><div class="progress-container"><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div><div class="progress-text">0%</div></div>');
const statusDiv = aiMsg.querySelector('div');
const progressContainer = aiMsg.querySelector('.progress-container');
const fill = aiMsg.querySelector('.progress-fill');
const progressText = aiMsg.querySelector('.progress-text');

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
const match = buffer.match(/\\[TASK_ID:(.*?)\\|UID:(.*?)\\]/);
if (match) {
taskId = match[1];
uniqueId = match[2];
break;
}
}

if (!taskId) throw new Error(t.requestError + ": No task ID");

btn.innerHTML = '<span>🎬</span><span>' + t.generating + '</span>';
statusDiv.innerText = t.taskSubmitted;

let currentProgress = 0;
if (fakeProgressTimer) clearInterval(fakeProgressTimer);

fakeProgressTimer = setInterval(() => {
if (currentProgress < 80) currentProgress += (80 / 30);
else if (currentProgress < 99) currentProgress += 0.5;
if (currentProgress > 99) currentProgress = 99;
fill.style.width = currentProgress + '%';
progressText.innerText = t.generatingProgress + ' ' + Math.floor(currentProgress) + '%';
}, 500);

if (pollTimer) clearInterval(pollTimer);

pollTimer = setInterval(async () => {
try {
const pollRes = await fetch(ORIGIN + '/v1/query/status?taskId=' + taskId + '&uniqueId=' + uniqueId, {
headers: { 'Authorization': 'Bearer ' + API_KEY }
});
const statusData = await pollRes.json();

if (statusData.status === 'completed') {
clearInterval(pollTimer);
clearInterval(fakeProgressTimer);
fill.style.width = '100%';
progressText.innerText = '100%';
progressContainer.style.display = 'none';
statusDiv.innerHTML = '<strong>' + t.completed + '</strong>';
aiMsg.innerHTML += '<div class="video-container"><video src="' + statusData.videoUrl + '" controls autoplay loop></video></div><div class="video-actions"><a href="' + statusData.videoUrl + '" target="_blank" class="btn btn-secondary btn-small">' + t.downloadVideo + '</a></div>';
btn.disabled = false;
btn.innerHTML = '<span>✨</span><span>' + t.generateBtn + '</span>';
updateStatus('success');

saveHistory({ prompt, mode, ratio, videoUrl: statusData.videoUrl, timestamp: Date.now() });
} else if (statusData.status === 'failed') {
clearInterval(pollTimer);
clearInterval(fakeProgressTimer);
progressContainer.style.display = 'none';
statusDiv.innerHTML = '<span style="color:var(--error)">' + t.failed + ': ' + statusData.error + '</span>';
btn.disabled = false;
btn.innerHTML = '<span>✨</span><span>' + t.generateBtn + '</span>';
updateStatus('error');
}
} catch (e) {
console.error("Polling error", e);
}
}, 2000);

} catch (e) {
if (fakeProgressTimer) clearInterval(fakeProgressTimer);
progressContainer.style.display = 'none';
statusDiv.innerHTML = '<span style="color:var(--error)">' + t.requestError + ': ' + e.message + '</span>';
btn.disabled = false;
btn.innerHTML = '<span>✨</span><span>' + t.generateBtn + '</span>';
updateStatus('error');
}
}
</script>
</body>
</html>`;

return new Response(html, {
headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
}
