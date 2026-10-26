// Pure preset logic, without any dependency on the vscode API or the file system (unit-testable)

// Environment variable preset type
export interface EnvPreset {
	id: string;
	label: string;
	description: string;
	// false = the preset works without an API token (e.g. Claude login)
	requiresToken: boolean;
	// Variable the stored token is written to
	tokenEnvKey: string;
	// Name the token is stored under; presets with the same tokenId share one token
	tokenId: string;
	env: Record<string, string>;
}

// Entry of the claudeCode.environmentVariables setting
export interface EnvEntry {
	name: string;
	value: string;
}

// Environment variable config type
export interface EnvsConfig {
	presets: EnvPreset[];
}

export const DEFAULT_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN';

// Credential variables Claude Code reads. They are always removed on a switch,
// so a key meant for one provider is never sent to another one.
export const AUTH_KEYS: readonly string[] = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

// Selects the Claude Code profile; switched separately, never part of a preset
export const PROFILE_KEY = 'CLAUDE_CONFIG_DIR';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const OPENROUTER_URL = 'https://openrouter.ai/api';

// OpenRouter preset: a big model for Opus / Sonnet, a small one for Haiku and subagents
function openRouterPreset(id: string, label: string, big: string, small: string): EnvPreset {
	return {
		id,
		label,
		description: `${big} / ${small} via OpenRouter`,
		requiresToken: true,
		tokenEnvKey: DEFAULT_TOKEN_KEY,
		tokenId: 'openrouter',
		env: {
			ANTHROPIC_BASE_URL: OPENROUTER_URL,
			// Explicitly empty, so an Anthropic key from the environment is not sent to OpenRouter
			ANTHROPIC_API_KEY: '',
			ANTHROPIC_DEFAULT_OPUS_MODEL: big,
			ANTHROPIC_DEFAULT_SONNET_MODEL: big,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
			CLAUDE_CODE_SUBAGENT_MODEL: small
		}
	};
}

// Default presets (used when envs.json does not exist).
// Tokens are not stored here, they live in VS Code SecretStorage.
export const DEFAULT_PRESETS: EnvPreset[] = [
	{
		id: 'default',
		label: 'Default',
		description: 'Official Anthropic configuration',
		requiresToken: false,
		// The Anthropic API expects an API key in the x-api-key header
		tokenEnvKey: 'ANTHROPIC_API_KEY',
		tokenId: 'default',
		env: {
			ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
			API_TIMEOUT_MS: '120000'
		}
	},
	openRouterPreset('openrouter-deepseek', 'OpenRouter DeepSeek', '~deepseek/deepseek-pro-latest', 'deepseek/deepseek-v4.1-flash-1017'),
	openRouterPreset('openrouter-grok', 'OpenRouter Grok', 'x-ai/grok-4.7', 'x-ai/grok-build-0.1'),
	openRouterPreset('openrouter-gpt', 'OpenRouter GPT', 'openai/gpt-6-sol', 'openai/gpt-6-luna'),
	openRouterPreset('openrouter-luna', 'OpenRouter GPT Luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna'),
	openRouterPreset('openrouter-qwen', 'OpenRouter Qwen', 'qwen/qwen3.8-27b', 'qwen/qwen3.8-27b')
];

// Parse JSON, ignoring a UTF-8 byte order mark (Windows editors may add one)
export function parseJson(content: string): unknown {
	return JSON.parse(content.replace(/^﻿/, ''));
}

// Validate the content of envs.json, collecting problems instead of failing on the first one
export function parsePresets(data: unknown, problems: string[]): EnvPreset[] {
	const list = (data as Partial<EnvsConfig> | null)?.presets;
	if (!Array.isArray(list)) {
		throw new Error('"presets" must be an array');
	}

	const result: EnvPreset[] = [];
	const seenIds = new Set<string>();
	list.forEach((item: unknown, index: number) => {
		const raw = item as Record<string, unknown> | null;
		const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
		if (!id) {
			problems.push(`preset #${index + 1} has no "id"`);
			return;
		}
		if (seenIds.has(id)) {
			problems.push(`duplicate preset id "${id}"`);
			return;
		}
		if (typeof raw?.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
			problems.push(`preset "${id}" has no "env" object`);
			return;
		}
		const tokenEnvKey = raw.tokenEnvKey === undefined ? DEFAULT_TOKEN_KEY : raw.tokenEnvKey;
		if (typeof tokenEnvKey !== 'string' || !ENV_NAME.test(tokenEnvKey)) {
			problems.push(`preset "${id}": "tokenEnvKey" must be an environment variable name`);
			return;
		}
		const tokenId = raw.tokenId === undefined ? id : raw.tokenId;
		if (typeof tokenId !== 'string' || !tokenId.trim()) {
			problems.push(`preset "${id}": "tokenId" must be a non-empty string`);
			return;
		}

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
			if (key === PROFILE_KEY) {
				problems.push(`preset "${id}": ${PROFILE_KEY} is ignored, use the profile switch instead`);
			} else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				env[key] = String(value);
			} else {
				problems.push(`preset "${id}": value of ${key} must be a string`);
			}
		}

		seenIds.add(id);
		result.push({
			id,
			label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
			description: typeof raw.description === 'string' ? raw.description : '',
			requiresToken: raw.requiresToken !== false,
			tokenEnvKey,
			tokenId: tokenId.trim(),
			env
		});
	});
	return result;
}

function isAuthKey(key: string, preset: EnvPreset): boolean {
	return key === preset.tokenEnvKey || AUTH_KEYS.includes(key);
}

// Preset variables without credentials
export function presetValues(preset: EnvPreset): [string, string][] {
	return Object.entries(preset.env).filter(([key]) => !isAuthKey(key, preset));
}

// Credential variables the preset explicitly sets to an empty value
export function clearedAuthKeys(preset: EnvPreset): string[] {
	return Object.entries(preset.env)
		.filter(([key, value]) => value === '' && isAuthKey(key, preset))
		.map(([key]) => key);
}

// Token written directly in envs.json (legacy, SecretStorage takes precedence)
export function legacyToken(preset: EnvPreset): string | undefined {
	return preset.env[preset.tokenEnvKey] || undefined;
}

// Does the settings env contain all (non-credential) values of the preset?
export function matchesPreset(env: Record<string, string>, preset: EnvPreset): boolean {
	return presetValues(preset).every(([key, value]) => env[key] === value);
}

// Detect the current preset.
// The last preset switched to wins if settings still match it, otherwise the unique best match.
export function detectPreset(env: Record<string, string>, presets: EnvPreset[], activeId?: string): EnvPreset | undefined {
	const active = presets.find(p => p.id === activeId);
	if (active && matchesPreset(env, active)) {
		return active;
	}

	const size = (p: EnvPreset) => presetValues(p).length;
	const candidates = presets
		.filter(p => size(p) > 0 && matchesPreset(env, p))
		.sort((a, b) => size(b) - size(a));
	if (candidates.length === 1 || (candidates.length > 1 && size(candidates[0]) > size(candidates[1]))) {
		return candidates[0];
	}
	return undefined;
}

// Variables a switch removes: credentials, everything defined by a preset and what the last switch wrote
export function managedKeys(presets: EnvPreset[], previouslyWritten: string[]): Set<string> {
	return new Set<string>([
		...AUTH_KEYS,
		...presets.flatMap(p => [p.tokenEnvKey, ...Object.keys(p.env)]),
		...previouslyWritten
	]);
}

function entryName(entry: unknown): string | undefined {
	const name = (entry as Partial<EnvEntry> | null)?.name;
	return typeof name === 'string' ? name : undefined;
}

// Variables of the claudeCode.environmentVariables setting (malformed entries are skipped, the last entry wins)
export function envListToRecord(list: unknown[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of list) {
		const name = entryName(entry);
		const value = name === undefined ? undefined : (entry as Partial<EnvEntry>).value;
		if (name !== undefined && typeof value === 'string') {
			env[name] = value;
		}
	}
	return env;
}

// Build the new setting value: drop managed variables, keep every other entry as it is (in order),
// then add the preset, the variables it clears and its token
export function buildEnvList(
	current: unknown[],
	preset: EnvPreset,
	managed: Set<string>,
	token: string | undefined
): { list: unknown[]; written: string[] } {
	const list = current.filter(entry => {
		const name = entryName(entry);
		return name === undefined || !managed.has(name);
	});
	const added: EnvEntry[] = presetValues(preset).map(([name, value]) => ({ name, value }));
	for (const name of clearedAuthKeys(preset)) {
		if (!(token && name === preset.tokenEnvKey)) {
			added.push({ name, value: '' });
		}
	}
	if (token) {
		added.push({ name: preset.tokenEnvKey, value: token });
	}
	return { list: [...list, ...added], written: added.map(e => e.name) };
}

// Set or (for the default profile) remove the profile variable, keeping every other entry
export function withProfile(current: unknown[], configDir: string | undefined): unknown[] {
	const list = current.filter(entry => entryName(entry) !== PROFILE_KEY);
	return configDir ? [...list, { name: PROFILE_KEY, value: configDir }] : list;
}
