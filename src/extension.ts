import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
	EnvPreset,
	DEFAULT_PRESETS,
	PROFILE_KEY,
	parseJson,
	parsePresets,
	presetValues,
	legacyToken,
	detectPreset,
	managedKeys,
	envListToRecord,
	buildEnvList,
	withProfile
} from './presets';
import {
	SessionInfo,
	SessionRelation,
	encodeProjectPath,
	findProjectDir,
	listSessions,
	compareSession,
	copySession
} from './sessions';

// Claude Code extension setting the variables are written to
const CLAUDE_CODE_SECTION = 'claudeCode';
const ENV_SETTING = 'environmentVariables';
const ENV_SETTING_ID = `${CLAUDE_CODE_SECTION}.${ENV_SETTING}`;

const ACTIVE_PRESET_STATE = 'ccModelSwitch.activePresetId';
const MANAGED_KEYS_STATE = 'ccModelSwitch.managedEnvKeys';

// Profile folders next to ~/.claude, e.g. ~/.claude-work
const PROFILE_DIR = /^\.claude-[A-Za-z0-9_-]+$/;

// Delay before reacting to file changes (an editor with autosave writes often)
const FILE_CHANGE_DEBOUNCE_MS = 300;

// Errors a rename on Windows may hit while another process holds the file
const RETRYABLE_WRITE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WRITE_ATTEMPTS = 4;
const WRITE_RETRY_DELAY_MS = 50;

interface Profile {
	label: string;
	// undefined = the default profile (~/.claude)
	configDir: string | undefined;
}

// Extension context
let extensionContext: vscode.ExtensionContext;

// Currently loaded presets (refreshed when envs.json changes)
let presets: EnvPreset[] = DEFAULT_PRESETS;

// Last envs.json warning shown, so the same problem is not reported again on every save
let lastPresetsWarning: string | undefined;

// Status bar item
let statusBarItem: vscode.StatusBarItem;

// Open configuration panel (only one at a time)
let configPanel: vscode.WebviewPanel | undefined;

// Incremented on every panel render, so a slower older render never overwrites a newer one
let renderGeneration = 0;

// Switches and token changes run one at a time
let operationQueue: Promise<unknown> = Promise.resolve();

function getClaudeDir(): string {
	return path.join(os.homedir(), '.claude');
}

// Get the envs.json path (stored in the user's home directory)
function getEnvsConfigPath(): string {
	return path.join(getClaudeDir(), 'envs.json');
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write a file atomically (temp file + rename), so a crash never leaves a half-written file.
// A symlink is followed, so the link itself is kept and its target is replaced.
function writeFileAtomic(filePath: string, content: string): void {
	let targetPath = filePath;
	try {
		targetPath = fs.realpathSync(filePath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw e;
		}
	}

	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
	try {
		for (let attempt = 1; ; attempt++) {
			try {
				fs.renameSync(tmpPath, targetPath);
				return;
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (attempt >= WRITE_ATTEMPTS || !code || !RETRYABLE_WRITE_ERRORS.has(code)) {
					throw e;
				}
				sleepSync(WRITE_RETRY_DELAY_MS * attempt);
			}
		}
	} catch (e) {
		fs.rmSync(tmpPath, { force: true });
		throw e;
	}
}

// Run an operation after all previously queued ones have finished
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const result = operationQueue.then(operation, operation);
	operationQueue = result.catch(() => undefined);
	return result;
}

// Initialize the default envs.json
function initDefaultEnvsConfig(): void {
	const configPath = getEnvsConfigPath();
	if (fs.existsSync(configPath)) {
		return;
	}
	try {
		writeFileAtomic(configPath, JSON.stringify({ presets: DEFAULT_PRESETS }, null, 2) + '\n');
	} catch (e) {
		console.error('Failed to initialize envs.json:', e);
	}
}

function claudeCodeConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CLAUDE_CODE_SECTION);
}

// Read the user-level value of claudeCode.environmentVariables.
// Throws when the Claude Code extension is not available or the value is not a list, so it is never overwritten.
function readEnvList(): unknown[] {
	const info = claudeCodeConfig().inspect<unknown>(ENV_SETTING);
	if (!info || info.defaultValue === undefined) {
		throw new Error(`the ${ENV_SETTING_ID} setting is not available, install and enable the Claude Code extension`);
	}
	if (info.globalValue === undefined) {
		return [];
	}
	if (!Array.isArray(info.globalValue)) {
		throw new Error(`${ENV_SETTING_ID} in the user settings must be a list`);
	}
	return [...info.globalValue];
}

async function writeEnvList(list: unknown[]): Promise<void> {
	await claudeCodeConfig().update(ENV_SETTING, list, vscode.ConfigurationTarget.Global);
}

// Current variables of the setting (empty when it cannot be read)
function readEnv(): Record<string, string> {
	try {
		return envListToRecord(readEnvList());
	} catch {
		return {};
	}
}

// Config folder of the active Claude Code profile
function getActiveConfigDir(): string {
	return readEnv()[PROFILE_KEY] || getClaudeDir();
}

function profileLabel(configDir: string): string {
	const name = path.basename(configDir);
	return path.resolve(configDir) === path.resolve(getClaudeDir()) ? 'default' : name.replace(/^\.claude-/, '');
}

// Default profile plus every ~/.claude-<name> folder
function listProfiles(): Profile[] {
	const profiles: Profile[] = [{ label: 'default', configDir: undefined }];
	try {
		for (const entry of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
			if (entry.isDirectory() && PROFILE_DIR.test(entry.name)) {
				const configDir = path.join(os.homedir(), entry.name);
				profiles.push({ label: profileLabel(configDir), configDir });
			}
		}
	} catch (e) {
		console.error('Failed to list Claude Code profiles:', e);
	}
	return profiles;
}

// Path of the active profile's Claude Code settings.json
function getSettingsPath(): string {
	return path.join(getActiveConfigDir(), 'settings.json');
}

// Variables in the "env" section of the active profile's settings.json (read only)
function readClaudeSettingsEnv(): Record<string, unknown> {
	try {
		const content = fs.readFileSync(getSettingsPath(), 'utf-8');
		const env = (parseJson(content) as { env?: unknown } | null)?.env;
		return typeof env === 'object' && env !== null && !Array.isArray(env) ? env as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

// Read the environment variable presets.
// On error the previously loaded presets stay active and the user is told about it.
function loadPresets(): void {
	const configPath = getEnvsConfigPath();
	if (!fs.existsSync(configPath)) {
		presets = DEFAULT_PRESETS;
		lastPresetsWarning = undefined;
		return;
	}

	const problems: string[] = [];
	try {
		presets = parsePresets(parseJson(fs.readFileSync(configPath, 'utf-8')), problems);
	} catch (e) {
		problems.unshift(errorMessage(e));
		problems.push('the previously loaded presets are kept');
	}

	const warning = problems.length ? `envs.json: ${problems.join('; ')}` : undefined;
	if (warning && warning !== lastPresetsWarning) {
		void vscode.window.showWarningMessage(warning, 'Edit envs.json').then(choice => {
			if (choice) {
				void vscode.commands.executeCommand('ccModelSwitch.editEnvs');
			}
		});
	}
	lastPresetsWarning = warning;
}

function secretKey(tokenId: string): string {
	return `ccModelSwitch.token.${tokenId}`;
}

// Token for a preset: SecretStorage first, then a token written directly in envs.json (legacy)
async function getPresetToken(preset: EnvPreset): Promise<string | undefined> {
	const stored = await extensionContext.secrets.get(secretKey(preset.tokenId));
	return stored || legacyToken(preset);
}

// Get the current preset
function getCurrentPreset(): EnvPreset | undefined {
	return detectPreset(readEnv(), presets, extensionContext.globalState.get<string>(ACTIVE_PRESET_STATE));
}

function showSettingError(action: string, e: unknown): void {
	void vscode.window.showErrorMessage(`${action}: ${errorMessage(e)}`, 'Open User Settings').then(choice => {
		if (choice) {
			void vscode.commands.executeCommand('workbench.action.openSettingsJson');
		}
	});
}

// Variables in settings.json "env" override the setting, so a switch would have no effect on them
function warnAboutSettingsOverrides(keys: Set<string>): void {
	const overridden = Object.keys(readClaudeSettingsEnv()).filter(key => keys.has(key));
	if (!overridden.length) {
		return;
	}
	void vscode.window.showWarningMessage(
		`${overridden.join(', ')} ${overridden.length === 1 ? 'is' : 'are'} also set in the "env" section of ${getSettingsPath()} and will override the switched value. Remove ${overridden.length === 1 ? 'it' : 'them'} there.`,
		'Edit settings.json'
	).then(choice => {
		if (choice) {
			void vscode.commands.executeCommand('ccModelSwitch.editSettings');
		}
	});
}

// Switch to the given preset
function switchToPreset(preset: EnvPreset): Promise<boolean> {
	return enqueue(() => applyPreset(preset));
}

// Write the preset into the Claude Code setting (must run inside the operation queue)
async function applyPreset(preset: EnvPreset): Promise<boolean> {
	const token = await getPresetToken(preset);

	const managed = managedKeys(presets, extensionContext.globalState.get<string[]>(MANAGED_KEYS_STATE, []));
	try {
		const { list, written } = buildEnvList(readEnvList(), preset, managed, token);
		await writeEnvList(list);
		await extensionContext.globalState.update(ACTIVE_PRESET_STATE, preset.id);
		await extensionContext.globalState.update(MANAGED_KEYS_STATE, written);
	} catch (e) {
		showSettingError('Cannot switch', e);
		return false;
	}
	refreshUi();

	if (!token && preset.requiresToken) {
		void vscode.window.showWarningMessage(`Switched to: ${preset.label} (no API token stored)`, 'Set token').then(choice => {
			if (choice) {
				void setToken(preset.id);
			}
		});
	} else {
		void vscode.window.showInformationMessage(`Switched to: ${preset.label}. Start a new Claude Code session to use it.`);
	}
	warnAboutSettingsOverrides(managed);
	return true;
}

// Store (or remove) the API token of a preset in SecretStorage
async function setToken(presetId?: string): Promise<void> {
	let preset = presets.find(p => p.id === presetId);
	if (!preset) {
		const picked = await vscode.window.showQuickPick(
			presets.map(p => ({ label: p.label, description: p.description, presetId: p.id })),
			{ placeHolder: 'Select the preset to set the API token for' }
		);
		preset = presets.find(p => p.id === picked?.presetId);
	}
	if (!preset) {
		return;
	}

	const target = preset;
	const sharedWith = presets.filter(p => p.tokenId === target.tokenId && p.id !== target.id).map(p => p.label);
	const value = await vscode.window.showInputBox({
		title: `API token for ${target.label} (${target.tokenEnvKey})`,
		prompt: 'Stored in VS Code secure storage. Leave empty to remove the stored token.'
			+ (sharedWith.length ? ` Shared with: ${sharedWith.join(', ')}.` : ''),
		password: true,
		ignoreFocusOut: true
	});
	if (value === undefined) {
		return;
	}

	const token = value.trim();
	await enqueue(async () => {
		if (token) {
			await extensionContext.secrets.store(secretKey(target.tokenId), token);
		} else {
			await extensionContext.secrets.delete(secretKey(target.tokenId));
		}

		// Apply right away if the active preset uses this token
		const current = getCurrentPreset();
		if (current?.tokenId === target.tokenId) {
			await applyPreset(current);
		} else {
			void vscode.window.showInformationMessage(token ? `Token for ${target.label} saved` : `Token for ${target.label} removed`);
			refreshUi();
		}
	});
}

// Switch the Claude Code profile (CLAUDE_CONFIG_DIR)
async function selectProfile(): Promise<void> {
	const current = getActiveConfigDir();
	const items = listProfiles().map(p => {
		const dir = p.configDir ?? getClaudeDir();
		return {
			label: path.resolve(dir) === path.resolve(current) ? `$(check) ${p.label}` : p.label,
			description: dir,
			profile: p
		};
	});

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: `Current profile: ${profileLabel(current)}`
	});
	if (!selected) {
		return;
	}

	await enqueue(async () => {
		try {
			await writeEnvList(withProfile(readEnvList(), selected.profile.configDir));
		} catch (e) {
			showSettingError('Cannot switch the profile', e);
			return;
		}
		refreshUi();
		void vscode.window.showInformationMessage(`Profile: ${selected.profile.label}. Start a new Claude Code session to use it.`);
	});
}

// A session changed this recently may still be running
const RECENT_SESSION_MS = 2 * 60 * 1000;

const RELATION_TEXT: Record<SessionRelation, string> = {
	'new': 'New in this profile',
	'identical': 'Already identical, nothing to copy',
	'source-ahead': 'Goes further than the copy in this profile (the copy will be updated)',
	'target-ahead': 'This profile has more work, it will NOT be overwritten',
	'diverged': 'Differs from the copy in this profile (replacing needs confirmation)'
};

// Copy sessions of the open workspace from another profile into the active one
async function copySessions(): Promise<void> {
	const targetConfigDir = getActiveConfigDir();
	const sources = listProfiles().filter(p => path.resolve(p.configDir ?? getClaudeDir()) !== path.resolve(targetConfigDir));
	if (!sources.length) {
		void vscode.window.showInformationMessage('There is no other profile to copy sessions from. Create a ~/.claude-<name> folder first.');
		return;
	}
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		void vscode.window.showWarningMessage('Open a folder first, sessions are copied for the open workspace.');
		return;
	}

	const targetLabel = profileLabel(targetConfigDir);
	const pickedProfile = await vscode.window.showQuickPick(
		sources.map(p => ({ label: p.label, description: p.configDir ?? getClaudeDir(), profile: p })),
		{ placeHolder: `Copy sessions into the profile "${targetLabel}". From which profile?` }
	);
	if (!pickedProfile) {
		return;
	}

	try {
		const sourceConfigDir = pickedProfile.profile.configDir ?? getClaudeDir();
		const sourceProjectDir = findProjectDir(sourceConfigDir, cwd);
		const sessions = sourceProjectDir ? listSessions(sourceProjectDir) : [];
		if (!sessions.length) {
			void vscode.window.showInformationMessage(`The profile "${pickedProfile.profile.label}" has no sessions for ${cwd}.`);
			return;
		}

		const targetProjectDir = findProjectDir(targetConfigDir, cwd) ?? path.join(targetConfigDir, 'projects', encodeProjectPath(cwd));
		const items = sessions.map(session => {
			const relation = compareSession(session.file, path.join(targetProjectDir, path.basename(session.file)));
			const recent = Date.now() - session.modified.getTime() < RECENT_SESSION_MS ? ' · changed a moment ago, may still be running' : '';
			return {
				label: session.preview ?? session.id,
				description: `${session.modified.toLocaleString()} · ${Math.ceil(session.size / 1024)} KB${recent}`,
				detail: RELATION_TEXT[relation],
				session,
				relation
			};
		});

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `Sessions to copy from "${pickedProfile.profile.label}" into "${targetLabel}"`,
			canPickMany: true,
			matchOnDetail: true
		});
		if (!picked?.length) {
			return;
		}

		const skipped = picked.filter(i => i.relation === 'identical' || i.relation === 'target-ahead');
		const fresh = picked.filter(i => i.relation === 'new');
		const replacing = picked.filter(i => i.relation === 'source-ahead' || i.relation === 'diverged');

		if (replacing.length) {
			const diverged = replacing.filter(i => i.relation === 'diverged').length;
			const answer = await vscode.window.showWarningMessage(
				`Replace ${replacing.length} existing session(s) in the profile "${targetLabel}"?`,
				{
					modal: true,
					detail: (diverged ? `${diverged} of them differ from the source, so work done only in "${targetLabel}" would be replaced. ` : '')
						+ 'Each replaced file is kept next to it as <id>.jsonl.bak.'
				},
				'Replace'
			);
			if (answer !== 'Replace') {
				replacing.length = 0;
			}
		}

		const toCopy: SessionInfo[] = [...fresh, ...replacing].map(i => i.session);
		for (const session of toCopy) {
			copySession(session, targetProjectDir);
		}

		const notes = [`Copied ${toCopy.length} session(s) into the profile "${targetLabel}"`];
		if (skipped.length) {
			notes.push(`${skipped.length} skipped (identical or already further in this profile)`);
		}
		void vscode.window.showInformationMessage(`${notes.join(', ')}. Resume them from the Claude Code session history.`);
	} catch (e) {
		void vscode.window.showErrorMessage(`Cannot copy sessions: ${errorMessage(e)}`);
	}
}

// Update the status bar
function updateStatusBar() {
	if (!statusBarItem) {
		return;
	}
	const currentPreset = getCurrentPreset();
	const profile = profileLabel(getActiveConfigDir());
	const profileSuffix = profile === 'default' ? '' : ` · ${profile}`;
	statusBarItem.text = `$(server) ${currentPreset?.label || 'Not set'}${profileSuffix}`;
	statusBarItem.tooltip = `Current configuration: ${currentPreset?.label || 'Unknown'}\n${currentPreset?.description || ''}\nProfile: ${profile}\n\nClick to switch`;
	statusBarItem.show();
}

function refreshUi(): void {
	updateStatusBar();
	if (configPanel) {
		void renderConfigPanel(configPanel);
	}
}

// Pick and switch the environment configuration
async function selectEnv(): Promise<void> {
	const current = getCurrentPreset();

	const items = presets.map(p => ({
		label: p.id === current?.id ? `$(check) ${p.label}` : p.label,
		description: p.description,
		detail: p.env.ANTHROPIC_BASE_URL,
		presetId: p.id
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: `Current: ${current?.label || 'Unknown'}`,
		matchOnDescription: true,
		matchOnDetail: true
	});

	const preset = presets.find(p => p.id === selected?.presetId);
	if (preset) {
		await switchToPreset(preset);
	}
}

// Open a file in the editor, creating it first if it does not exist
async function openFile(filePath: string, initialContent: string): Promise<void> {
	try {
		if (!fs.existsSync(filePath)) {
			writeFileAtomic(filePath, initialContent);
		}
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
	} catch (e) {
		void vscode.window.showErrorMessage(`Cannot open ${filePath}: ${errorMessage(e)}`);
	}
}

// Show the configuration panel
function showConfigPanel(): void {
	if (configPanel) {
		configPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'ccModelSwitchConfig',
		'Claude Code Model Switch',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: []
		}
	);
	configPanel = panel;
	panel.onDidDispose(() => {
		configPanel = undefined;
	});

	panel.webview.onDidReceiveMessage(async (message: { command: string; presetId?: string }) => {
		if (message.command === 'switch') {
			const preset = presets.find(p => p.id === message.presetId);
			if (preset) {
				await switchToPreset(preset);
			}
		} else if (message.command === 'edit') {
			void vscode.commands.executeCommand('ccModelSwitch.editSettings');
		} else if (message.command === 'openEnvs') {
			void vscode.commands.executeCommand('ccModelSwitch.editEnvs');
		} else if (message.command === 'setToken') {
			void setToken(getCurrentPreset()?.id);
		} else if (message.command === 'selectProfile') {
			void vscode.commands.executeCommand('ccModelSwitch.selectProfile');
		}
	});

	void renderConfigPanel(panel);
}

async function renderConfigPanel(panel: vscode.WebviewPanel): Promise<void> {
	const generation = ++renderGeneration;
	const currentPreset = getCurrentPreset();
	const hasToken = currentPreset ? Boolean(await getPresetToken(currentPreset)) : false;
	if (configPanel === panel && generation === renderGeneration) {
		panel.webview.html = getConfigHtml(panel.webview, currentPreset, presets, hasToken, profileLabel(getActiveConfigDir()));
	}
}

// Escape text for HTML content and attributes
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

// Generate the configuration panel HTML
function getConfigHtml(webview: vscode.Webview, currentPreset: EnvPreset | undefined, allPresets: EnvPreset[], hasToken: boolean, profile: string): string {
	const nonce = crypto.randomBytes(16).toString('base64');

	const presetsHtml = allPresets.map(p => {
		const isActive = currentPreset?.id === p.id;
		return `
		<div class="preset ${isActive ? 'active' : ''}" data-preset-id="${escapeHtml(p.id)}">
			<div class="preset-header">
				<div class="preset-name">${escapeHtml(p.label)}</div>
				${isActive ? '<div class="preset-badge">Current</div>' : ''}
			</div>
			<div class="preset-desc">${escapeHtml(p.description)}</div>
			<div class="preset-url">${escapeHtml(p.env.ANTHROPIC_BASE_URL || 'URL not set')}</div>
		</div>
	`;
	}).join('');

	const envEntries = currentPreset ? presetValues(currentPreset) : [];
	if (currentPreset) {
		envEntries.push([currentPreset.tokenEnvKey, hasToken ? '******' : '']);
	}
	const envHtml = envEntries.map(([key, value]) => `
		<div class="env-item">
			<div class="env-key">${escapeHtml(key)}</div>
			<div class="env-value">${escapeHtml(maskValue(key, value))}</div>
		</div>
	`).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		* { box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			padding: 20px;
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			margin: 0;
		}
		.container { max-width: 700px; margin: 0 auto; }
		h2 {
			margin-bottom: 5px;
			font-size: 18px;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.icon { font-size: 20px; }
		.subtitle {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 20px;
		}
		.current {
			background: var(--vscode-editor-selectionBackground);
			padding: 16px;
			border-radius: 8px;
			margin-bottom: 20px;
		}
		.current-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 12px;
		}
		.current-title {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		.current-label {
			font-size: 18px;
			font-weight: 600;
		}
		.env-list {
			display: grid;
			gap: 8px;
			margin-top: 12px;
		}
		.env-item {
			display: grid;
			grid-template-columns: 200px 1fr;
			gap: 12px;
			font-size: 12px;
		}
		.env-key {
			color: var(--vscode-textLink-foreground);
			font-family: var(--vscode-editor-font-family);
		}
		.env-value {
			color: var(--vscode-foreground);
			font-family: var(--vscode-editor-font-family);
			word-break: break-all;
		}
		.section-title {
			font-size: 13px;
			font-weight: 600;
			margin-bottom: 12px;
			color: var(--vscode-foreground);
		}
		.presets {
			display: grid;
			gap: 10px;
		}
		.preset {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 12px;
			cursor: pointer;
			transition: all 0.15s ease;
		}
		.preset:hover {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border-color: var(--vscode-focusBorder);
		}
		.preset.active {
			background: var(--vscode-editor-selectionBackground);
			border-color: var(--vscode-focusBorder);
		}
		.preset-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.preset-name {
			font-weight: 600;
			font-size: 14px;
		}
		.preset-badge {
			background: var(--vscode-textLink-foreground);
			color: var(--vscode-editor-background);
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 3px;
		}
		.preset-desc {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin: 4px 0;
		}
		.preset-url {
			font-size: 11px;
			color: var(--vscode-textLink-foreground);
			font-family: var(--vscode-editor-font-family);
		}
		.buttons {
			display: flex;
			gap: 10px;
			margin-top: 20px;
		}
		button {
			flex: 1;
			padding: 10px 16px;
			border: none;
			cursor: pointer;
			font-size: 13px;
			border-radius: 4px;
			font-family: var(--vscode-font-family);
		}
		.edit-btn {
			background-color: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.edit-btn:hover {
			background-color: var(--vscode-button-secondaryHoverBackground);
		}
		.envs-btn {
			background-color: transparent;
			border: 1px solid var(--vscode-panel-border);
			color: var(--vscode-foreground);
		}
		.envs-btn:hover {
			background-color: var(--vscode-editor-inactiveSelectionBackground);
		}
	</style>
</head>
<body>
	<div class="container">
		<h2><span class="icon">🔧</span> Claude Code Model Switch</h2>
		<div class="subtitle">Quickly switch the Claude Code environment variable configuration</div>

		${currentPreset ? `
		<div class="current">
			<div class="current-header">
				<div>
					<div class="current-title">Current configuration</div>
					<div class="current-label">${escapeHtml(currentPreset.label)}</div>
					<div class="preset-desc">Profile: ${escapeHtml(profile)}</div>
				</div>
			</div>
			<div class="env-list">
				${envHtml}
			</div>
		</div>
		` : ''}

		<div class="section-title">Presets</div>
		<div class="presets">
			${presetsHtml}
		</div>

		<div class="buttons">
			<button class="edit-btn" data-command="edit">Edit settings.json</button>
			<button class="envs-btn" data-command="openEnvs">Edit presets</button>
			${currentPreset ? '<button class="envs-btn" data-command="setToken">Set API token</button>' : ''}
			<button class="envs-btn" data-command="selectProfile">Switch profile</button>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		document.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target : null;
			const preset = target?.closest('[data-preset-id]');
			if (preset) {
				vscode.postMessage({ command: 'switch', presetId: preset.dataset.presetId });
				return;
			}
			const button = target?.closest('[data-command]');
			if (button) {
				vscode.postMessage({ command: button.dataset.command });
			}
		});
	</script>
</body>
</html>`;
}

// Hide sensitive values
function maskValue(key: string, value: string): string {
	if (/TOKEN|KEY|SECRET|PASSWORD/.test(key)) {
		return value ? '******' : '(not set)';
	}
	return value || '(not set)';
}

// Activate the extension
export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;

	// Initialize the default config file
	initDefaultEnvsConfig();
	loadPresets();

	// Create the status bar item
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.command = 'ccModelSwitch.showQuickActions';
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	// Keep the UI in sync when envs.json or the Claude Code setting change outside the extension
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(getClaudeDir()), 'envs.json')
	);
	let changeTimer: NodeJS.Timeout | undefined;
	const onFileChange = () => {
		clearTimeout(changeTimer);
		changeTimer = setTimeout(() => {
			loadPresets();
			refreshUi();
		}, FILE_CHANGE_DEBOUNCE_MS);
	};
	context.subscriptions.push({ dispose: () => clearTimeout(changeTimer) });
	watcher.onDidChange(onFileChange);
	watcher.onDidCreate(onFileChange);
	watcher.onDidDelete(onFileChange);
	context.subscriptions.push(watcher);

	context.subscriptions.push(
		context.secrets.onDidChange(() => refreshUi()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ENV_SETTING_ID)) {
				refreshUi();
			}
		})
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('ccModelSwitch.selectEnv', () => selectEnv()),
		vscode.commands.registerCommand('ccModelSwitch.showConfig', () => showConfigPanel()),
		vscode.commands.registerCommand('ccModelSwitch.setToken', () => setToken()),
		vscode.commands.registerCommand('ccModelSwitch.selectProfile', () => selectProfile()),
		vscode.commands.registerCommand('ccModelSwitch.copySessions', () => copySessions()),
		vscode.commands.registerCommand('ccModelSwitch.editSettings', () => openFile(getSettingsPath(), '{}\n')),
		vscode.commands.registerCommand('ccModelSwitch.editEnvs', () =>
			openFile(getEnvsConfigPath(), JSON.stringify({ presets: DEFAULT_PRESETS }, null, 2) + '\n'))
	);

	// Quick actions menu (triggered by clicking the status bar item)
	const quickActionsCommand = vscode.commands.registerCommand('ccModelSwitch.showQuickActions', async () => {
		const actions = [
			{
				label: '$(server) Open environment panel',
				description: 'View the current configuration and all presets',
				command: 'ccModelSwitch.showConfig'
			},
			{
				label: '$(arrow-swap) Switch environment',
				description: 'Quickly switch to another preset',
				command: 'ccModelSwitch.selectEnv'
			},
			{
				label: '$(account) Switch profile',
				description: 'Select the Claude Code config folder (CLAUDE_CONFIG_DIR)',
				command: 'ccModelSwitch.selectProfile'
			},
			{
				label: '$(copy) Copy sessions from another profile',
				description: 'Continue work started in another profile; never overwrites newer work',
				command: 'ccModelSwitch.copySessions'
			},
			{
				label: '$(key) Set API token',
				description: 'Store a preset token in VS Code secure storage',
				command: 'ccModelSwitch.setToken'
			},
			{
				label: '$(edit) Edit presets (envs.json)',
				description: 'Modify the environment variable configuration',
				command: 'ccModelSwitch.editEnvs'
			},
			{
				label: '$(settings-edit) Edit Claude Code settings (settings.json)',
				description: 'Modify the Claude Code configuration',
				command: 'ccModelSwitch.editSettings'
			}
		];

		const selected = await vscode.window.showQuickPick(actions, {
			placeHolder: `Current configuration: ${getCurrentPreset()?.label || 'Not set'}`
		});

		if (selected) {
			void vscode.commands.executeCommand(selected.command);
		}
	});
	context.subscriptions.push(quickActionsCommand);
}

// Deactivate the extension
export function deactivate() {}
