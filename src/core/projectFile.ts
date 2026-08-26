import type { Project } from './project';
import { validateAndMigrateProject } from './projectPersistence';

export const PROJECT_FILE_EXTENSION = 'mapmotion';

export function normalizeDialogPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function serializeCanonicalProject(project: Project): { project: Project; json: string } {
  // JSON conversion rejects browser handles/cycles and converts the value into
  // the exact representation that will be persisted. Validation then rejects
  // non-finite and malformed fields before any native write is attempted.
  const jsonValue = JSON.parse(JSON.stringify(project)) as unknown;
  const normalized = validateAndMigrateProject(jsonValue);
  return { project: normalized, json: `${JSON.stringify(normalized, null, 2)}\n` };
}

export function parseProjectFile(json: string): Project {
  return validateAndMigrateProject(JSON.parse(json) as unknown);
}
