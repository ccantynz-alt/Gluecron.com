// Navigation param types — extracted to a separate file to break circular imports.
// Screens import from here; navigators import from here.

export type MainStackParamList = {
  Dashboard: undefined;
  RepoList: undefined;
  RepoDetail: { owner: string; repo: string };
  FileViewer: { owner: string; repo: string; path: string; ref: string };
  IssueList: { owner: string; repo: string };
  IssueDetail: { owner: string; repo: string; number: number };
  PullList: { owner: string; repo: string };
  PullDetail: { owner: string; repo: string; number: number };
};
