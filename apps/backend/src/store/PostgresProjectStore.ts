/**
 * PostgresProjectStore - durable PostgreSQL implementation of ProjectStore.
 *
 * Implements P8-01:
 *   - Persistent projects, files, proof_units, and dependencies
 *   - Strict constraints, foreign keys, and indexes
 *   - Lazy one-level structure queries (Invariant 6)
 */
import type { Pool } from "pg";
import type {
  Dependency,
  Project,
  ProjectFile,
  ProofUnit,
  StructureNode,
} from "@proof-explorer/protocol";
import { extractDependencies } from "../analysis/DependencyAnalyzer";
import type {
  AnalyzedFile,
  AnalyzedUnit,
  StructureAnalyzer,
} from "../analysis/StructureAnalyzer";
import { AppError, newId, sha256, type Clock } from "../util/index";
import type { DependencyView, ProjectStore } from "./ProjectStore";

export class PostgresProjectStore implements ProjectStore {
  // Memory cache of file content and in-memory analyzed structures for fast execution
  private readonly fileContents = new Map<string, string>();
  private readonly analyses = new Map<string, AnalyzedFile>();

  constructor(
    private readonly pool: Pool,
    private readonly analyzer: StructureAnalyzer,
    private readonly clock: Clock,
  ) {}

  async createProject(name: string): Promise<Project> {
    const id = newId();
    const createdAt = this.clock.now();
    await this.pool.query(
      `INSERT INTO projects (id, name, created_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
      [id, name, createdAt],
    );
    return { id, name, createdAt };
  }

  async getProject(id: string): Promise<Project | undefined> {
    const res = await this.pool.query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM projects WHERE id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    return { id: r.id, name: r.name, createdAt: r.created_at.getTime() };
  }

  async addFile(projectId: string, path: string, content: string): Promise<ProjectFile> {
    const proj = await this.getProject(projectId);
    if (!proj) {
      throw new AppError("INVALID_MESSAGE", `Unknown project ${projectId}`);
    }

    const fileId = newId();
    const analysis = this.analyzer.analyze(fileId, content);
    const edges = extractDependencies(analysis);
    const hash = sha256(content);
    const lineCount = analysis.lines.length;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO files (id, project_id, path, content_hash, line_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [fileId, projectId, path, hash, lineCount],
      );

      for (const u of analysis.units) {
        const unit = u.unit;
        const sr = unit.sourceRange;
        await client.query(
          `INSERT INTO proof_units (
            id, file_id, parent_id, type, name, statement, status,
            start_line, start_column, end_line, end_column, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING`,
          [
            unit.id,
            fileId,
            unit.parentId ?? null,
            unit.type,
            unit.name ?? null,
            unit.statement ?? null,
            unit.status,
            sr?.startLine ?? null,
            sr?.startColumn ?? null,
            sr?.endLine ?? null,
            sr?.endColumn ?? null,
            JSON.stringify(unit.metadata ?? {}),
          ],
        );
      }

      for (const edge of edges) {
        await client.query(
          `INSERT INTO dependencies (
            id, from_unit_id, to_unit_id, kind, evidence_kind, ev_line, ev_column
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING`,
          [
            edge.id,
            edge.fromUnitId,
            edge.toUnitId,
            edge.kind,
            edge.evidence.kind,
            edge.evidence.range.startLine,
            edge.evidence.range.startColumn,
          ],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    this.fileContents.set(fileId, content);
    this.analyses.set(fileId, analysis);

    return {
      id: fileId,
      projectId,
      path,
      contentHash: hash,
      lineCount,
    };
  }

  async getFile(fileId: string): Promise<{ file: ProjectFile; content: string } | undefined> {
    const res = await this.pool.query<{
      id: string;
      project_id: string;
      path: string;
      content_hash: string;
      line_count: number;
    }>(
      `SELECT id, project_id, path, content_hash, line_count FROM files WHERE id = $1`,
      [fileId],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    const content = this.fileContents.get(fileId) ?? "";
    return {
      file: {
        id: r.id,
        projectId: r.project_id,
        path: r.path,
        contentHash: r.content_hash,
        lineCount: r.line_count,
      },
      content,
    };
  }

  async getFileAnalysis(fileId: string): Promise<AnalyzedFile | undefined> {
    return this.analyses.get(fileId);
  }

  async structure(parentId: string): Promise<StructureNode[]> {
    const res = await this.pool.query<{
      id: string;
      type: ProofUnit["type"];
      name: string | null;
      status: ProofUnit["status"];
      start_line: number | null;
      start_column: number | null;
      end_line: number | null;
      end_column: number | null;
      file_id: string;
      child_count: string;
    }>(
      `SELECT p.id, p.type, p.name, p.status, p.start_line, p.start_column, p.end_line, p.end_column, p.file_id,
              COUNT(c.id) AS child_count
       FROM proof_units p
       LEFT JOIN proof_units c ON c.parent_id = p.id
       WHERE p.parent_id = $1
       GROUP BY p.id`,
      [parentId],
    );

    return res.rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name ?? undefined,
      status: r.status,
      childCount: Number(r.child_count),
      sourceRange:
        r.start_line !== null && r.start_column !== null && r.end_line !== null && r.end_column !== null
          ? {
              fileId: r.file_id,
              startLine: r.start_line,
              startColumn: r.start_column,
              endLine: r.end_line,
              endColumn: r.end_column,
            }
          : undefined,
    }));
  }

  async getUnit(unitId: string): Promise<AnalyzedUnit | undefined> {
    for (const a of this.analyses.values()) {
      const u = a.units.find((x) => x.unit.id === unitId);
      if (u) return u;
    }
    return undefined;
  }

  async dependencies(unitId: string): Promise<DependencyView> {
    const res = await this.pool.query<{
      id: string;
      from_unit_id: string;
      to_unit_id: string;
      kind: Dependency["kind"];
      evidence_kind: Dependency["evidence"]["kind"];
      ev_line: number;
      ev_column: number;
    }>(
      `SELECT id, from_unit_id, to_unit_id, kind, evidence_kind, ev_line, ev_column
       FROM dependencies
       WHERE from_unit_id = $1 OR to_unit_id = $1`,
      [unitId],
    );

    const edges: Dependency[] = res.rows.map((r) => ({
      id: r.id,
      fromUnitId: r.from_unit_id,
      toUnitId: r.to_unit_id,
      kind: r.kind,
      evidence: {
        kind: r.evidence_kind,
        range: {
          fileId: "unknown",
          startLine: r.ev_line,
          startColumn: r.ev_column,
          endLine: r.ev_line,
          endColumn: r.ev_column + 1,
        },
      },
    }));

    return {
      dependsOn: edges.filter((e) => e.fromUnitId === unitId),
      usedBy: edges.filter((e) => e.toUnitId === unitId),
    };
  }
}
