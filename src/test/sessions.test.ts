import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	encodeProjectPath,
	findProjectDir,
	listSessions,
	readPreview,
	compareSession,
	copySession
} from '../sessions';

const ID = '0a1b2c3d-0000-4000-8000-000000000001';

function line(text: string): string {
	return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

suite('sessions', () => {
	let root: string;
	let source: string;
	let target: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-'));
		source = path.join(root, 'source');
		target = path.join(root, 'target');
		fs.mkdirSync(source);
		fs.mkdirSync(target);
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const write = (dir: string, content: string) => fs.writeFileSync(path.join(dir, `${ID}.jsonl`), content);
	const read = (dir: string) => fs.readFileSync(path.join(dir, `${ID}.jsonl`), 'utf-8');
	const relation = () => compareSession(path.join(source, `${ID}.jsonl`), path.join(target, `${ID}.jsonl`));

	test('encodes a path like Claude Code does', () => {
		assert.strictEqual(encodeProjectPath('C:\\Projekty\\first-line'), 'C--Projekty-first-line');
		assert.strictEqual(encodeProjectPath('/home/me/app'), '-home-me-app');
	});

	test('finds a project folder regardless of case', () => {
		fs.mkdirSync(path.join(root, 'projects', 'c--Projekty-first-line'), { recursive: true });
		assert.strictEqual(findProjectDir(root, 'C:\\Projekty\\first-line'), path.join(root, 'projects', 'c--Projekty-first-line'));
		assert.strictEqual(findProjectDir(root, 'C:\\Projekty\\other'), undefined);
	});

	test('reads the first typed user message, skipping injected ones', () => {
		write(source, '{"type":"summary"}\n' + line('<command-name>/login</command-name>') + line('Fix the\n  build please'));
		assert.strictEqual(readPreview(path.join(source, `${ID}.jsonl`)), 'Fix the build please');
	});

	test('lists only session files, newest first', () => {
		write(source, line('a'));
		fs.writeFileSync(path.join(source, 'notes.txt'), 'x');
		fs.writeFileSync(path.join(source, `${ID}.jsonl.bak`), 'x');
		const sessions = listSessions(source);
		assert.deepStrictEqual(sessions.map(s => s.id), [ID]);
	});

	test('a missing target is new', () => {
		write(source, line('a'));
		assert.strictEqual(relation(), 'new');
	});

	test('equal content is identical', () => {
		write(source, line('a'));
		write(target, line('a'));
		assert.strictEqual(relation(), 'identical');
	});

	test('the longer file is ahead', () => {
		write(source, line('a') + line('b'));
		write(target, line('a'));
		assert.strictEqual(relation(), 'source-ahead');
		write(source, line('a'));
		write(target, line('a') + line('b'));
		assert.strictEqual(relation(), 'target-ahead');
	});

	test('the modification time does not decide', () => {
		write(source, line('a'));
		write(target, line('a') + line('b'));
		const old = new Date('2020-01-01');
		fs.utimesSync(path.join(target, `${ID}.jsonl`), old, old);
		assert.strictEqual(relation(), 'target-ahead');
	});

	test('different content is diverged', () => {
		write(source, line('a') + line('x'));
		write(target, line('a') + line('y'));
		assert.strictEqual(relation(), 'diverged');
	});

	test('compares files larger than one chunk', () => {
		const big = line('x'.repeat(200 * 1024));
		write(source, big + line('more'));
		write(target, big);
		assert.strictEqual(relation(), 'source-ahead');
		write(target, big.slice(0, -2) + 'Z\n');
		assert.strictEqual(relation(), 'diverged');
	});

	test('copies a session with its folder and keeps the modification time', () => {
		write(source, line('a'));
		fs.mkdirSync(path.join(source, ID, 'subagents'), { recursive: true });
		fs.writeFileSync(path.join(source, ID, 'subagents', 'agent-1.jsonl'), 'sub');
		const when = new Date('2024-05-06T07:08:09Z');
		fs.utimesSync(path.join(source, `${ID}.jsonl`), when, when);

		const [session] = listSessions(source);
		const result = copySession(session, target);

		assert.strictEqual(result.backup, undefined);
		assert.strictEqual(read(target), line('a'));
		assert.strictEqual(fs.readFileSync(path.join(target, ID, 'subagents', 'agent-1.jsonl'), 'utf-8'), 'sub');
		assert.strictEqual(fs.statSync(path.join(target, `${ID}.jsonl`)).mtime.getTime(), when.getTime());
		assert.deepStrictEqual(fs.readdirSync(target).filter(n => n.endsWith('.tmp')), []);
	});

	test('keeps the replaced target as a backup', () => {
		write(source, line('a') + line('b'));
		write(target, line('a'));
		const [session] = listSessions(source);
		const result = copySession(session, target);

		assert.strictEqual(read(target), line('a') + line('b'));
		assert.strictEqual(result.backup, path.join(target, `${ID}.jsonl.bak`));
		assert.strictEqual(fs.readFileSync(result.backup!, 'utf-8'), line('a'));
	});

	test('creates the target project folder', () => {
		write(source, line('a'));
		const [session] = listSessions(source);
		copySession(session, path.join(target, 'projects', 'p'));
		assert.ok(fs.existsSync(path.join(target, 'projects', 'p', `${ID}.jsonl`)));
	});
});
