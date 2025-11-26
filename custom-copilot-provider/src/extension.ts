import * as vscode from 'vscode';
import { CustomModelProvider } from './provider';

export async function activate(context: vscode.ExtensionContext) {
	const provider = new CustomModelProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('customCopilotProvider.configureApiKey', async () => {
			await provider.promptForApiKey();
		}),
		vscode.lm.registerLanguageModelChatProvider('custom-byok', provider)
	);
}

export function deactivate() {
	// Nothing to dispose beyond the subscriptions the extension context already tracks.
}
