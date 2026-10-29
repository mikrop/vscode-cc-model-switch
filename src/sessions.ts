// Copying of Claude Code sessions between profiles, without any dependency on the vscode API (unit-testable).
// A session is <config dir>/projects/<encoded project path>/<uuid>.jsonl plus an optional <uuid>/ folder
// (subagents, tool results). The format is internal to Claude Code and may change.
import * as fs from 'fs';
import * as path from 'path';

// File name of a session; anything else in a project folder is ignored
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// How much of a session is read to find its first user message
const PREVIEW_BYTES = 128 * 1024;
const PREVIEW_LENGTH = 80;
const COMPARE_CHUNK_BYTES = 64 * 1024;

// How the session in the source profile relates to the one in the target profile
export type SessionRelation =
	// not in the target yet
	| 'new'
	// same content
	| 'identical'
	// the target is the beginning of the source, so the source continues further
	| 'source-ahead'
	// the source is the beginning of the target, so the target has more work
	| 'target-ahead'
	// both have content the other one lacks
	| 'diverged';

export interface SessionInfo {
	id: string;
	file: string;
	size: number;
	modified: Date;
	// First user message, when it could be found
	preview: string | undefined;
}

// Claude Code names the project folder after the working directory with every non-alphanumeric character as "-"
export function encodeProjectPath(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// Project folder of a working directory. The match ignores case, because the drive letter
// is written both ways (C--Projekty and c--Projekty).
export function findProjectDir(configDir: string, cwd: string): string | undefined {
	const projectsDir = path.join(configDir, 'projects');
	const wanted = encodeProjectPath(cwd).toLowerCase();
	try {
		const match = fs.readdirSync(projectsDir, { withFileTypes: true })
			.find(entry => entry.isDirectory() && entry.name.toLowerCase() === wanted);
		return match ? path.join(projectsDir, match.name) : undefined;
	} catch {
		return undefined;
	}
}

function textOf(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const part = content.find(p => (p as { type?: unknown; text?: unknown })?.type === 'text' && typeof (p as { text?: unknown }).text === 'string');
		return part ? (part as { text: string }).text : undefined;
	}
	return undefined;
}

// First user message of a session (best effort, the format is not documented)
export function readPreview(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, 'r');
		const buffer = Buffer.alloc(PREVIEW_BYTES);
		const read = fs.readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
		const lines = buffer.subarray(0, read).toString('utf-8').split('\n');
		// The last line may be cut off by the read limit
		lines.pop();
		for (const line of lines) {
			let entry: { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== 'user' || entry.isMeta) {
				continue;
			}
			const text = textOf(entry.message?.content)?.trim();
			// Messages starting with "<" are injected by Claude Code (commands, caveats), not typed by the user
			if (text && !text.startsWith('<')) {
				const oneLine = text.replace(/\s+/g, ' ');
				return oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH - 1)}…` : oneLine;
			}
		}
	} catch {
		// no preview
	} finally {
		if (fd !== undefined) {
			fs.closeSync(fd);
		}
	}
	return undefined;
}

// Sessions of a project folder, the most recently changed first
export function listSessions(projectDir: string): SessionInfo[] {
	let names: string[];
	try {
		names = fs.readdirSync(projectDir);
	} catch {
		return [];
	}
	const sessions: SessionInfo[] = [];
	for (const name of names) {
		const match = SESSION_FILE.exec(name);
		if (!match) {
			continue;
		}
		const file = path.join(projectDir, name);
		try {
			const stat = fs.statSync(file);
			if (stat.isFile()) {
				sessions.push({ id: match[1], file, size: stat.size, modified: stat.mtime, preview: readPreview(file) });
			}
		} catch {
			// removed meanwhile
		}
	}
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// Do both files start with the same `length` bytes?
function sameStart(a: string, b: string, length: number): boolean {
	const fdA = fs.openSync(a, 'r');
	try {
		const fdB = fs.openSync(b, 'r');
		try {
			const bufferA = Buffer.alloc(COMPARE_CHUNK_BYTES);
			const bufferB = Buffer.alloc(COMPARE_CHUNK_BYTES);
			for (let offset = 0; offset < length; offset += COMPARE_CHUNK_BYTES) {
				const size = Math.min(COMPARE_CHUNK_BYTES, length - offset);
				const readA = fs.readSync(fdA, bufferA, 0, size, offset);
				const readB = fs.readSync(fdB, bufferB, 0, size, offset);
				if (readA !== readB || !bufferA.subarray(0, readA).equals(bufferB.subarray(0, readB))) {
					return false;
				}
			}
			return true;
		} finally {
			fs.closeSync(fdB);
		}
	} finally {
		fs.closeSync(fdA);
	}
}

// Sessions only grow (lines are appended), so the one that contains the other is the newer one.
// The modification time is not used, because a copy gets a new one and an editor can touch a file without new work.
export function compareSession(sourceFile: string, targetFile: string): SessionRelation {
	if (!fs.existsSync(targetFile)) {
		return 'new';
	}
	const sourceSize = fs.statSync(sourceFile).size;
	const targetSize = fs.statSync(targetFile).size;
	if (!sameStart(sourceFile, targetFile, Math.min(sourceSize, targetSize))) {
		return 'diverged';
	}
	if (sourceSize === targetSize) {
		return 'identical';
	}
	return sourceSize > targetSize ? 'source-ahead' : 'target-ahead';
}

// Copy a session (the .jsonl and its folder) into the project folder of another profile.
// An existing target file is kept as <uuid>.jsonl.bak before it is replaced. The modification time is preserved.
export function copySession(session: SessionInfo, targetProjectDir: string): { backup: string | undefined } {
	fs.mkdirSync(targetProjectDir, { recursive: true });
	const targetFile = path.join(targetProjectDir, path.basename(session.file));

	let backup: string | undefined;
	if (fs.existsSync(targetFile)) {
		backup = `${targetFile}.bak`;
		fs.copyFileSync(targetFile, backup);
	}

	const tmpFile = `${targetFile}.${process.pid}.tmp`;
	try {
		fs.copyFileSync(session.file, tmpFile);
		fs.utimesSync(tmpFile, session.modified, session.modified);
		fs.renameSync(tmpFile, targetFile);
	} catch (e) {
		fs.rmSync(tmpFile, { force: true });
		throw e;
	}

	// Subagents and tool results; files already in the target are kept
	const sourceFolder = path.join(path.dirname(session.file), session.id);
	if (fs.existsSync(sourceFolder)) {
		fs.cpSync(sourceFolder, path.join(targetProjectDir, session.id), { recursive: true, force: false, errorOnExist: false });
	}
	return { backup };
}
