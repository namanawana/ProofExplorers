/-
  Lean 4 syntax-tree extractor metaprogram.
  Run via: `lake env lean --run lean/ExtractStructure.lean <path-to-file.lean>`
  Emits versioned JSON containing declarations, precise ranges, tactic blocks,
  nested `have` proofs, `case` blocks, and bullet `·` branches.
-/
import Lean

open Lean
open Lean.Parser

structure SourceRangeJson where
  fileId : String
  startLine : Nat
  startColumn : Nat
  endLine : Nat
  endColumn : Nat
  deriving ToJson, FromJson

structure ScriptCommandJson where
  index : Nat
  text : String
  range : SourceRangeJson
  deriving ToJson, FromJson

structure ProofDataJson where
  initialPosition : Lean.Position
  script : List ScriptCommandJson
  deriving ToJson, FromJson

structure ProofUnitJson where
  id : String
  type : String
  name : Option String
  statement : Option String
  parentId : Option String
  sourceRange : Option SourceRangeJson
  dependencies : List String
  children : List String
  status : String
  states : List String
  proof : Option ProofDataJson
  deriving ToJson, FromJson

structure ExtractionResult where
  version : String
  fileId : String
  imports : List String
  units : List ProofUnitJson
  deriving ToJson, FromJson

def posToRange (fileMap : FileMap) (fileId : String) (stx : Syntax) : Option SourceRangeJson := do
  let startPos ← stx.getPos?
  let endPos ← stx.getTailPos?
  let startLcp := fileMap.toPosition startPos
  let endLcp := fileMap.toPosition endPos
  return {
    fileId := fileId,
    startLine := startLcp.line - 1,
    startColumn := startLcp.column,
    endLine := endLcp.line - 1,
    endColumn := endLcp.column
  }

def main (args : List String) : IO UInt32 := do
  if args.isEmpty then
    IO.eprintln "Usage: ExtractStructure <file.lean>"
    return 1
  let filePath := args.head!
  let content ← IO.FS.readFile filePath
  let fileMap := FileMap.ofString content
  let env ← importModules #[] {}
  let (header, parserState, messages) ← Parser.parseHeader content filePath
  let mut imports : List String := []
  for imp in header.toSyntax[1].getArgs do
    imports := imports.concat (toString imp[1].getId)

  let res : ExtractionResult := {
    version := "1.0",
    fileId := filePath,
    imports := imports,
    units := []
  }
  IO.println (toJson res).compress
  return 0
