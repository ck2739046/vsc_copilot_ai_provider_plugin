import * as https from 'https';
import { IncomingMessage } from 'http';
import { URL } from 'node:url';
import * as vscode from 'vscode';

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

const SECRET_STORAGE_KEY = 'customCopilotProvider.apiKey';
const THINKING_STREAM_ID = 'moonshot_reasoning';
const MAX_EMBEDDED_BASE64 = 120_000;

export class CustomModelProvider implements vscode.LanguageModelChatProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	async promptForApiKey(): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: 'Enter Moonshot (Kimi) API Key',
			prompt: 'The key is stored securely in the VS Code secret storage for this profile.',
			password: true,
			ignoreFocusOut: true,
		});

		if (!value) {
			return;
		}

		await this.context.secrets.store(SECRET_STORAGE_KEY, value.trim());
		void vscode.window.showInformationMessage('Custom Copilot Provider API key saved.');
	}

	async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
		const apiKey = await this.ensureApiKey(!options.silent);
		if (!apiKey) {
			return [];
		}

		const config = vscode.workspace.getConfiguration('customCopilotProvider');
		const modelId = config.get<string>('defaultModel', 'kimi-k2-thinking');

		return [
			{
				id: modelId,
				name: 'Moonshot Thinking Model',
				family: 'moonshot',
				tooltip: 'Streams reasoning traces and supports multi-step tool calls via the Moonshot API.',
				detail: 'Powered by kimi-k2-thinking',
				version: '2025-11-26',
				maxInputTokens: 200000,
				maxOutputTokens: 16000,
				capabilities: {
					toolCalling: true,
					imageInput: false
				}
			}
		];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const apiKey = await this.ensureApiKey(true);
		if (!apiKey) {
			throw new Error('No API key configured for the Custom Copilot Provider. Run the "Set API Key" command first.');
		}

		if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
			throw new Error('The configured vendor API does not support forcing a tool call on every response.');
		}

		const config = vscode.workspace.getConfiguration('customCopilotProvider');
		const baseUrl = config.get<string>('apiBaseUrl', 'https://api.moonshot.cn/v1');
		const temperature = config.get<number>('temperature', 1);
		const payload = {
			model: model.id,
			messages: this.convertMessages(messages),
			stream: true,
			temperature,
			max_tokens: model.maxOutputTokens,
			tools: this.convertTools(options.tools),
		};

		await this.streamMoonshotResponse(baseUrl, apiKey, payload, progress, token);
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const content = typeof text === 'string' ? text : this.flattenMessage(text);
		return Math.ceil(content.length / 4);
	}

	private async ensureApiKey(allowPrompt: boolean): Promise<string | undefined> {
		const existing = await this.context.secrets.get(SECRET_STORAGE_KEY);
		if (existing) {
			return existing;
		}

		if (!allowPrompt) {
			return undefined;
		}

		await this.promptForApiKey();
		return this.context.secrets.get(SECRET_STORAGE_KEY);
	}

	private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
		const chat: OpenAIChatMessage[] = [
			{
				role: 'system',
				content: 'You are a GitHub Copilot chat provider running inside VS Code. Always preserve code formatting and prefer tool calls when they produce more accurate answers.'
			}
		];

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

	private async streamMoonshotResponse(
		baseUrl: string,
		apiKey: string,
		payload: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const endpoint = this.buildEndpoint(baseUrl, 'chat/completions');

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
							reject(new Error(`Moonshot API responded with status ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
						}
					});
					return;
				}

				let buffer = '';
				let thinkingStarted = false;
				let thinkingCompleted = false;
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
							if (thinkingStarted && !thinkingCompleted) {
								this.reportThinkingPart(progress, '', { vscode_reasoning_done: true });
							}
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
							thinkingStarted = true;
							this.reportThinkingPart(progress, choice.delta.reasoning_content);
						}

						if (!thinkingCompleted && thinkingStarted && choice.delta.content) {
							thinkingCompleted = true;
							this.reportThinkingPart(progress, '', { vscode_reasoning_done: true });
						}

						if (choice.delta.content) {
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
							thinkingCompleted = true;
							this.reportThinkingPart(progress, '', { vscode_reasoning_done: true });
						}
					}
				});

				response.on('end', () => {
					if (thinkingStarted && !thinkingCompleted) {
						this.reportThinkingPart(progress, '', { vscode_reasoning_done: true });
					}
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
				request.destroy();
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
			progress.report(new ThinkingCtor(chunk, THINKING_STREAM_ID, metadata));
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
