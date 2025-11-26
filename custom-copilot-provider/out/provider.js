"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomModelProvider = void 0;
const https = __importStar(require("https"));
const node_url_1 = require("node:url");
const vscode = __importStar(require("vscode"));
const DEFAULT_SYSTEM_PROMPT = 'You are a GitHub Copilot chat provider running inside VS Code. Always preserve code formatting and prefer tool calls when they produce more accurate answers.';
const DEFAULT_REASONING_FLUSH_INTERVAL = 80;
const MAX_EMBEDDED_BASE64 = 120_000;
const REASONING_STREAM_ID = 'custom_reasoning';
const MODEL_DEFINITIONS = {
    kimi: {
        key: 'kimi',
        label: 'Moonshot / Kimi',
        secretKey: 'customCopilotProvider.apiKey.kimi',
        defaults: {
            enabled: true,
            modelId: 'kimi-k2-thinking',
            apiModelId: 'kimi-k2-thinking',
            displayName: 'Moonshot Thinking Model',
            detail: 'Powered by kimi-k2-thinking',
            family: 'moonshot',
            tooltip: 'Streams reasoning traces and supports tool calls via Moonshot.',
            baseUrl: 'https://api.moonshot.cn/v1',
            maxInputTokens: 200_000,
            maxOutputTokens: 16_000,
            temperature: 1,
            reasoningCharLimit: 15_000,
            supportsReasoning: true
        }
    },
    deepseek: {
        key: 'deepseek',
        label: 'DeepSeek',
        secretKey: 'customCopilotProvider.apiKey.deepseek',
        defaults: {
            enabled: true,
            modelId: 'deepseek-reasoner',
            apiModelId: 'deepseek-reasoner',
            displayName: 'DeepSeek Reasoner',
            detail: 'DeepSeek-V3.2-Exp (thinking mode)',
            family: 'deepseek',
            tooltip: 'Reasoning-first DeepSeek API with tool calling support.',
            baseUrl: 'https://api.deepseek.com/v1',
            maxInputTokens: 200_000,
            maxOutputTokens: 32_000,
            temperature: 0.7,
            reasoningCharLimit: 15_000,
            supportsReasoning: true
        }
    }
};
const SUPPORTED_VENDORS = ['kimi', 'deepseek'];
class CustomModelProvider {
    context;
    registeredModels = new Map();
    constructor(context) {
        this.context = context;
    }
    async promptForApiKey(target) {
        const vendor = target ?? await this.pickVendor('Select a provider to configure its API key');
        if (!vendor) {
            return;
        }
        const definition = MODEL_DEFINITIONS[vendor];
        const settings = this.readModelSettings(vendor);
        const existing = await this.context.secrets.get(definition.secretKey);
        const value = await vscode.window.showInputBox({
            title: `Enter ${settings.displayName} API Key`,
            prompt: 'Keys are stored securely in VS Code Secret Storage for this profile.',
            password: true,
            ignoreFocusOut: true,
            value: existing ?? ''
        });
        if (value === undefined) {
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            await this.context.secrets.delete(definition.secretKey);
            void vscode.window.showInformationMessage(`${settings.displayName} API key cleared.`);
            return;
        }
        await this.context.secrets.store(definition.secretKey, trimmed);
        void vscode.window.showInformationMessage(`${settings.displayName} API key saved.`);
    }
    async provideLanguageModelChatInformation(_options) {
        const infos = [];
        this.registeredModels.clear();
        for (const vendor of SUPPORTED_VENDORS) {
            const settings = this.readModelSettings(vendor);
            if (!settings.enabled) {
                continue;
            }
            const info = this.toChatInformation(settings);
            this.registeredModels.set(info.id, { vendor, settings });
            infos.push(info);
        }
        return infos;
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const backend = this.resolveModel(model.id);
        if (!backend) {
            throw new Error(`Model ${model.id} is not managed by the Custom Copilot Provider.`);
        }
        const apiKey = await this.ensureApiKey(backend.vendor, true);
        if (!apiKey) {
            throw new Error(`No API key configured for ${backend.settings.displayName}. Run "Manage API Keys" first.`);
        }
        if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
            throw new Error(`${backend.settings.displayName} does not support forcing a tool call on every response.`);
        }
        const messagesPayload = this.convertMessages(messages);
        const toolsPayload = this.convertTools(options.tools);
        const temperatureOverride = options.modelOptions?.temperature;
        const maxTokensOverride = options.modelOptions;
        const requestedMaxTokens = maxTokensOverride?.maxTokens ?? maxTokensOverride?.max_tokens;
        const maxTokens = typeof requestedMaxTokens === 'number'
            ? Math.min(Math.max(requestedMaxTokens, 1), backend.settings.maxOutputTokens)
            : backend.settings.maxOutputTokens;
        const payload = {
            model: backend.settings.apiModelId,
            messages: messagesPayload,
            stream: true,
            temperature: typeof temperatureOverride === 'number' ? temperatureOverride : backend.settings.temperature,
            max_tokens: maxTokens
        };
        if (toolsPayload) {
            payload.tools = toolsPayload;
        }
        const flushInterval = this.getReasoningFlushInterval();
        await this.streamOpenAIResponse(backend, apiKey, payload, progress, token, flushInterval);
    }
    async provideTokenCount(_model, text) {
        const content = typeof text === 'string' ? text : this.flattenMessage(text);
        return Math.ceil(content.length / 4);
    }
    async pickVendor(placeHolder) {
        const choices = SUPPORTED_VENDORS.map(vendor => {
            const settings = this.readModelSettings(vendor);
            return {
                label: settings.displayName,
                description: settings.detail,
                vendor
            };
        });
        const selection = await vscode.window.showQuickPick(choices, { placeHolder });
        return selection?.vendor;
    }
    readModelSettings(vendor) {
        const definition = MODEL_DEFINITIONS[vendor];
        const config = vscode.workspace.getConfiguration('customCopilotProvider');
        const get = (suffix, fallback) => config.get(`${vendor}.${suffix}`, fallback);
        return {
            enabled: get('enabled', definition.defaults.enabled),
            modelId: get('modelId', definition.defaults.modelId),
            apiModelId: get('apiModelId', definition.defaults.apiModelId),
            displayName: get('displayName', definition.defaults.displayName),
            detail: get('detail', definition.defaults.detail),
            family: get('family', definition.defaults.family),
            tooltip: get('tooltip', definition.defaults.tooltip),
            baseUrl: get('baseUrl', definition.defaults.baseUrl),
            maxInputTokens: get('maxInputTokens', definition.defaults.maxInputTokens),
            maxOutputTokens: get('maxOutputTokens', definition.defaults.maxOutputTokens),
            temperature: get('temperature', definition.defaults.temperature),
            reasoningCharLimit: get('reasoningCharLimit', definition.defaults.reasoningCharLimit),
            supportsReasoning: get('supportsReasoning', definition.defaults.supportsReasoning)
        };
    }
    toChatInformation(settings) {
        return {
            id: settings.modelId,
            name: settings.displayName,
            detail: settings.detail,
            family: settings.family,
            tooltip: settings.tooltip,
            version: '2025-11-26',
            maxInputTokens: settings.maxInputTokens,
            maxOutputTokens: settings.maxOutputTokens,
            capabilities: {
                toolCalling: true,
                imageInput: false
            }
        };
    }
    resolveModel(modelId) {
        const cached = this.registeredModels.get(modelId);
        if (cached) {
            return cached;
        }
        for (const vendor of SUPPORTED_VENDORS) {
            const settings = this.readModelSettings(vendor);
            if (settings.enabled && settings.modelId === modelId) {
                const registered = { vendor, settings };
                this.registeredModels.set(modelId, registered);
                return registered;
            }
        }
        return undefined;
    }
    async ensureApiKey(vendor, allowPrompt) {
        const definition = MODEL_DEFINITIONS[vendor];
        const existing = await this.context.secrets.get(definition.secretKey);
        if (existing) {
            return existing;
        }
        if (!allowPrompt) {
            return undefined;
        }
        await this.promptForApiKey(vendor);
        return this.context.secrets.get(definition.secretKey);
    }
    getSystemPrompt() {
        return vscode.workspace
            .getConfiguration('customCopilotProvider')
            .get('systemPrompt', DEFAULT_SYSTEM_PROMPT);
    }
    getReasoningFlushInterval() {
        return vscode.workspace
            .getConfiguration('customCopilotProvider')
            .get('reasoningFlushInterval', DEFAULT_REASONING_FLUSH_INTERVAL);
    }
    convertMessages(messages) {
        const systemPrompt = this.getSystemPrompt().trim();
        const chat = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
        for (const message of messages) {
            if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
                const textPieces = [];
                const toolCalls = [];
                for (const part of message.content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        textPieces.push(part.value);
                    }
                    else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push({
                            id: part.callId,
                            type: 'function',
                            function: {
                                name: part.name,
                                arguments: JSON.stringify(part.input ?? {})
                            }
                        });
                    }
                    else if (part instanceof vscode.LanguageModelDataPart) {
                        textPieces.push(this.serializeDataPart(part));
                    }
                }
                const assistantPayload = { role: 'assistant' };
                const textPayload = textPieces.join('');
                if (textPayload) {
                    assistantPayload.content = textPayload;
                }
                if (toolCalls.length > 0) {
                    assistantPayload.tool_calls = toolCalls;
                }
                if (assistantPayload.content || assistantPayload.tool_calls) {
                    chat.push(assistantPayload);
                }
            }
            else {
                const textPieces = [];
                const toolResults = [];
                for (const part of message.content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        textPieces.push(part.value);
                    }
                    else if (part instanceof vscode.LanguageModelToolResultPart) {
                        let toolText = '';
                        for (const inner of part.content) {
                            if (inner instanceof vscode.LanguageModelTextPart) {
                                toolText += inner.value;
                            }
                            else if (inner instanceof vscode.LanguageModelDataPart) {
                                toolText += this.serializeDataPart(inner);
                            }
                        }
                        toolResults.push({
                            role: 'tool',
                            content: toolText,
                            tool_call_id: part.callId
                        });
                    }
                    else if (part instanceof vscode.LanguageModelDataPart) {
                        textPieces.push(this.serializeDataPart(part));
                    }
                }
                const userText = textPieces.join('');
                if (userText) {
                    chat.push({ role: 'user', content: userText, name: message.name });
                }
                for (const result of toolResults) {
                    chat.push(result);
                }
            }
        }
        return chat;
    }
    convertTools(tools) {
        if (!tools || tools.length === 0) {
            return undefined;
        }
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema ?? { type: 'object', properties: {} }
            }
        }));
    }
    flattenMessage(message) {
        let flattened = '';
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                flattened += part.value;
            }
        }
        return flattened;
    }
    serializeDataPart(part) {
        const base64 = Buffer.from(part.data).toString('base64');
        if (base64.length <= MAX_EMBEDDED_BASE64) {
            return `data:${part.mimeType};base64,${base64}`;
        }
        const truncated = base64.slice(0, MAX_EMBEDDED_BASE64);
        return `data:${part.mimeType};base64,${truncated}... (truncated, original ${part.data.byteLength} bytes)`;
    }
    async streamOpenAIResponse(backend, apiKey, payload, progress, token, flushIntervalMs) {
        const endpoint = this.buildEndpoint(backend.settings.baseUrl, 'chat/completions');
        const reasoningLimit = Math.max(0, backend.settings.reasoningCharLimit);
        const enableReasoning = backend.settings.supportsReasoning && reasoningLimit > 0;
        const reasoningSessionId = `${backend.settings.modelId}-${Date.now()}`;
        let previousReasoningSnapshot = '';
        let pendingReasoning = '';
        let reasoningFlushTimer;
        let lastReasoningFlush = Date.now();
        let reasoningTotalChars = 0;
        let truncationNoticeSent = false;
        let thinkingStarted = false;
        let thinkingCompleted = false;
        let reasoningAnnounced = false;
        const clearReasoningTimer = () => {
            if (reasoningFlushTimer) {
                clearTimeout(reasoningFlushTimer);
                reasoningFlushTimer = undefined;
            }
        };
        const announceReasoning = () => {
            if (!enableReasoning || reasoningAnnounced) {
                return;
            }
            reasoningAnnounced = true;
            this.reportThinkingPart(progress, '', {
                vscode_reasoning: true,
                vscode_reasoning_id: reasoningSessionId,
                model: backend.settings.displayName
            });
        };
        const flushReasoning = (metadata) => {
            if (!enableReasoning) {
                return;
            }
            if (pendingReasoning) {
                announceReasoning();
                this.reportThinkingPart(progress, pendingReasoning, metadata);
                pendingReasoning = '';
                lastReasoningFlush = Date.now();
                return;
            }
            if (metadata) {
                announceReasoning();
                this.reportThinkingPart(progress, '', metadata);
            }
        };
        const scheduleReasoningFlush = () => {
            if (!enableReasoning || !pendingReasoning) {
                return;
            }
            const elapsed = Date.now() - lastReasoningFlush;
            if (elapsed >= flushIntervalMs) {
                flushReasoning();
                return;
            }
            if (reasoningFlushTimer) {
                return;
            }
            const delay = Math.max(flushIntervalMs - elapsed, 0);
            reasoningFlushTimer = setTimeout(() => {
                reasoningFlushTimer = undefined;
                flushReasoning();
            }, delay);
        };
        const notifyTruncation = () => {
            if (!enableReasoning || truncationNoticeSent) {
                return;
            }
            truncationNoticeSent = true;
            announceReasoning();
            this.reportThinkingPart(progress, `\n[Reasoning truncated after ${reasoningLimit.toLocaleString()} characters]\n`, { vscode_reasoning_truncated: true });
        };
        const appendReasoningDelta = (delta) => {
            if (!enableReasoning || !delta) {
                return;
            }
            thinkingStarted = true;
            if (reasoningTotalChars >= reasoningLimit) {
                notifyTruncation();
                return;
            }
            const remaining = reasoningLimit - reasoningTotalChars;
            const usable = delta.slice(0, remaining);
            if (usable) {
                pendingReasoning += usable;
                reasoningTotalChars += usable.length;
                scheduleReasoningFlush();
            }
            if (delta.length > usable.length) {
                notifyTruncation();
            }
        };
        const finalizeReasoning = () => {
            if (!enableReasoning) {
                return;
            }
            clearReasoningTimer();
            if (thinkingStarted && !thinkingCompleted) {
                thinkingCompleted = true;
                flushReasoning({ vscode_reasoning_done: true });
            }
            else {
                flushReasoning();
            }
        };
        return new Promise((resolve, reject) => {
            let settled = false;
            const request = https.request(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${apiKey}`
                }
            }, (response) => {
                if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                        if (!settled) {
                            settled = true;
                            reject(new Error(`${backend.settings.displayName} API responded with status ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
                        }
                    });
                    return;
                }
                let buffer = '';
                const pendingToolCalls = new Map();
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    buffer += chunk;
                    const events = buffer.split('\n\n');
                    buffer = events.pop() ?? '';
                    for (const event of events) {
                        const dataLines = event
                            .split('\n')
                            .filter(line => line.startsWith('data:'))
                            .map(line => line.slice(5).trim());
                        if (dataLines.length === 0) {
                            continue;
                        }
                        const payloadString = dataLines.join('\n');
                        if (payloadString === '[DONE]') {
                            finalizeReasoning();
                            if (!settled) {
                                settled = true;
                                resolve();
                            }
                            return;
                        }
                        let parsed;
                        try {
                            parsed = JSON.parse(payloadString);
                        }
                        catch (error) {
                            if (!settled) {
                                settled = true;
                                reject(new Error(`Failed to parse streaming payload: ${error.message}`));
                            }
                            return;
                        }
                        const choice = parsed.choices?.[0];
                        if (!choice?.delta) {
                            continue;
                        }
                        if (choice.delta.reasoning_content) {
                            const reasoningChunk = choice.delta.reasoning_content;
                            if (reasoningChunk.startsWith(previousReasoningSnapshot)) {
                                appendReasoningDelta(reasoningChunk.slice(previousReasoningSnapshot.length));
                            }
                            else {
                                previousReasoningSnapshot = '';
                                appendReasoningDelta(reasoningChunk);
                            }
                            previousReasoningSnapshot = reasoningChunk;
                        }
                        if (!thinkingCompleted && thinkingStarted && choice.delta.content) {
                            finalizeReasoning();
                        }
                        if (choice.delta.content) {
                            flushReasoning();
                            progress.report(new vscode.LanguageModelTextPart(choice.delta.content));
                        }
                        if (choice.delta.tool_calls) {
                            for (const toolCallDelta of choice.delta.tool_calls) {
                                const current = pendingToolCalls.get(toolCallDelta.index) ?? { arguments: '' };
                                if (toolCallDelta.id) {
                                    current.id = toolCallDelta.id;
                                }
                                if (toolCallDelta.function?.name) {
                                    current.name = toolCallDelta.function.name;
                                }
                                if (toolCallDelta.function?.arguments) {
                                    current.arguments += toolCallDelta.function.arguments;
                                }
                                pendingToolCalls.set(toolCallDelta.index, current);
                            }
                        }
                        if (choice.finish_reason === 'tool_calls' && pendingToolCalls.size > 0) {
                            for (const call of pendingToolCalls.values()) {
                                if (!call.id || !call.name) {
                                    continue;
                                }
                                let parsedArgs = {};
                                const trimmed = call.arguments.trim();
                                if (trimmed) {
                                    try {
                                        parsedArgs = JSON.parse(trimmed);
                                    }
                                    catch (error) {
                                        pendingToolCalls.clear();
                                        if (!settled) {
                                            settled = true;
                                            reject(new Error(`Failed to parse tool call arguments: ${error.message}`));
                                        }
                                        return;
                                    }
                                }
                                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
                            }
                            pendingToolCalls.clear();
                        }
                        if (!thinkingCompleted && thinkingStarted && choice.finish_reason && choice.finish_reason !== 'tool_calls') {
                            finalizeReasoning();
                        }
                    }
                });
                response.on('end', () => {
                    finalizeReasoning();
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                });
                response.on('error', (err) => {
                    if (!settled) {
                        settled = true;
                        reject(err);
                    }
                });
            });
            request.on('error', error => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });
            request.write(JSON.stringify(payload));
            request.end();
            token.onCancellationRequested(() => {
                if (!settled) {
                    settled = true;
                    reject(new vscode.CancellationError());
                }
                finalizeReasoning();
                request.destroy();
                clearReasoningTimer();
            });
        });
    }
    reportThinkingPart(progress, chunk, metadata) {
        const extended = vscode;
        const ThinkingCtor = extended.LanguageModelThinkingPart;
        if (ThinkingCtor) {
            progress.report(new ThinkingCtor(chunk, REASONING_STREAM_ID, metadata));
            return;
        }
        if (chunk) {
            progress.report(new vscode.LanguageModelTextPart(chunk));
        }
    }
    buildEndpoint(baseUrl, resource) {
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        return new node_url_1.URL(resource, normalizedBase);
    }
}
exports.CustomModelProvider = CustomModelProvider;
//# sourceMappingURL=provider.js.map