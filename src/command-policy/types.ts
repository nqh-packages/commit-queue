export type CommitPolicy = {
  commitAll: boolean;
  noVerify: boolean;
  amend: boolean;
  pathspecs: string[];
};

export type ReservedCommitTrailer = {
  key: string;
  arg: string;
};

export type UnsafeAddPathspec = {
  path: string;
  reason: "wildcard" | "directory" | "matches_multiple_paths";
  matches?: string[];
};

export type UnsafeConfigMutation = {
  key: string;
  reason: "hook_config" | "hooks_path" | "config_editor";
};
