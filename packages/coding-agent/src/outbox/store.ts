import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type {
	OutboxAttachment,
	OutboxJob,
	OutboxJobEdit,
	OutboxJobPatch,
	OutboxNewJob,
	OutboxSessionSnapshot,
	OutboxState,
	SessionOwnerInfo,
} from "./types";

export function outboxDbPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "outbox", "outbox.db");
}

function safeAttachmentExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return "png";
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "bin";
	}
}

function isPidAlive(pid: number): boolean {
	if (pid <= 0 || !Number.isInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isValidSessionSnapshot(val: unknown): val is OutboxSessionSnapshot {
	if (!val || typeof val !== "object" || Array.isArray(val)) return false;
	const s = val as Record<string, unknown>;
	return (
		typeof s.sessionId === "string" &&
		s.sessionId.length > 0 &&
		typeof s.sessionFile === "string" &&
		path.isAbsolute(s.sessionFile) &&
		(s.branchId === null || typeof s.branchId === "string") &&
		(s.lastUserEntryId === undefined || s.lastUserEntryId === null || typeof s.lastUserEntryId === "string") &&
		typeof s.cwd === "string" &&
		path.isAbsolute(s.cwd) &&
		typeof s.provider === "string" &&
		s.provider.trim().length > 0 &&
		typeof s.model === "string" &&
		s.model.trim().length > 0 &&
		typeof s.sessionName === "string" &&
		typeof s.activity === "string" &&
		typeof s.updatedAt === "number" &&
		Number.isFinite(s.updatedAt) &&
		typeof s.pid === "number" &&
		Number.isInteger(s.pid) &&
		s.pid > 0
	);
}

interface OutboxRow {
	kind: OutboxJob["kind"];
	resume_user_entry_id: string | null;
	id: string;
	position: number;
	created_at: number;
	updated_at: number;
	session_id: string;
	session_file: string;
	branch_id: string | null;
	cwd: string;
	provider: string;
	model: string;
	thinking_level: string | null;
	approval_mode: string | null;
	session_name: string | null;
	text: string;
	attachments: string;
	image_links: string | null;
	state: OutboxState;
	reason: string | null;
	next_check_at: number | null;
	owner_pid: number | null;
	owner_token: string | null;
	cancel_requested: number;
}

/** Messages keep global order; resume watches wait only for earlier/active work in their own chat. */
export function outboxJobBlocker(job: OutboxJob, jobs: readonly OutboxJob[]): OutboxJob | undefined {
	if (job.state === "completed" || job.state === "cancelled") return undefined;
	const active = jobs.find(
		other =>
			other.id !== job.id &&
			other.sessionId === job.sessionId &&
			(other.state === "running" || other.state === "dispatching"),
	);
	if (active) return active;
	for (const other of jobs) {
		if (other.id === job.id) break;
		if (other.state === "completed" || other.state === "cancelled") continue;
		if (other.sessionId === job.sessionId || (job.kind === "message" && other.kind === "message")) return other;
	}
	return undefined;
}

export class OutboxStore {
	#dbPath: string;
	#attachmentsDir: string;
	#db: Database;

	constructor(dbPath?: string) {
		this.#dbPath = dbPath ?? outboxDbPath();
		this.#attachmentsDir = `${this.#dbPath}-attachments`;

		const dbDir = path.dirname(this.#dbPath);
		fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
		this.#checkPrivateDir(dbDir);
		fs.mkdirSync(this.#attachmentsDir, { recursive: true, mode: 0o700 });
		this.#checkPrivateDir(this.#attachmentsDir);
		if (fs.existsSync(this.#dbPath) && fs.lstatSync(this.#dbPath).isSymbolicLink()) {
			throw new Error("Outbox database must not be a symlink.");
		}
		this.#db = new Database(this.#dbPath);
		try {
			fs.chmodSync(this.#dbPath, 0o600);

			this.#db.run("PRAGMA journal_mode = WAL;");
			this.#db.run("PRAGMA synchronous = FULL;");
			this.#db.run("PRAGMA busy_timeout = 5000;");
			this.#db.run("PRAGMA foreign_keys = ON;");

			const check = this.#db.query("PRAGMA quick_check;").get() as {
				quick_check?: string;
			} | null;
			if (check && check.quick_check !== "ok") {
				throw new Error(`Outbox database corrupted: ${check.quick_check}`);
			}

			this.#initializeSchema();
		} catch (error) {
			try {
				this.#db?.close();
			} catch {}
			throw error;
		}
	}

	#checkPrivateDir(dirPath: string): void {
		const lstat = fs.lstatSync(dirPath);
		if (lstat.isSymbolicLink()) {
			throw new Error(`Directory must not be a symlink: ${dirPath}`);
		}
		if (!lstat.isDirectory()) {
			throw new Error(`Path must be a directory: ${dirPath}`);
		}
		if (process.platform !== "win32" && (lstat.mode & 0o077) !== 0) {
			throw new Error(`Directory must be private (mode 0700): ${dirPath}`);
		}
	}

	#initializeSchema(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);

		this.#db.run(`
			CREATE TABLE IF NOT EXISTS outbox (
				id TEXT PRIMARY KEY,
				position INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				session_file TEXT NOT NULL,
				branch_id TEXT,
				cwd TEXT NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				thinking_level TEXT,
				approval_mode TEXT,
				session_name TEXT,
				text TEXT NOT NULL,
				attachments TEXT NOT NULL,
				image_links TEXT,
				state TEXT NOT NULL,
				reason TEXT,
				next_check_at INTEGER,
				owner_pid INTEGER,
				owner_token TEXT,
				cancel_requested INTEGER NOT NULL DEFAULT 0
			);
		`);

		this.#db.run("CREATE INDEX IF NOT EXISTS idx_outbox_position ON outbox(position);");
		this.#db.run("CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state);");
		this.#db.run("CREATE INDEX IF NOT EXISTS idx_outbox_session ON outbox(session_id);");

		this.#db.run(`
			CREATE TABLE IF NOT EXISTS session_registry (
				session_id TEXT PRIMARY KEY,
				session_file TEXT NOT NULL,
				pid INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);

		this.#db.run(`
			CREATE TABLE IF NOT EXISTS session_snapshots (
				session_id TEXT NOT NULL,
				pid INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				snapshot_json TEXT NOT NULL,
				PRIMARY KEY (session_id, pid)
			);
		`);

		this.#db.run("CREATE INDEX IF NOT EXISTS idx_session_snapshots_updated ON session_snapshots(updated_at);");

		this.#db.run(`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER PRIMARY KEY
			);
		`);

		const versionRow = this.#db.query("SELECT version FROM schema_version").get() as { version: number } | null;
		if (!versionRow) {
			this.#db.run("INSERT INTO schema_version (version) VALUES (1);");
		} else if (versionRow.version > 1) {
			throw new Error(`Unsupported schema version ${versionRow.version} (maximum supported is 1)`);
		}

		this.#db
			.transaction(() => {
				const columns = this.#db.query("PRAGMA table_info(outbox)").all() as {
					name: string;
				}[];
				if (!columns.some(column => column.name === "kind")) {
					this.#db.run("ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
				}
				if (!columns.some(column => column.name === "resume_user_entry_id")) {
					this.#db.run("ALTER TABLE outbox ADD COLUMN resume_user_entry_id TEXT");
				}
				this.#db.run(`
				CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_resume_watch
				ON outbox(session_id, resume_user_entry_id)
				WHERE kind = 'resume' AND state NOT IN ('completed', 'cancelled');
			`);
				// Older retry UIs must never expose a resume label as a sendable prompt.
				this.#db.run(`
				CREATE TRIGGER IF NOT EXISTS outbox_resume_pending
				AFTER UPDATE OF state ON outbox
				WHEN NEW.kind = 'resume' AND NEW.state IN ('queued', 'waiting')
				BEGIN
					UPDATE outbox SET state = 'watching', owner_pid = NULL, owner_token = NULL
					WHERE id = NEW.id;
				END;
			`);
			})
			.immediate();
	}

	#rowToJob(row: OutboxRow): OutboxJob {
		let attachments: OutboxAttachment[];
		try {
			attachments = JSON.parse(row.attachments);
		} catch {
			throw new Error(`Corrupted outbox row ${row.id}: invalid attachments JSON`);
		}
		if (!Array.isArray(attachments)) {
			throw new Error(`Corrupted outbox row ${row.id}: attachments must be an array`);
		}

		let imageLinks: (string | undefined)[] | undefined;
		if (row.image_links) {
			try {
				imageLinks = JSON.parse(row.image_links);
			} catch {
				throw new Error(`Corrupted outbox row ${row.id}: invalid image_links JSON`);
			}
		}

		return {
			kind: row.kind,
			resumeUserEntryId: row.resume_user_entry_id ?? undefined,
			id: row.id,
			position: row.position,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			sessionId: row.session_id,
			sessionFile: row.session_file,
			branchId: row.branch_id,
			cwd: row.cwd,
			provider: row.provider,
			model: row.model,
			thinkingLevel: (row.thinking_level as ConfiguredThinkingLevel) ?? undefined,
			approvalMode: row.approval_mode ?? undefined,
			sessionName: row.session_name ?? undefined,
			text: row.text,
			attachments,
			imageLinks,
			state: row.state,
			reason: row.reason ?? undefined,
			nextCheckAt: row.next_check_at ?? undefined,
			ownerPid: row.owner_pid ?? undefined,
			ownerToken: row.owner_token ?? undefined,
			cancelRequested: row.cancel_requested === 1,
		};
	}

	close(): void {
		this.#db.close();
	}

	isArmed(): boolean {
		const row = this.#db.query("SELECT value FROM meta WHERE key = 'armed'").get() as { value: string } | null;
		return row?.value === "1";
	}

	setArmed(armed: boolean): void {
		this.#db.run(
			"INSERT INTO meta (key, value) VALUES ('armed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[armed ? "1" : "0"],
		);
	}

	async add(input: OutboxNewJob): Promise<OutboxJob> {
		if (!input.sessionId || typeof input.sessionId !== "string") {
			throw new Error("Outbox job requires non-empty sessionId");
		}
		if (!input.sessionFile || typeof input.sessionFile !== "string") {
			throw new Error("Outbox job requires non-empty sessionFile");
		}
		if (!input.cwd || typeof input.cwd !== "string") {
			throw new Error("Outbox job requires non-empty cwd");
		}
		if (!input.provider || typeof input.provider !== "string") {
			throw new Error("Outbox job requires non-empty provider");
		}
		if (!input.model || typeof input.model !== "string") {
			throw new Error("Outbox job requires non-empty model");
		}
		if (typeof input.text !== "string") {
			throw new Error("Outbox job text must be a string");
		}

		const kind = input.kind ?? "message";
		if (kind !== "message" && kind !== "resume") {
			throw new Error("Invalid outbox job kind");
		}
		const hasImages = Array.isArray(input.images) && input.images.length > 0;
		if (kind === "resume") {
			if (typeof input.resumeUserEntryId !== "string" || !input.resumeUserEntryId.trim()) {
				throw new Error("Resume watch requires non-empty resumeUserEntryId");
			}
			if (input.branchId !== input.resumeUserEntryId) {
				throw new Error("Resume watch branch must match resumeUserEntryId");
			}
			if (hasImages || input.imageLinks?.length) {
				throw new Error("Resume watch cannot have attachments");
			}
		} else if (!input.text.trim() && !hasImages) {
			throw new Error("Outbox job cannot have empty text without attachments");
		}

		const id = crypto.randomUUID();
		const attachments: OutboxAttachment[] = [];
		const writtenFiles: string[] = [];

		if (hasImages) {
			try {
				const realAttachmentsDir = fs.realpathSync(this.#attachmentsDir);
				for (let i = 0; i < input.images!.length; i++) {
					const image = input.images![i]!;
					const ext = safeAttachmentExtension(image.mimeType);
					const filename = `${id}-${i}.${ext}`;
					const filePath = path.join(realAttachmentsDir, filename);

					const buffer = Buffer.from(image.data, "base64");
					const fd = fs.openSync(
						filePath,
						fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
						0o600,
					);
					writtenFiles.push(filePath);
					try {
						fs.chmodSync(filePath, 0o600);
						fs.writeFileSync(fd, buffer);
						fs.fsyncSync(fd);
					} finally {
						fs.closeSync(fd);
					}

					attachments.push({ path: filePath, mimeType: image.mimeType });
				}
				if (process.platform !== "win32") {
					const dir = fs.openSync(realAttachmentsDir, fs.constants.O_RDONLY);
					try {
						fs.fsyncSync(dir);
					} finally {
						fs.closeSync(dir);
					}
				}
			} catch (error) {
				for (const file of writtenFiles) {
					try {
						fs.unlinkSync(file);
					} catch {}
				}
				throw error;
			}
		}

		try {
			const insertTx = this.#db.transaction(() => {
				if (kind === "resume") {
					const existing = this.#db
						.query(
							"SELECT * FROM outbox WHERE kind = 'resume' AND session_id = ? AND resume_user_entry_id = ? AND state NOT IN ('completed', 'cancelled')",
						)
						.get(input.sessionId, input.resumeUserEntryId!) as OutboxRow | null;
					if (existing) return this.#rowToJob(existing);
				}
				const maxRow = this.#db.query("SELECT MAX(position) as max_pos FROM outbox").get() as {
					max_pos: number | null;
				} | null;
				const position = (maxRow?.max_pos ?? 0) + 1;
				const now = Date.now();

				this.#db.run(
					`INSERT INTO outbox (
						id, position, created_at, updated_at,
						session_id, session_file, branch_id, cwd,
						provider, model, thinking_level, approval_mode, session_name,
						text, attachments, image_links,
						state, reason, next_check_at, owner_pid, owner_token, cancel_requested,
						kind, resume_user_entry_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						position,
						now,
						now,
						input.sessionId,
						input.sessionFile,
						input.branchId ?? null,
						input.cwd,
						input.provider,
						input.model,
						input.thinkingLevel ?? null,
						input.approvalMode ?? null,
						input.sessionName ?? null,
						kind === "resume" ? "Resume when quota returns" : input.text,
						JSON.stringify(attachments),
						input.imageLinks ? JSON.stringify(input.imageLinks) : null,
						kind === "resume" ? "watching" : "queued",
						null,
						null,
						null,
						null,
						0,
						kind,
						kind === "resume" ? input.resumeUserEntryId! : null,
					],
				);

				const row = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
				if (!row) {
					throw new Error(`Failed to retrieve newly added job: ${id}`);
				}
				return this.#rowToJob(row);
			});

			return insertTx.immediate();
		} catch (error) {
			for (const file of writtenFiles) {
				try {
					fs.unlinkSync(file);
				} catch {}
			}
			throw error;
		}
	}

	list(): OutboxJob[] {
		const rows = this.#db.query("SELECT * FROM outbox ORDER BY position ASC, created_at ASC").all() as OutboxRow[];
		return rows.map(row => this.#rowToJob(row));
	}

	get(id: string): OutboxJob | undefined {
		const row = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
		return row ? this.#rowToJob(row) : undefined;
	}

	head(): OutboxJob | undefined {
		const row = this.#db
			.query(
				"SELECT * FROM outbox WHERE state NOT IN ('completed', 'cancelled') ORDER BY position ASC, created_at ASC LIMIT 1",
			)
			.get() as OutboxRow | null;
		return row ? this.#rowToJob(row) : undefined;
	}

	candidates(sessionId?: string): OutboxJob[] {
		const jobs = this.list();
		return jobs.filter(
			job =>
				(sessionId === undefined || job.sessionId === sessionId) &&
				job.state !== "completed" &&
				job.state !== "cancelled" &&
				!outboxJobBlocker(job, jobs),
		);
	}

	/** Earliest `next_check_at` among active candidates, or `undefined` if none are time-gated. */
	nextWakeAt(): number | undefined {
		const row = this.#db
			.query(
				"SELECT MIN(next_check_at) AS t FROM outbox WHERE state NOT IN ('completed', 'cancelled', 'attention') AND next_check_at IS NOT NULL",
			)
			.get() as { t: number | null } | null;
		return row?.t ?? undefined;
	}

	async readImages(job: OutboxJob): Promise<ImageContent[]> {
		const images: ImageContent[] = [];
		for (const attachment of job.attachments) {
			const file = Bun.file(attachment.path);
			const arrayBuffer = await file.arrayBuffer();
			const data = Buffer.from(arrayBuffer).toString("base64");
			images.push({
				type: "image",
				data,
				mimeType: attachment.mimeType,
			});
		}
		return images;
	}

	claim(sessionId: string, ownerPid: number): OutboxJob | undefined {
		const claimTx = this.#db.transaction(() => {
			if (!this.isArmed()) return undefined;

			const candidate = this.candidates(sessionId)[0];
			if (
				!candidate ||
				(candidate.state !== "queued" &&
					candidate.state !== "waiting" &&
					!(candidate.state === "watching" && candidate.kind === "resume"))
			)
				return undefined;
			const now = Date.now();
			if ((candidate.nextCheckAt ?? 0) > now) return undefined;

			const ownerToken = crypto.randomUUID();
			this.#db.run(
				`UPDATE outbox SET
					state = 'dispatching',
					owner_pid = ?,
					owner_token = ?,
					updated_at = ?
				WHERE id = ?`,
				[ownerPid, ownerToken, now, candidate.id],
			);

			const updated = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(candidate.id) as OutboxRow;
			return this.#rowToJob(updated);
		});

		return claimTx.immediate();
	}

	updateOwned(id: string, ownerToken: string, patch: OutboxJobPatch): boolean {
		const updateTx = this.#db.transaction(() => {
			const row = this.#db
				.query("SELECT * FROM outbox WHERE id = ? AND owner_token = ?")
				.get(id, ownerToken) as OutboxRow | null;

			if (!row) return false;

			const now = Date.now();
			const requestedState = patch.state ?? row.state;
			const newState =
				row.cancel_requested && patch.state && ["queued", "waiting", "watching", "attention"].includes(patch.state)
					? "cancelled"
					: row.kind === "resume" && (requestedState === "queued" || requestedState === "waiting")
						? "watching"
						: requestedState;

			let newReason = row.reason;
			let newNextCheckAt = row.next_check_at;

			if (patch.state !== undefined) {
				newReason = patch.reason ?? null;
				newNextCheckAt = patch.nextCheckAt ?? null;
			} else {
				if (patch.reason !== undefined) newReason = patch.reason;
				if (patch.nextCheckAt !== undefined) newNextCheckAt = patch.nextCheckAt;
			}

			let newOwnerPid = row.owner_pid;
			let newOwnerToken = row.owner_token;

			if (patch.state !== undefined) {
				if (
					patch.state === "queued" ||
					patch.state === "waiting" ||
					patch.state === "watching" ||
					patch.state === "attention" ||
					patch.state === "completed" ||
					patch.state === "cancelled"
				) {
					newOwnerPid = null;
					newOwnerToken = null;
				}
			}

			this.#db.run(
				`UPDATE outbox SET
					state = ?,
					reason = ?,
					next_check_at = ?,
					owner_pid = ?,
					owner_token = ?,
					updated_at = ?
				WHERE id = ? AND owner_token = ?`,
				[newState, newReason, newNextCheckAt, newOwnerPid, newOwnerToken, now, id, ownerToken],
			);

			return true;
		});

		return updateTx.immediate();
	}

	watch(id: string, patch: { reason: string; nextCheckAt?: number }): void {
		this.#db.run(
			`UPDATE outbox SET reason = ?, next_check_at = COALESCE(?, next_check_at), updated_at = ?
			WHERE id = ? AND kind = 'resume' AND state = 'watching' AND owner_token IS NULL AND owner_pid IS NULL`,
			[patch.reason, patch.nextCheckAt ?? null, Date.now(), id],
		);
	}

	retargetResume(
		id: string,
		patch: {
			resumeUserEntryId: string;
			branchId?: string | null;
			provider?: string;
			model?: string;
			thinkingLevel?: OutboxJob["thinkingLevel"];
			approvalMode?: OutboxJob["approvalMode"];
			sessionName?: string;
			state?: "watching";
		},
	): OutboxJob | undefined {
		const row = this.#db
			.query(
				`UPDATE outbox SET
					resume_user_entry_id = ?,
					branch_id = COALESCE(?, branch_id),
					provider = COALESCE(?, provider),
					model = COALESCE(?, model),
					thinking_level = COALESCE(?, thinking_level),
					approval_mode = COALESCE(?, approval_mode),
					session_name = COALESCE(?, session_name),
					state = COALESCE(?, state),
					reason = CASE WHEN ? IS NOT NULL THEN NULL ELSE reason END,
					next_check_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE next_check_at END,
					updated_at = ?
				WHERE id = ? AND kind = 'resume' AND state NOT IN ('completed', 'cancelled', 'running', 'dispatching') AND owner_token IS NULL
				RETURNING *`,
			)
			.get(
				patch.resumeUserEntryId,
				patch.branchId ?? patch.resumeUserEntryId,
				patch.provider ?? null,
				patch.model ?? null,
				patch.thinkingLevel ?? null,
				patch.approvalMode ?? null,
				patch.sessionName ?? null,
				patch.state ?? null,
				patch.state ?? null,
				patch.state ?? null,
				Date.now(),
				id,
			) as OutboxRow | null;
		return row ? this.#rowToJob(row) : undefined;
	}

	edit(id: string, changes: OutboxJobEdit): void {
		const editTx = this.#db.transaction(() => {
			const row = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
			if (!row) throw new Error(`Job not found: ${id}`);
			if (row.kind === "resume") throw new Error(`Cannot edit resume watch ${id}`);

			if (row.state === "completed" || row.state === "cancelled") {
				throw new Error(`Cannot edit terminal job ${id} (state: ${row.state})`);
			}

			if (row.state === "dispatching" || row.state === "running") {
				throw new Error(`Cannot edit active job ${id} (state: ${row.state})`);
			}

			if (changes.provider !== undefined && !changes.provider.trim()) {
				throw new Error("Provider cannot be empty");
			}

			if (changes.model !== undefined && !changes.model.trim()) {
				throw new Error("Model cannot be empty");
			}

			if (changes.text !== undefined) {
				let attachments: OutboxAttachment[];
				try {
					attachments = JSON.parse(row.attachments);
				} catch {
					throw new Error(`Corrupted outbox row ${id}: invalid attachments JSON`);
				}
				if (!Array.isArray(attachments)) {
					throw new Error(`Corrupted outbox row ${id}: attachments must be an array`);
				}
				if (!changes.text.trim() && attachments.length === 0) {
					throw new Error("Job text cannot be empty without attachments");
				}
			}

			const now = Date.now();
			this.#db.run(
				`UPDATE outbox SET
					text = COALESCE(?, text),
					provider = COALESCE(?, provider),
					model = COALESCE(?, model),
					thinking_level = CASE WHEN ? IS NOT NULL THEN ? ELSE thinking_level END,
					updated_at = ?
				WHERE id = ?`,
				[
					changes.text ?? null,
					changes.provider ?? null,
					changes.model ?? null,
					changes.thinkingLevel !== undefined ? 1 : null,
					changes.thinkingLevel ?? null,
					now,
					id,
				],
			);
		});

		editTx.immediate();
	}

	move(id: string, position: number): void {
		const moveTx = this.#db.transaction(() => {
			if (!Number.isInteger(position) || position < 1) {
				throw new Error(`Invalid position: ${position}`);
			}

			const job = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
			if (!job) throw new Error(`Job not found: ${id}`);

			if (job.state === "dispatching" || job.state === "running") {
				throw new Error(`Cannot move active job ${id}`);
			}

			if (job.state === "completed" || job.state === "cancelled") {
				throw new Error(`Cannot move terminal job ${id}`);
			}

			const rows = this.#db
				.query(
					"SELECT id, state, position FROM outbox WHERE state NOT IN ('completed', 'cancelled') ORDER BY position ASC, created_at ASC",
				)
				.all() as { id: string; state: OutboxState; position: number }[];

			const currentIdx = rows.findIndex(r => r.id === id);
			if (currentIdx === -1) {
				throw new Error(`Cannot reorder terminal job ${id}`);
			}

			const firstActiveIdx = rows.findIndex(r => r.state === "dispatching" || r.state === "running");
			const targetIdx = Math.min(Math.max(0, position - 1), rows.length - 1);

			if (firstActiveIdx !== -1 && targetIdx <= firstActiveIdx) {
				throw new Error(`Cannot move job to or before active head (active at position ${firstActiveIdx + 1})`);
			}

			const [removed] = rows.splice(currentIdx, 1);
			rows.splice(targetIdx, 0, removed!);

			const now = Date.now();
			for (let i = 0; i < rows.length; i++) {
				const newPos = i + 1;
				this.#db.run("UPDATE outbox SET position = ?, updated_at = ? WHERE id = ?", [newPos, now, rows[i]!.id]);
			}
		});

		moveTx.immediate();
	}

	cancel(id: string): void {
		const cancelTx = this.#db.transaction(() => {
			const row = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
			if (!row) throw new Error(`Job not found: ${id}`);

			if (row.state === "completed") {
				return;
			}
			if (row.state === "cancelled") {
				return;
			}

			const now = Date.now();
			if (row.state === "dispatching" || row.state === "running") {
				this.#db.run("UPDATE outbox SET cancel_requested = 1, updated_at = ? WHERE id = ?", [now, id]);
			} else {
				this.#db.run(
					"UPDATE outbox SET state = 'cancelled', owner_pid = NULL, owner_token = NULL, updated_at = ? WHERE id = ?",
					[now, id],
				);
			}
		});

		cancelTx.immediate();
	}

	remove(id: string): void {
		const attachments = this.#db.transaction(() => {
			const job = this.get(id);
			if (!job) throw new Error(`Job not found: ${id}`);
			if (job.state === "dispatching" || job.state === "running") {
				throw new Error("Cannot remove an active outbox job. Cancel it first and wait for it to stop.");
			}
			this.#checkPrivateDir(this.#attachmentsDir);
			const directory = fs.realpathSync(this.#attachmentsDir);
			for (const [index, attachment] of job.attachments.entries()) {
				const filename = `${id}-${index}.${safeAttachmentExtension(attachment.mimeType)}`;
				if (path.dirname(attachment.path) !== directory || path.basename(attachment.path) !== filename) {
					throw new Error(`Refusing to remove an attachment outside this job's saved files: ${attachment.path}`);
				}
			}
			this.#db.run("DELETE FROM outbox WHERE id = ?", [id]);
			return job.attachments;
		}).immediate();

		// Commit removal before cleanup so another worker cannot claim an entry with missing images.
		for (const attachment of attachments) {
			try {
				fs.rmSync(attachment.path, { force: true });
			} catch (error) {
				throw new Error(`Outbox job removed, but could not delete saved image ${attachment.path}`, { cause: error });
			}
		}
	}

	retry(id: string): void {
		const retryTx = this.#db.transaction(() => {
			const row = this.#db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
			if (!row) throw new Error(`Job not found: ${id}`);

			if (row.state === "completed") {
				throw new Error(`Cannot retry completed job ${id}`);
			}

			if (row.state === "dispatching" || row.state === "running") {
				throw new Error(`Cannot retry active job ${id}`);
			}

			const now = Date.now();
			this.#db.run(
				`UPDATE outbox SET
					state = ?,
					reason = NULL,
					next_check_at = NULL,
					owner_pid = NULL,
					owner_token = NULL,
					cancel_requested = 0,
					updated_at = ?
				WHERE id = ?`,
				[row.kind === "resume" ? "watching" : "queued", now, id],
			);
		});

		retryTx.immediate();
	}

	registerSession(sessionId: string, sessionFile: string, pid: number): void {
		const regTx = this.#db.transaction(() => {
			const existing = this.#db.query("SELECT * FROM session_registry WHERE session_id = ?").get(sessionId) as {
				session_file: string;
				pid: number;
			} | null;

			const now = Date.now();
			if (existing) {
				if (existing.pid === pid) {
					this.#db.run("UPDATE session_registry SET session_file = ?, updated_at = ? WHERE session_id = ?", [
						sessionFile,
						now,
						sessionId,
					]);
					return;
				}
				if (isPidAlive(existing.pid)) {
					return;
				}
				this.#db.run("DELETE FROM session_snapshots WHERE session_id = ? AND pid = ?", [sessionId, existing.pid]);
				this.#db.run("UPDATE session_registry SET session_file = ?, pid = ?, updated_at = ? WHERE session_id = ?", [
					sessionFile,
					pid,
					now,
					sessionId,
				]);
				return;
			}

			this.#db.run("INSERT INTO session_registry (session_id, session_file, pid, updated_at) VALUES (?, ?, ?, ?)", [
				sessionId,
				sessionFile,
				pid,
				now,
			]);
		});

		regTx.immediate();
	}

	publishSession(snapshot: OutboxSessionSnapshot): void {
		if (!isValidSessionSnapshot(snapshot)) throw new Error("Invalid outbox session snapshot");
		const pubTx = this.#db.transaction(() => {
			const existing = this.#db
				.query("SELECT * FROM session_registry WHERE session_id = ?")
				.get(snapshot.sessionId) as {
				session_file: string;
				pid: number;
			} | null;

			if (existing && existing.pid !== snapshot.pid && isPidAlive(existing.pid)) {
				return;
			}

			if (existing && existing.pid !== snapshot.pid) {
				this.#db.run("DELETE FROM session_snapshots WHERE session_id = ? AND pid = ?", [
					snapshot.sessionId,
					existing.pid,
				]);
			}

			this.#db.run(
				`INSERT INTO session_registry (session_id, session_file, pid, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					session_file = excluded.session_file,
					pid = excluded.pid,
					updated_at = excluded.updated_at`,
				[snapshot.sessionId, snapshot.sessionFile, snapshot.pid, snapshot.updatedAt],
			);

			const json = JSON.stringify(snapshot);
			this.#db.run(
				`INSERT INTO session_snapshots (session_id, pid, updated_at, snapshot_json)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id, pid) DO UPDATE SET
					updated_at = excluded.updated_at,
					snapshot_json = excluded.snapshot_json`,
				[snapshot.sessionId, snapshot.pid, snapshot.updatedAt, json],
			);
		});

		pubTx.immediate();
	}

	sessions(): OutboxSessionSnapshot[] {
		const rows = this.#db
			.query(`
			SELECT s.session_id, s.pid, s.snapshot_json, r.session_file
			FROM session_snapshots s
			JOIN session_registry r ON r.session_id = s.session_id AND r.pid = s.pid
			ORDER BY s.updated_at DESC
		`)
			.all() as {
			session_id: string;
			pid: number;
			snapshot_json: string;
			session_file: string;
		}[];
		return rows.map(row => {
			const snapshot: unknown = JSON.parse(row.snapshot_json);
			if (!isValidSessionSnapshot(snapshot) || snapshot.sessionId !== row.session_id || snapshot.pid !== row.pid) {
				throw new Error(`Invalid outbox session snapshot for ${row.session_id}`);
			}
			return { ...snapshot, sessionFile: row.session_file };
		});
	}

	unregisterSession(sessionId: string, pid: number): void {
		const unregTx = this.#db.transaction(() => {
			this.#db.run("DELETE FROM session_registry WHERE session_id = ? AND pid = ?", [sessionId, pid]);
			this.#db.run("DELETE FROM session_snapshots WHERE session_id = ? AND pid = ?", [sessionId, pid]);
		});
		unregTx.immediate();
	}

	sessionOwner(sessionId: string): SessionOwnerInfo | undefined {
		const row = this.#db
			.query("SELECT pid, session_file FROM session_registry WHERE session_id = ?")
			.get(sessionId) as { pid: number; session_file: string } | null;

		if (!row) return undefined;
		return { pid: row.pid, sessionFile: row.session_file };
	}
}
