# Changelog

## Unreleased

### Git Workspace — Changes and diff (stage 3)

- Root and initialized submodule checkouts now share grouped, filterable Changes with tree/list and file navigation; opening a child change shows that checkout's real diff in the existing editor.
- Explicit HEAD, index, worktree and commit sides preserve rename paths and unborn HEAD. Binary, oversized, non-UTF-8, symlink, mode and gitlink changes receive appropriate views; gitlink changes can open child Changes.
- Diff mode, file selection and scroll position are isolated by Git context. Existing CLI diff/open-changed paths remain supported; Git context reads stay authorized by the execution host.
- This stage adds no child checkout mutations, commit workflow or history view.

### Git Workspace — Stage, commit and safe discard (stage 4)

- Source Control now stages and unstages whole files, hunks and selected lines against the exact issued diff; the host builds the patch, re-checks HEAD/index/file content and rejects a stale or foreign selection instead of applying it to new content.
- Commits take exactly the real index. A host preview lists the staged set with unborn/detached state; hooks and signing run unchanged, their failures are shown with a real-state refresh, and a dropped request is reported as an unknown outcome with no automatic retry.
- Discard has a preview, explicit confirmation and a recovery copy under the checkout's Git metadata; it refuses when no copy can be stored, never removes untracked files, and can restore the copy only while the file is unchanged.
- Child contexts have their own commit message draft and commit surface. Staging a submodule gitlink records the reviewed child commit in the parent index and leaves the child checkout, index and history untouched.
- All Orca Git writes share one queue per common Git directory, including linked worktrees. Viewing continues to be read-only; no hidden `add --all`, stash, `reset --hard`, `clean` or force action is added.

### Git Workspace — History, graph and revision comparison (stage 5)

- Source Control has a Log view for the selected Git context (root or submodule), reachable from the view switch, the contexts popup, the Changes header and a gitlink diff's Open child Log. It reuses the existing `git.history` reader, graph model, row renderer and commit-diff tabs.
- History loads in pinned pages: the first page resolves the browsed revision to a full object id and later pages carry that id plus a generation token. A page from another generation is never appended; HEAD/ref changes (including an external commit) reload the first page instead of mixing histories.
- Filters cover a revision selector (HEAD, local/remote branches, tags), a path filter and a case-insensitive message filter. The list is virtualized while the graph keeps every lane across appended pages. Unborn checkouts show an explicit empty history and detached HEAD is labeled with its commit id.
- Merge commits expose every parent and let the user choose the comparison base; changed files use the existing commit-compare reader. "Use as compare base" compares any two revisions and opens the existing commit diff with both sides pinned. Missing local objects are reported explicitly with no fetch or lazy-fetch.
- `git.history` and `git.commitCompare` gained optional `contextId`, `revision`, `cursor`, `path`, `message` and `baseOid` fields across IPC, runtime RPC, preload and the web client. Context-id reads are authorized by a fresh discovery pass, so a child history is never answered from its parent and a context from another worktree is rejected.

### Git Workspace — Branches, remotes and integration (stage 6)

- The contexts popup now performs real branch/remote actions for the selected root or submodule: New Branch, checkout of a local branch, a remote branch (creating a tracking local branch), a tag or a full commit id (detached HEAD), explicit Merge/Rebase, Fetch and Push. Browsing a context or a ref still changes nothing; every write is a separate action.
- All actions use the existing `git.mutate`/`git:mutate` service, context authorization and common-git-dir queue. Checkout/New Branch/merge/rebase/continue/abort require the reviewed HEAD; a checkout refuses a branch attached to another live worktree, an unfinished operation, conflicts, or local changes that the target would overwrite. Orca does not stash, force, `reset --hard` or `clean`.
- Refs show upstream plus ahead/behind computed only from locally loaded remote-tracking refs, together with the refs read time and this checkout's last fetch time. The UI states that no fetch runs automatically.
- Fetch and push take an explicit configured remote (never a URL) and an explicit branch. They use the execution host's SSH/credential policy, stream parsed progress percentages over `git.mutationProgress`, and run `--no-recurse-submodules`. Push has no force option and distinguishes rejection/non-fast-forward, authentication failure, known network failure and an unknown outcome; an unknown result is not retried and the UI re-reads the real state first.
- Merge/rebase are explicit and require a clean tree. A conflict is reported as unfinished, never as success. The repository state now exposes `operationInProgress` from real Git markers, and the popup and Changes show Continue/Abort for the detected merge/rebase. A full conflict resolver remains a later stage.
- `git.status(includeWorkspace)` reports the richer refs, `refsReadAt`, `lastFetchAt` and remote names; `git.mutate` gained the branch/remote actions and `expectedHead`/`expectedRefOid`/`progressId` fields across IPC, runtime RPC, preload and the web client.

### Git Workspace — Submodule maintenance and dependency-safe batches (stage 7)

- Submodules now offers offline, host-issued reviews for initialization with explicit recursion, parent-index versus local remote-tracking checkout, URL synchronization, and add/remove in the selected parent context. Detached checkouts can use the existing New Branch action before development and publication.
- Initialization validates each newly discovered level rather than passing an unchecked recursive Git command. Relative URLs are resolved on the execution host; browsing and previews do not fetch or clone.
- Add refuses unrelated `.gitmodules` changes. Remove stages only the reviewed gitlink deletion and edits its worktree declaration, retaining checkout files, unpublished commits, local configuration and Git metadata; no force, cleanup or hidden stash is used.
- Selected-context batches commit staged changes from leaves to root, pausing for the exact resulting child OID at every parent gitlink. Publication is child-first and checks real remote reachability plus the destination URL recorded in the published parent. Missing or unverifiable objects/remotes block the parent.
- Per-step results and bounded, read-only progress inspection use the existing mutation transport. Every step rechecks dependencies without holding multiple repository queues. Only a known-failed step can be explicitly retried; completed and unknown operations are never automatically replayed.
