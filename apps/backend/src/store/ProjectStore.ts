/**
 * ProjectStore - projects, files, analysed structure and the dependency DAG.
 *
 * This is the read side the REST layer queries. It is deliberately separate
 * from the ProofEngine: browsing the structure of a 10,000-line development
 * must not require a running Lean session.
 *
 * Lazy-loading contract (Invariant 6): `structure()` returns ONE level of the
 * tree at a time as lightweight StructureNodes; full ProofUnits and
 * dependency edges are fetched per unit on demand.
 *
 * The in-memory implementation below is the reference; a Postgres version
 * implements the same interface against `projects/files/proof_units/
 * dependencies` (db/schema.sql).
 */
import type {
  Dependency,
  Project,
  ProjectFile,
  ProofUnit,
  StructureNode,
} from "@proof-explorer/protocol";
import {
  extractDependencies,
} from "../analysis/DependencyAnalyzer";
import type {
  AnalyzedFile,
  AnalyzedUnit,
  StructureAnalyzer,
} from "../analysis/StructureAnalyzer";
import { AppError, newId, sha256, systemClock, type Clock } from "../util/index";

export interface DependencyView {
  dependsOn: Dependency[]; // edges where this unit is the dependent
  usedBy: Dependency[]; // edges where this unit is the dependency
}

export interface ProjectStore {
  createProject(name: string): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  addFile(projectId: string, path: string, content: string): Promise<ProjectFile>;
  getFile(fileId: string): Promise<{ file: ProjectFile; content: string } | undefined>;
  /** Children of `parentId` (a file id or a unit id). One level only. */
  structure(parentId: string): Promise<StructureNode[]>;
  getUnit(unitId: string): Promise<AnalyzedUnit | undefined>;
  getFileAnalysis(fileId: string): Promise<AnalyzedFile | undefined>;
  dependencies(unitId: string): Promise<DependencyView>;
}

interface StoredFile {
  file: ProjectFile;
  content: string;
  analysis: AnalyzedFile;
  edges: Dependency[];
}

export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, Project>();
  private readonly files = new Map<string, StoredFile>();
  private readonly unitIndex = new Map<string, { fileId: string; unit: AnalyzedUnit }>();

  constructor(
    private readonly analyzer: StructureAnalyzer,
    private readonly clock: Clock = systemClock,
  ) {}

  async createProject(name: string): Promise<Project> {
    const project: Project = { id: newId(), name, createdAt: this.clock.now() };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(id: string) {
    return this.projects.get(id);
  }

  async addFile(projectId: string, path: string, content: string): Promise<ProjectFile> {
    if (!this.projects.has(projectId)) {
      throw new AppError("INVALID_MESSAGE", `Unknown project ${projectId}`);
    }
    if (!path.toLowerCase().endsWith(".lean") || path.includes("..") || path.startsWith("/") || path.startsWith("\\")) {
      throw new AppError("INVALID_MESSAGE", "Only safe .lean paths are allowed");
    }
    if (content.length > 20 * 1024 * 1024) {
      throw new AppError("INVALID_MESSAGE", "Lean file exceeds the 20 MB limit");
    }
    const fileId = newId();
    const analysis = this.analyzer.analyze(fileId, content);
    const edges = extractDependencies(analysis);
    const file: ProjectFile = {
      id: fileId,
      projectId,
      path,
      contentHash: sha256(content),
      lineCount: analysis.lines.length,
    };
    this.files.set(fileId, { file, content, analysis, edges });
    for (const u of analysis.units) this.unitIndex.set(u.unit.id, { fileId, unit: u });
    return file;
  }

  async getFile(fileId: string) {
    const f = this.files.get(fileId);
    return f ? { file: f.file, content: f.content } : undefined;
  }

  async getFileAnalysis(fileId: string) {
    return this.files.get(fileId)?.analysis;
  }

  async structure(parentId: string): Promise<StructureNode[]> {
    // The root of a file is represented by the synthetic file id, not by a
    // ProofUnit entry. The previous implementation looked only in unitIndex,
    // which made every uploaded file appear as "No units loaded".
    const file = this.files.get(parentId);
    if (file) {
      const roots = file.analysis.units.filter((u) => u.unit.parentId === file.file.id);
      return roots.map((u) => toNode(u.unit));
    }

    const parent = this.unitIndex.get(parentId)?.unit.unit;
    if (!parent) return [];
    return parent.children.flatMap((cid) => {
      const u = this.unitIndex.get(cid)?.unit.unit;
      return u ? [toNode(u)] : [];
    });
  }

  async getUnit(unitId: string) {
    return this.unitIndex.get(unitId)?.unit;
  }

  async dependencies(unitId: string): Promise<DependencyView> {
    const entry = this.unitIndex.get(unitId);
    if (!entry) return { dependsOn: [], usedBy: [] };
    const edges = this.files.get(entry.fileId)?.edges ?? [];
    return {
      dependsOn: edges.filter((e) => e.fromUnitId === unitId),
      usedBy: edges.filter((e) => e.toUnitId === unitId),
    };
  }
}

const toNode = (u: ProofUnit): StructureNode => ({
  id: u.id,
  type: u.type,
  name: u.name,
  status: u.status,
  childCount: u.children.length,
  sourceRange: u.sourceRange,
});
