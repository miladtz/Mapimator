import type { Project } from './project';

export interface FileSystemAdapter {
  saveProject(project: Project): Promise<void>;
  openProject(): Promise<Project | null>;
}

const STORAGE_KEY = 'mapmotion-phase-1-project';

export const browserFileSystemAdapter: FileSystemAdapter = {
  async saveProject(project) { localStorage.setItem(STORAGE_KEY, JSON.stringify(project)); },
  async openProject() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) as Project : null;
  }
};
