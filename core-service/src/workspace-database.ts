import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { basename } from "path";

export interface WorkspaceTableSummary {
	name: string;
	type: "table" | "view";
	rows: number;
	fields: number;
}

export interface WorkspaceTableColumn {
	name: string;
	type: string;
}

export interface WorkspaceTableRows {
	table: string;
	columns: WorkspaceTableColumn[];
	rows: unknown[][];
	totalRows: number;
	limit: number;
	offset: number;
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: string): string {
	return `"${value.replace(/"/g, "\"\"")}"`;
}

function toInt(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function duckDbCommands(): string[] {
	return [
		process.env.DUCKDB_BIN,
		"duckdb",
		"/opt/homebrew/bin/duckdb",
		"/usr/local/bin/duckdb",
		"/usr/bin/duckdb",
	].filter((cmd): cmd is string => Boolean(cmd));
}

export class WorkspaceDatabase {
	readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	get exists(): boolean {
		return existsSync(this.dbPath);
	}

	get filename(): string {
		return basename(this.dbPath);
	}

	private query<T = Record<string, unknown>>(sql: string): T[] {
		if (!this.exists) return [];
		for (const command of duckDbCommands()) {
			try {
				const out = execFileSync(command, ["-json", this.dbPath, sql], {
					encoding: "utf-8",
					maxBuffer: 20 * 1024 * 1024,
				}).trim();
				if (!out) return [];
				return JSON.parse(out) as T[];
			} catch {
				// Try the next common DuckDB binary path.
			}
		}
		return [];
	}

	listTables(): WorkspaceTableSummary[] {
		if (!this.exists) return [];
		const tables = this.query<{ table_name: string; table_type: string }>(`
			SELECT table_name, table_type
			FROM information_schema.tables
			WHERE table_schema = 'main'
			  AND table_type IN ('BASE TABLE', 'VIEW')
			ORDER BY table_name
		`);

		return tables.map((table) => {
			const name = table.table_name;
			const rowCount = this.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count FROM ${sqlIdentifier(name)}`)[0]?.count ?? 0;
			const fieldCount = this.query<{ count: number }>(`
				SELECT COUNT(*)::INTEGER AS count
				FROM information_schema.columns
				WHERE table_schema = 'main'
				  AND table_name = ${sqlString(name)}
			`)[0]?.count ?? 0;
			return {
				name,
				type: table.table_type === "VIEW" ? "view" : "table",
				rows: toInt(rowCount),
				fields: toInt(fieldCount),
			};
		});
	}

	getTableRows(tableName: string, opts: { limit?: number; offset?: number } = {}): WorkspaceTableRows | undefined {
		const table = this.listTables().find((item) => item.name === tableName);
		if (!table) return undefined;

		const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
		const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
		const columns = this.query<{ column_name: string; data_type: string }>(`
			SELECT column_name, data_type
			FROM information_schema.columns
			WHERE table_schema = 'main'
			  AND table_name = ${sqlString(tableName)}
			ORDER BY ordinal_position
		`).map((column) => ({ name: column.column_name, type: column.data_type }));
		const records = this.query<Record<string, unknown>>(
			`SELECT * FROM ${sqlIdentifier(tableName)} LIMIT ${limit} OFFSET ${offset}`,
		);

		return {
			table: tableName,
			columns,
			rows: records.map((record) => columns.map((column) => record[column.name] ?? "")),
			totalRows: table.rows,
			limit,
			offset,
		};
	}
}
