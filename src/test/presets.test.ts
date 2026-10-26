import * as assert from 'assert';
import {
	EnvPreset,
	DEFAULT_PRESETS,
	parseJson,
	parsePresets,
	presetValues,
	legacyToken,
	matchesPreset,
	detectPreset,
	managedKeys,
	envListToRecord,
	buildEnvList,
	withProfile
} from '../presets';

function preset(id: string, env: Record<string, string>, tokenEnvKey = 'ANTHROPIC_AUTH_TOKEN'): EnvPreset {
	return { id, label: id, description: '', requiresToken: true, tokenEnvKey, tokenId: id, env };
}

suite('parseJson', () => {
	test('ignores a UTF-8 byte order mark', () => {
		assert.deepStrictEqual(parseJson('﻿{"a":1}'), { a: 1 });
	});
});

suite('parsePresets', () => {
	test('accepts the default presets', () => {
		const problems: string[] = [];
		const result = parsePresets({ presets: DEFAULT_PRESETS }, problems);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(result, DEFAULT_PRESETS);
	});

	test('throws when presets is not an array', () => {
		assert.throws(() => parsePresets({ presets: {} }, []), /must be an array/);
		assert.throws(() => parsePresets(null, []), /must be an array/);
	});

	test('fills defaults and converts scalar values', () => {
		const problems: string[] = [];
		const [p] = parsePresets({ presets: [{ id: ' a ', env: { N: 1, B: true } }] }, problems);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(p, {
			id: 'a',
			label: 'a',
			description: '',
			requiresToken: true,
			tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
			tokenId: 'a',
			env: { N: '1', B: 'true' }
		});
	});

	test('reports invalid presets and keeps the valid ones', () => {
		const problems: string[] = [];
		const result = parsePresets({
			presets: [
				{ env: {} },
				{ id: 'a', env: {} },
				{ id: 'a', env: {} },
				{ id: 'b' },
				{ id: 'c', env: {}, tokenEnvKey: 'NOT VALID' },
				{ id: 'd', env: { X: {} } }
			]
		}, problems);
		assert.deepStrictEqual(result.map(p => p.id), ['a', 'd']);
		assert.strictEqual(problems.length, 5);
	});

	test('reads a shared tokenId and rejects an empty one', () => {
		const problems: string[] = [];
		const result = parsePresets({ presets: [{ id: 'a', env: {}, tokenId: 'shared' }, { id: 'b', env: {}, tokenId: ' ' }] }, problems);
		assert.deepStrictEqual(result.map(p => p.tokenId), ['shared']);
		assert.strictEqual(problems.length, 1);
	});

	test('drops CLAUDE_CONFIG_DIR from a preset', () => {
		const problems: string[] = [];
		const [p] = parsePresets({ presets: [{ id: 'a', env: { CLAUDE_CONFIG_DIR: 'x', URL: 'u' } }] }, problems);
		assert.deepStrictEqual(p.env, { URL: 'u' });
		assert.strictEqual(problems.length, 1);
	});

	test('OpenRouter presets share one token', () => {
		const openRouter = DEFAULT_PRESETS.filter(p => p.id.startsWith('openrouter-'));
		assert.strictEqual(openRouter.length, 5);
		assert.ok(openRouter.every(p => p.tokenId === 'openrouter'));
	});
});

suite('preset values', () => {
	const p = preset('p', { URL: 'u', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', MY_KEY: 'm' }, 'MY_KEY');

	test('exclude all credential variables', () => {
		assert.deepStrictEqual(presetValues(p), [['URL', 'u']]);
	});

	test('legacy token is read from tokenEnvKey', () => {
		assert.strictEqual(legacyToken(p), 'm');
		assert.strictEqual(legacyToken(preset('q', {})), undefined);
	});

	test('matching ignores credentials', () => {
		assert.ok(matchesPreset({ URL: 'u' }, p));
		assert.ok(!matchesPreset({ URL: 'other' }, p));
	});
});

suite('detectPreset', () => {
	const small = preset('small', { URL: 'u' });
	const big = preset('big', { URL: 'u', MODEL: 'm' });
	const twin = preset('twin', { URL: 'u', MODEL: 'm' });

	test('prefers the active preset when it still matches', () => {
		assert.strictEqual(detectPreset({ URL: 'u', MODEL: 'm' }, [small, big], 'small'), small);
	});

	test('falls back to the unique best match', () => {
		assert.strictEqual(detectPreset({ URL: 'u', MODEL: 'm' }, [small, big], 'gone'), big);
		assert.strictEqual(detectPreset({ URL: 'u' }, [small, big]), small);
	});

	test('returns undefined for ambiguous or no match', () => {
		assert.strictEqual(detectPreset({ URL: 'u', MODEL: 'm' }, [big, twin]), undefined);
		assert.strictEqual(detectPreset({}, [small]), undefined);
	});
});

suite('envListToRecord', () => {
	test('skips malformed entries, the last entry wins', () => {
		assert.deepStrictEqual(
			envListToRecord([{ name: 'A', value: '1' }, 'junk', null, { name: 'B' }, { name: 'A', value: '2' }]),
			{ A: '2' }
		);
	});
});

suite('buildEnvList', () => {
	const anthropic = preset('anthropic', { URL: 'a' }, 'ANTHROPIC_API_KEY');
	const other = preset('other', { URL: 'o', MODEL: 'm' });

	test('removes credentials and preset variables, keeps other entries untouched and in order', () => {
		const managed = managedKeys([anthropic, other], []);
		const { list, written } = buildEnvList(
			[
				{ name: 'KEEP', value: '1' },
				{ name: 'URL', value: 'a' },
				'junk',
				{ name: 'ANTHROPIC_API_KEY', value: 'secret' },
				{ name: 'CLAUDE_CONFIG_DIR', value: 'c' },
				{ name: 'KEEP', value: '2' },
				{ name: 'MODEL', value: 'old' }
			],
			other,
			managed,
			'tok'
		);
		assert.deepStrictEqual(list, [
			{ name: 'KEEP', value: '1' },
			'junk',
			{ name: 'CLAUDE_CONFIG_DIR', value: 'c' },
			{ name: 'KEEP', value: '2' },
			{ name: 'URL', value: 'o' },
			{ name: 'MODEL', value: 'm' },
			{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'tok' }
		]);
		assert.deepStrictEqual(written, ['URL', 'MODEL', 'ANTHROPIC_AUTH_TOKEN']);
	});

	test('writes the token under the preset tokenEnvKey', () => {
		const { list } = buildEnvList([], anthropic, managedKeys([anthropic], []), 'key');
		assert.deepStrictEqual(list, [{ name: 'URL', value: 'a' }, { name: 'ANTHROPIC_API_KEY', value: 'key' }]);
	});

	test('never copies a credential from the preset env', () => {
		const leaky = preset('leaky', { URL: 'l', ANTHROPIC_API_KEY: 'k' });
		const { list } = buildEnvList([], leaky, managedKeys([leaky], []), undefined);
		assert.deepStrictEqual(list, [{ name: 'URL', value: 'l' }]);
	});

	test('writes a credential the preset explicitly clears', () => {
		const clearing = preset('clearing', { URL: 'c', ANTHROPIC_API_KEY: '' });
		const { list, written } = buildEnvList([{ name: 'ANTHROPIC_API_KEY', value: 'old' }], clearing, managedKeys([clearing], []), 'tok');
		assert.deepStrictEqual(list, [
			{ name: 'URL', value: 'c' },
			{ name: 'ANTHROPIC_API_KEY', value: '' },
			{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'tok' }
		]);
		assert.deepStrictEqual(written, ['URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
	});

	test('a token wins over an empty value of its own variable', () => {
		const p = preset('p', { ANTHROPIC_AUTH_TOKEN: '' });
		assert.deepStrictEqual(buildEnvList([], p, managedKeys([p], []), 'tok').list, [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'tok' }]);
		assert.deepStrictEqual(buildEnvList([], p, managedKeys([p], []), undefined).list, [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '' }]);
	});

	test('removes variables written by the previous switch', () => {
		const { list } = buildEnvList([{ name: 'REMOVED_LATER', value: 'x' }], other, managedKeys([other], ['REMOVED_LATER']), undefined);
		assert.deepStrictEqual(list, [{ name: 'URL', value: 'o' }, { name: 'MODEL', value: 'm' }]);
	});
});

suite('withProfile', () => {
	const current = [{ name: 'CLAUDE_CONFIG_DIR', value: 'old' }, { name: 'KEEP', value: '1' }];

	test('replaces the profile entry', () => {
		assert.deepStrictEqual(withProfile(current, 'new'), [{ name: 'KEEP', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: 'new' }]);
	});

	test('removes it for the default profile', () => {
		assert.deepStrictEqual(withProfile(current, undefined), [{ name: 'KEEP', value: '1' }]);
	});
});
