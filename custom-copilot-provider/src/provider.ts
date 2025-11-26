import * as https from 'https';
import { IncomingMessage } from 'http';
import { URL } from 'node:url';
import * as vscode from 'vscode';

type VendorKey = 'kimi' | 'deepseek';

interface ModelSettings {
	enabled: boolean;
	modelId: string;
	apiModelId: string;
	displayName: string;
	detail: string;
	family: string;
	tooltip: string;
	baseUrl: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	temperature: number;
	reasoningCharLimit: number;
	supportsReasoning: boolean;
}

interface RegisteredModel {
	vendor: VendorKey;
	settings: ModelSettings;
}

interface ModelDefinition {
	key: VendorKey;
	label: string;
	secretKey: string;
	defaults: ModelSettings;
}

interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	name?: string;
	tool_call_id?: string;
	tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

interface ToolCallStreamDelta {
	index: number;
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface StreamChoice {
	delta?: {
		content?: string;
		reasoning_content?: string;
		tool_calls?: ToolCallStreamDelta[];
	};
	finish_reason?: string | null;
}

interface StreamResponseChunk {
	choices?: StreamChoice[];
}

interface PendingToolCall {
	id?: string;
	name?: string;
	arguments: string;
}

const DEFAULT_SYSTEM_PROMPT = 'You are a GitHub Copilot chat provider running inside VS Code. Always preserve code formatting and prefer tool calls when they produce more accurate answers.';
const DEFAULT_REASONING_FLUSH_INTERVAL = 80;
const MAX_EMBEDDED_BASE64 = 120_000;
const REASONING_STREAM_ID = 'custom_reasoning';

const MODEL_DEFINITIONS: Record<VendorKey, ModelDefinition> = {
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

const SUPPORTED_VENDORS: VendorKey[] = ['kimi', 'deepseek'];

export class CustomModelProvider implements vscode.LanguageModelChatProvider {
	private readonly registeredModels = new Map<string, RegisteredModel>();

	constructor(private readonly context: vscode.ExtensionContext) { }

	async promptForApiKey(target?: VendorKey): Promise<void> {
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

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
		const infos: vscode.LanguageModelChatInformation[] = [];
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

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
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
		const temperatureOverride = (options.modelOptions as { temperature?: number } | undefined)?.temperature;
		const maxTokensOverride = (options.modelOptions as { maxTokens?: number; max_tokens?: number } | undefined);
		const requestedMaxTokens = maxTokensOverride?.maxTokens ?? maxTokensOverride?.max_tokens;
		const maxTokens = typeof requestedMaxTokens === 'number'
			? Math.min(Math.max(requestedMaxTokens, 1), backend.settings.maxOutputTokens)
			: backend.settings.maxOutputTokens;

		const payload: Record<string, unknown> = {
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

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const content = typeof text === 'string' ? text : this.flattenMessage(text);
		return Math.ceil(content.length / 4);
	}

	private async pickVendor(placeHolder: string): Promise<VendorKey | undefined> {
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

	private readModelSettings(vendor: VendorKey): ModelSettings {
		const definition = MODEL_DEFINITIONS[vendor];
		const config = vscode.workspace.getConfiguration('customCopilotProvider');
		const get = <T>(suffix: string, fallback: T) => config.get<T>(`${vendor}.${suffix}`, fallback);
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

	private toChatInformation(settings: ModelSettings): vscode.LanguageModelChatInformation {
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

	private resolveModel(modelId: string): RegisteredModel | undefined {
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

	private async ensureApiKey(vendor: VendorKey, allowPrompt: boolean): Promise<string | undefined> {
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

	private getSystemPrompt(): string {
		return vscode.workspace
			.getConfiguration('customCopilotProvider')
			.get<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT);
	}

	private getReasoningFlushInterval(): number {
		return vscode.workspace
			.getConfiguration('customCopilotProvider')
			.get<number>('reasoningFlushInterval', DEFAULT_REASONING_FLUSH_INTERVAL);
	}

	private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
		const systemPrompt = this.getSystemPrompt().trim();
		const chat: OpenAIChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

		for (const message of messages) {
			if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
				const textPieces: string[] = [];
				const toolCalls: OpenAIToolCall[] = [];

				for (const part of message.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						textPieces.push(part.value);
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						toolCalls.push({
							id: part.callId,
							type: 'function',
							function: {
								name: part.name,
								arguments: JSON.stringify(part.input ?? {})
							}
						});
					} else if (part instanceof vscode.LanguageModelDataPart) {
						textPieces.push(this.serializeDataPart(part));
					}
				}

				const assistantPayload: OpenAIChatMessage = { role: 'assistant' };
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
			} else {
				const textPieces: string[] = [];
				const toolResults: OpenAIChatMessage[] = [];

				for (const part of message.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						textPieces.push(part.value);
					} else if (part instanceof vscode.LanguageModelToolResultPart) {
						let toolText = '';
						for (const inner of part.content) {
							if (inner instanceof vscode.LanguageModelTextPart) {
								toolText += inner.value;
							} else if (inner instanceof vscode.LanguageModelDataPart) {
								toolText += this.serializeDataPart(inner);
							}
						}
						toolResults.push({
							role: 'tool',
							content: toolText,
							tool_call_id: part.callId
						});
					} else if (part instanceof vscode.LanguageModelDataPart) {
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

	private convertTools(tools?: readonly vscode.LanguageModelChatTool[]) {
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

	private flattenMessage(message: vscode.LanguageModelChatRequestMessage): string {
		let flattened = '';
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				flattened += part.value;
			}
		}
		return flattened;
	}

	private serializeDataPart(part: vscode.LanguageModelDataPart): string {
		const base64 = Buffer.from(part.data).toString('base64');
		if (base64.length <= MAX_EMBEDDED_BASE64) {
			return `data:${part.mimeType};base64,${base64}`;
		}
		const truncated = base64.slice(0, MAX_EMBEDDED_BASE64);
		return `data:${part.mimeType};base64,${truncated}... (truncated, original ${part.data.byteLength} bytes)`;
	}

	private async streamOpenAIResponse(
		backend: RegisteredModel,
		apiKey: string,
		payload: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
		flushIntervalMs: number
	): Promise<void> {
		const endpoint = this.buildEndpoint(backend.settings.baseUrl, 'chat/completions');
		const reasoningLimit = Math.max(0, backend.settings.reasoningCharLimit);
		const enableReasoning = backend.settings.supportsReasoning && reasoningLimit > 0;
		const reasoningSessionId = `${backend.settings.modelId}-${Date.now()}`;
		let previousReasoningSnapshot = '';
		let pendingReasoning = '';
		let reasoningFlushTimer: NodeJS.Timeout | undefined;
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

		const flushReasoning = (metadata?: Record<string, unknown>) => {
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
			this.reportThinkingPart(
				progress,
				`\n[Reasoning truncated after ${reasoningLimit.toLocaleString()} characters]\n`,
				{ vscode_reasoning_truncated: true }
			);
		};

		const appendReasoningDelta = (delta: string) => {
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
			} else {
				flushReasoning();
			}
		};

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const request = https.request(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
					Authorization: `Bearer ${apiKey}`
				}
			}, (response: IncomingMessage) => {
				if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
					const chunks: Buffer[] = [];
					response.on('data', (chunk: Buffer) => chunks.push(chunk));
					response.on('end', () => {
						if (!settled) {
							settled = true;
							reject(new Error(`${backend.settings.displayName} API responded with status ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
						}
					});
					return;
				}

				let buffer = '';
				const pendingToolCalls = new Map<number, PendingToolCall>();

				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
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

						let parsed: StreamResponseChunk;
						try {
							parsed = JSON.parse(payloadString);
						} catch (error) {
							if (!settled) {
								settled = true;
								reject(new Error(`Failed to parse streaming payload: ${(error as Error).message}`));
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
							} else {
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
								let parsedArgs: Record<string, unknown> = {};
								const trimmed = call.arguments.trim();
								if (trimmed) {
									try {
										parsedArgs = JSON.parse(trimmed);
									} catch (error) {
										pendingToolCalls.clear();
										if (!settled) {
											settled = true;
											reject(new Error(`Failed to parse tool call arguments: ${(error as Error).message}`));
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

				response.on('error', (err: Error) => {
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

	private reportThinkingPart(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		chunk: string,
		metadata?: Record<string, unknown>
	): void {
		const extended = vscode as typeof vscode & {
			LanguageModelThinkingPart?: new (
				value: string,
				streamId?: string,
				meta?: Record<string, unknown>
			) => vscode.LanguageModelResponsePart;
		};
		const ThinkingCtor = extended.LanguageModelThinkingPart;
		if (ThinkingCtor) {
			progress.report(new ThinkingCtor(chunk, REASONING_STREAM_ID, metadata));
			return;
		}
		if (chunk) {
			progress.report(new vscode.LanguageModelTextPart(chunk));
		}
	}

	private buildEndpoint(baseUrl: string, resource: string): URL {
		const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
		return new URL(resource, normalizedBase);
	}
}

