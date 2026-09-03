import type * as Y from "yjs";

// Declarative validation of a document's tree, declared per site in `.world.json`
// (`docs` section) and enforced on every commit. Filled in by the schema work; until
// then every document is unconstrained beyond size.

export interface Violation {
  rule: string;
  message: string;
}

export interface DocSchema {
  root: string;
}

export async function docSchemaFor(_site: string, _name: string): Promise<DocSchema | null> {
  return null;
}

export function validateTree(_doc: Y.Doc, _schema: DocSchema): Violation | null {
  return null;
}
