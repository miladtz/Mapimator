import { createTransition, type Project, type SegmentRef, type Transition } from './project';

export function reorderProjectView(project: Project, viewId: string, targetIndex: number): Project {
  const sourceIndex = project.views.findIndex((view) => view.id === viewId);
  if (sourceIndex < 0 || project.views.length < 2) return project;
  const finalIndex = Math.max(0, Math.min(project.views.length - 1, targetIndex));
  if (sourceIndex === finalIndex) return project;
  const views = [...project.views];
  const [moved] = views.splice(sourceIndex, 1);
  views.splice(finalIndex, 0, moved);
  const outgoingBySource = new Map<string, Transition>();
  for (const transition of project.transitions)
    if (!outgoingBySource.has(transition.fromViewId)) outgoingBySource.set(transition.fromViewId, transition);
  const usedIds = new Set<string>();
  const transitions: Transition[] = [];
  views.forEach((view, index) => {
    const next = views[index + 1];
    const existing = outgoingBySource.get(view.id);
    if (next) {
      const outgoing = existing
        ? { ...existing, fromViewId: view.id, toViewId: next.id }
        : createTransition(view.id, next.id, project.layers, view);
      transitions.push(outgoing);
      usedIds.add(outgoing.id);
    } else if (existing) {
      transitions.push(existing);
      usedIds.add(existing.id);
    }
  });
  for (const transition of project.transitions) if (!usedIds.has(transition.id)) transitions.push(transition);
  return { ...project, views, transitions };
}

export function resolveSelectionAfterViewReorder(
  project: Project,
  selection: SegmentRef | null,
): SegmentRef | null {
  if (!selection || selection.kind === 'view') return selection;
  const transition = project.transitions.find((candidate) => candidate.id === selection.id);
  if (!transition) return null;
  const sourceIndex = project.views.findIndex((view) => view.id === transition.fromViewId);
  const active =
    sourceIndex >= 0 &&
    sourceIndex < project.views.length - 1 &&
    project.views[sourceIndex + 1].id === transition.toViewId;
  return active ? selection : { kind: 'view', id: transition.fromViewId };
}
