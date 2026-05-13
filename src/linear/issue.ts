/**
 * Normalized Linear issue representation used by the orchestrator.
 *  (struct).
 */
export interface BlockedByRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockedByRef[];
  assignedToWorker: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export function labelNames(issue: Issue): string[] {
  return issue.labels;
}

/**
 * Construct an Issue with sensible defaults, matching the Elixir struct
 * defaults (assignedToWorker: true, labels/blockedBy: []).
 */
export function makeIssue(partial: Partial<Issue> & Pick<Issue, "id" | "identifier" | "title" | "state">): Issue {
  return {
    description: null,
    priority: null,
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    assignedToWorker: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}
