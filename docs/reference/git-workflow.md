# Git and Review Work

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline.

## Git Scan Safety

- Never enumerate every ref and then run `git ls-tree -r` or `git show` once per ref. That ref × tree fan-out can retain gigabytes of output before a downstream `sort -u` or search can make progress.
- Prefer `rg` over the checked-out files for source searches. For history or refs, use a named ref, an explicit namespace/path, `--max-count`, and a bounded output; do not use an unqualified `--all` scan as a first diagnostic.
- Keep repository-wide commands targeted to the current repository and worktree. If an unbounded scan is genuinely required, measure the ref count first, explain the cost, and get confirmation before running it.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## Git Context Catalog

Source Control → Submodules lists the registered root and recursively discovered local submodule contexts, including clean and uninitialized entries. Select an initialized row for the same Changes and diff viewer used by the root checkout; Refresh, filesystem/metadata events and returning focus reconcile the snapshot.

`git.status` / `window.api.git.status` accept `includeWorkspace: true`; the optional `workspace` response contains host-issued context identities, repository states, submodule metadata and per-context errors. The host derives execution identity after worktree authorization. Existing callers that do not request the catalog retain their normal status path.

Discovery merges HEAD/index gitlinks, `.gitmodules` from HEAD/index/worktree and local configuration. A declaration alone never authorizes reading a checkout. Checkout paths and Git metadata pointers are checked against canonical workspace boundaries; symlink escapes are denied. Dirty files, conflicts, changed checkout HEAD and staged parent gitlinks are independent states.

Browsing never fetches or clones, including promisor lazy-fetch. Unknown or bounded descendants remain explicitly incomplete: traversal is limited to depth 16, 128 contexts/rows and 4 concurrent contexts; metadata commands have an 8 MiB output bound and 15-second timeout. Unsupported non-UTF-8 metadata is reported instead of decoding identities lossily. A snapshot token is not a write authorization or an atomic filesystem snapshot.

If ordinary root porcelain fails because a child checkout is broken, the same safe workspace reader recovers real root changes and retains the discovery errors instead of reporting a clean workspace. Writes and previews require a complete selected repository and its own fresh state; an unavailable sibling does not block a healthy context's commit. Lifecycle and dependency-batch operations retain their broader completeness checks.

### Git contexts and branches popup

Click the current branch/detached identity in Source Control, or press **Ctrl+Alt+G** from any activity view. The shortcut opens Source Control if necessary. The two-pane picker shares the Submodules catalog and selected context; choosing or hovering a repository never checks out a branch.

The left pane includes Root and all known submodules, including clean, conflicted and uninitialized checkouts. Names are disambiguated by full workspace-relative paths; context colors are deterministic. Switch Tree/Flat, collapse parents, or search by name/path. The right pane identifies the selected path and searches only its local refs, grouped into Recent, Local, Remote and Tags. These are locally available refs, not a claim about the current remote server.

Both panes are constrained to the dialog's bounded grid track. Long repository results scroll independently, so the last context remains reachable by pointer or keyboard without spilling below the modal.

Enter on a repository enters its refs pane; Enter on a ref inspects its full name/OID/upstream without mutation. Up/Down move through results, Right enters the context menu, Left returns to repository search (from ref search, at the start of the text), and Escape closes with focus restoration to the invoking control when it is still present. Tab reaches favorites, tree controls and Open Changes. Open Changes selects the exact context for the shared Changes list and diff tabs, not the parent checkout.

Favorites, recently inspected refs, ref search and inspected ref persist per host-issued context identity in the renderer profile. Recent means **inspected**, not checked out; checkout is a separate explicit action. A new context gets its own keyed refs surface immediately, so loading cannot display another repository's refs. Filesystem/metadata events and focus reconciliation refresh both surfaces. Uninitialized entries explain unavailable refs and unknown descendants; their maintenance actions are in Submodules (Stage 7).

`git.status` / preload status accept `workspaceRefsContextId` together with `includeWorkspace`. This is a selector, not a path or authority: refs are read only for a matching context in the host-authorized discovery. The existing argv-based Git runner reads heads/remotes/tags with a 10000-ref limit, the existing 8 MiB output bound and no lazy fetch/network. Revalidation rejects contexts whose checkout identity changes during discovery.

## Changes and Diff (Stage 3)

The Changes tab and the selected Submodules context share one grouped file list: Conflicts, Unstaged, Staged and Untracked. Search filters paths, Tree/List switches presentation, and Previous/Next file navigates filtered changes. Selection and list scroll position are kept separately for each host-issued context identity; opening a child file never stages or commits its parent. Parent commit and branch actions are hidden while child Changes are selected.

Opening a file lazily reads an explicit pair of Git sides: HEAD → index for Staged, index → worktree for Unstaged, and empty → worktree for Untracked. Rename labels preserve both paths; unborn HEAD means an absent side, not a failed checkout. Commit and branch comparison routes also use the same bounded reader. Existing `file diff` and `file open-changed` CLI routes remain supported; the renderer's child-context selection is validated again on the execution host before reading.

Unstaged reads skip the status lookup used only for staged renames. Ordinary blobs use one bounded binary capture instead of a separate size subprocess; an overflow yields the explicit large representation, and its total size can be unknown. An absent `.gitmodules` is checked in the existing host filesystem namespace before attempting its Git configuration read. These optimizations retain the existing state/content fences and two-second racy-write exclusion for settled diff caching.

For index-to-worktree staging candidates, the pre-patch fence also supplies the exact index records used to read the displayed base, avoiding a duplicate index subprocess. The Git patch is still followed by a full fresh HEAD/index/content fence comparison; an index change during the blob read produces a stale document without a writable selection token.

Monaco diff tabs offer Side by side and Unified per context, plus their existing word highlighting, context folding and hunk navigation. Both sides show source, path, mode, line endings and absent/newline status. Binary files retain the existing binary viewer; large files (over 8 MiB), unsupported UTF-8, symlinks and unresolved index stages have explicit non-editable presentations. Mode-only changes show modes alongside the text viewer. Gitlink changes are restored from authorized HEAD/index/child metadata despite the catalog's `--ignore-submodules=all` porcelain read: they show old/new commit IDs and offer Open child Changes when the checkout is available. Viewing never runs a fetch or Git mutation.

Filesystem and Git metadata changes refresh the authorized catalog and reload open clean diff tabs. In-flight responses for an old tab/context are ignored; a read whose Git/worktree stamp changed during loading is labeled stale until reloaded. This is a read fence, not an atomic snapshot or write authority. Child-context stage/commit/discard arrived with Stage 4; history arrived with Stage 5.

## Log, Graph and Revision Comparison (Stage 5)

Source Control now has a **Log** view for the selected Git context, reachable from the view switch, the contexts popup's **Open Log**, the Changes header and a gitlink diff's **Open child Log**. History is read only through the existing `git.history` route and the shared log reader; no second history backend exists.

History loads in pages of 50 (200 maximum per request). The first page resolves the browsed revision (HEAD, a local/remote branch, a tag or a full commit id) to a full object id, and every later page is pinned to that id. Each page also carries a `generation` token over the tip and filters; a page whose generation or tip differs is never appended and the list reloads from a new first page. HEAD/ref changes (including an external commit followed by focus) invalidate the loaded pages, so a late response cannot mix two histories. At most 5000 already-loaded commits may be skipped; deeper browsing requires narrowing the filters.

Filters are a revision selector, a repository-relative path filter (`git log -- <path>`) and a case-insensitive commit-message filter. Reading is local: the history reader uses the existing offline Git runner (`GIT_NO_LAZY_FETCH`, no protocol allowed, no external diff), an 8 MiB output bound and a 15-second timeout. A referenced object that is missing locally produces an explicit "not available locally; no fetch was attempted" error rather than a network read.

The list is virtualized: only rows near the viewport are mounted, while the graph model keeps every lane so appended pages retain their connections. Unborn or empty checkouts show "No commits in this checkout yet"; detached HEAD is labeled with its short object id instead of a branch name.

The selected commit's details show its full parent list. A merge commit offers each parent as the explicit comparison base (the first parent by default); the changed file list uses the existing commit-compare reader with `parentOid`/`baseOid` and the same commit-diff tabs. **Use as compare base** switches to comparing any two revisions: choosing another commit lists `base..target` changes and opens the existing diff for a file with both sides pinned to full commit ids. Root contexts additionally keep the existing combined "open all changes" surface; child contexts open per-file commit diffs through the context-authorized `git.diff` selection.

Every history and commit-compare read that names a `contextId` is authorized by a fresh workspace discovery pass and a checkout identity re-verification. A child checkout's history is never answered from its parent's commits, and a context borrowed from another worktree is rejected. Log browsing performs no fetch, clone, checkout, index or ref write; the Electron smoke compares real HEAD/refs/index/status before and after.

## Branches, Remotes and Integration (Stage 6)

The contexts popup carries explicit branch and remote actions for the selected root or submodule. Selecting or hovering a repository/ref remains inspection only: New Branch, Checkout, Merge, Rebase, Fetch and Push run only when their native button is activated. The same host mutation service (`git.mutate` / `git:mutate`) and common-git-dir queue perform the work; there is no second Git backend and no route around the context authorization or state fences.

Checkout requires the HEAD that was reviewed (`expectedHead`; an empty value means an unborn checkout) and re-reads the workspace before writing. A local branch is checked out by its short name (a full `refs/heads/…` checkout target would detach HEAD). A remote branch creates a local branch with `--track`; a tag or a full commit id checks out detached. Checkout refuses when the branch is attached to another live worktree (`git worktree list --porcelain -z` and the real path), when an operation is unfinished or conflicted, or when local changes would be overwritten by the paths that differ between current HEAD and the target. Unrelated local changes are preserved. New Branch validates the name with `check-ref-format`, then creates and checks it out; starting from a remote ref sets tracking.

Checkout and New Branch explicitly override `submodule.recurse=false`. A selected parent action must not detach or rewrite a child checkout just because the user's Git configuration enables recursive checkout; child maintenance remains a separate reviewed action.

Fetch and push take an explicit remote from this checkout's `git remote` (a URL is not accepted) and an optional/explicit branch. They run `git fetch --progress --prune --no-recurse-submodules <remote> [<branch>]` and `git push --progress --no-recurse-submodules [--set-upstream] <remote> <ref>:<ref>` through the existing host Git runner, so SSH policy and credential helpers are the host's; prompts are disabled and no credentials are printed. `push` requires the reviewed branch object id (`expectedRefOid`) and never passes a force option; a branch that moved after review is refused. Progress is carried as parsed percentage phases over the streaming `git.mutationProgress` subscription, never as raw stderr. Push failures distinguish a rejection/non-fast-forward, an authentication failure, a known connection failure and an unknown network outcome. An unknown result is not retried automatically: the UI refreshes the real refs first.

The refs catalog gained upstream, ahead/behind and upstream-gone data computed from `%(upstream:track)` over the refs this checkout already has, plus the read time, the checkout's `FETCH_HEAD` modification time and remote names. It never fetches to answer ahead/behind; the UI labels the data as remote-tracking state and states that no fetch runs automatically.

Merge and rebase are explicit and require a clean index/worktree and no unfinished operation. A conflict or stopped rebase returns an unfinished result with fresh state, not success. `RepositoryState.operationInProgress` comes from the real `MERGE_HEAD`/rebase/`CHERRY_PICK_HEAD` markers, so the popup and Changes can show Continue and Abort for the detected operation. Continue uses `-c core.editor=true merge|rebase|cherry-pick --continue`; Abort only runs the matching operation's `--abort`. Both re-read the markers before reporting completion. The Stage 8 host resolver below supplies explicit conflict resolution.

Known limits: stage 6 was exercised on local macOS Electron with real local bare remotes; SSH/WSL/Windows execution hosts and release packaging were not run. Tags can be checked out but not created; only local branches can be pushed; fetch/push intentionally do not recurse into submodules; cherry-pick and a full resolver are not part of this stage.

## Submodule Maintenance and Batches (Stage 7)

The Submodules view contains maintenance controls for each discovered entry and an **Add submodule** form for the selected initialized parent. Every lifecycle action has an offline host-issued preview followed by an explicit apply, through the existing `git.mutate` / `git:mutate` transport. Requests use the parent context ID and a path relative to that parent checkout; the host, not the renderer, derives the child identity.

**Initialize** shows the declared/effective URL and path, the index target, detached consequence and an explicit recursive checkbox. Unknown descendants become visible after their parent is loaded. Recursive initialization discovers, authorizes and validates one level at a time, with the existing 128-context bound; it never delegates unchecked descendants to `git submodule update --recursive`. Known uninitialized gaps do not prevent initialization, but unavailable/blocked contexts, malformed metadata, discovery limits and incomplete repository reads still stop it.

**Checkout** distinguishes the parent's reviewed index OID from a selected, locally available remote-tracking ref. The full target OID and detached warning are reviewed before applying. Missing objects are not fetched lazily; dirty/conflicted children and stale metadata are refused. To develop or publish from a detached child, use its existing popup **New Branch** action first; batch publication requires the checked-out local branch.

**URL sync** defaults to copying the current raw `.gitmodules` declaration to local configuration without network access. The UI does not send a redacted display URL back as authority. An optional edited replacement is explicit and changes the worktree declaration too. The review shows old/new declared and effective URLs; relative URLs resolve against the parent's configured branch remote, then origin, then its first configured remote. Parent configuration and an initialized child's default remote are updated as separate queued steps. If a dependency changes between them, the partial result is reported rather than rolled back or called atomic.

**Add** previews the `.gitmodules`, gitlink and local-config effects and clones only after confirmation. It refuses an existing destination, symlink traversal or unrelated `.gitmodules` changes instead of staging those changes implicitly. **Remove** accepts only a reviewed stage-0 gitlink: a NUL-delimited `update-index --index-info` removal stages that gitlink deletion, and the selected declaration is removed from the worktree `.gitmodules`. Stage `.gitmodules` explicitly before committing the parent. The checkout, unpublished commits, local submodule config and `.git/modules` are retained; there is no force deletion or cleanup. The retained directory may become untracked, and HEAD metadata can keep the historical entry visible until the parent change is committed.

**Selected-context batch** reviews explicit context selection, recursion, staged-path selections, commit messages and optional configured publication destinations. Commits run leaf-to-root without auto-staging files. After each child commit, the batch pauses for a separate confirmation of its exact OID before staging the parent's gitlink; unrelated staged paths and externally moved dependencies are rejected.

Publication is child-first. Before pushing a parent, the host checks the exact gitlink and `.gitmodules` URL in its committed tree against the selected child destination, resolving relative URLs against the parent's actual publication destination. It explicitly fetches the named child branch from that destination and proves the child OID is an ancestor of the fetched tip. An unavailable remote, missing/shallow ancestry proof, mismatched URL, or separate/multiple child fetch/push endpoints blocks parent publication. The proof is point-in-time, not an atomic transaction across remotes.

The batch API remains `git.mutate`: `previewBatch` carries `batch`, while `runBatch` carries `batchRun.previewId` and at most one exact gitlink confirmation. `batchRun.inspectOnly: true` only reads the bounded cached run state and cannot begin, resume or retry a step. The UI inspects that state once per second while its own request is in flight, with no Git process for a progress read. Results retain every completed/failed/unknown step. Only `retryFailed: true` explicitly retries the known-failed next step after revalidation; completed and unknown operations never replay automatically. Preview state is bounded to 64 batch plans for 15 minutes and is not persisted across host restarts; an expired/unknown token requires a fresh review.

Each mutation acquires only its affected repository queue, releases it before the next repository step, and rechecks authorization and dependency fences. Parent metadata uses content/index fences in addition to discovered state. Neither batches nor recursive initialization treat a repository tree as one transaction.

## Conflict Resolver and Host Documents (Stage 8)

Open an unresolved row from root or child **Changes**, or select a file in the existing conflict review. The editor shows read-only Base/Ours/Theirs and an editable Result, with Previous/Next conflict and Use ours/theirs/both for the selected marker block. Block choices preserve surrounding text, diff3 boundaries and CRLF; they do not write or resolve the index. **Save result** writes only the worktree, then **Mark Resolved** is a separate action. Generic filesystem Save and autosave are blocked for resolver-backed tabs.

Drafts are isolated by execution owner, worktree and absolute path and retained during context navigation. A rejected stale write keeps the draft and blocks subsequent writes. **Reload conflict** explicitly reads current stages/result and keeps the previous unsaved version visible for recovery; restoring it into Result still requires Save and Mark Resolved. Binary, absent, symlink and rename entries expose explicit whole-side/deletion actions instead of a fake text editor.

Inactive clean conflict documents without recovery versions are released. Unsaved drafts and recovery versions survive navigation; reopening a resolved path reads new stages rather than reusing the previous conflict's OIDs.

The existing `git.mutate` / `git:mutate` route serves root and authorized child contexts. `readConflict` requires `contextId` and the checkout-relative `filePath`; `receipt.conflict` contains a host-issued `documentId`, context/path, detected operation, conflict kind, related rename paths, base/ours/theirs index-stage OIDs and modes, the current result and side labels. Content is explicitly text, binary, absent, gitlink, symlink or oversized; no binary blob is decoded lossily. Reads are offline and bounded to 8 MiB per displayed content side. Rename detection uses bounded local metadata and a 200-candidate rename limit; associated paths are informational and each unresolved index path requires its own explicit resolution.

`saveConflict` takes `documentId` and UTF-8 `content`. It writes only an editable regular-file result, does not stage it, and returns a refreshed `receipt.conflict` with a new token. `resolveConflict` takes `documentId` and an explicit `resolution`: `result` records the saved regular file using its path's `.gitattributes` clean/EOL normalization, `ours`/`theirs` use exact stage blob bytes and modes (an absent side means deletion), and `delete` removes the selected worktree file and index entry. Only a verified stage-0 index entry or index removal proves resolution; deleting conflict markers alone does not.

For gitlinks, both side OIDs are displayed. `resolution: 'gitlink'` also takes `childOid`: either an exact reviewed side or a commit verified locally in the freshly authorized child context. The parent writes mode `160000` and that OID without checking out or resetting the child, modifying its index, staging dirty child files or creating a child commit. Create a new child result through the existing child commit workflow, then review and record its resulting commit. Deleting a parent gitlink retains the child directory.

Tokens are host-private, expire after 15 minutes, and are bounded to 32 documents and 64 MiB of retained content. Every write re-authorizes the checkout, verifies its identity, and fences HEAD, operation markers, the selected path's index stages/OIDs/modes and exact worktree bytes/mode/absence. Stale documents refuse external edits rather than overwriting them. Oversized worktree files cannot be overwritten using a metadata-only fingerprint. Paths cannot traverse symlinked parents or use alternate Windows traversal spellings; replacing a symlink never follows its target. Writes use the existing common-Git-directory queue and cache invalidation. There is no hidden fetch/stash, forced checkout, recursive deletion or automatic retry; explicit index deletion can use `update-index --force-remove` without deleting retained child directories. These checks are not a cross-process filesystem transaction.

Saving or copying a whole side into an existing regular result refuses multiple hard links before truncation, so it cannot overwrite an outside file through a shared inode. Replace the hard link and reload before saving.

During rebase, ours means upstream plus already replayed commits (index stage 2); theirs means the user's commit currently being replayed (stage 3). Merge/rebase/cherry-pick continuation and abort select the real marker-detected operation and preserve unfinished outcomes. Local verification includes real-Git host scenarios and four actual hidden Electron journeys: root merge, nested rebase, context-isolated stale drafts, and a child branch/selected commit created in the app and explicitly recorded into a conflicted parent while dirty child files survive. Remote/Windows runtime and release-package verification are not claimed; see STAGE8-REPORT.md for commands and limits.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

## Merging Pull Requests

Before merging, verify that the required checks and aggregate gate in the full PR workflow have pass.

## Retrying GitHub Actions

Inspect a failed run with `gh run view <run-id> --log-failed --repo stablyai/orca`, then retry failed jobs with `gh run rerun <run-id> --failed --repo stablyai/orca`. GitHub also reruns jobs that depend on the failed jobs. In GitHub's UI, choose **Re-run failed jobs**; Orca offers **Rerun failed checks**.

Keep successful jobs unless there is a concrete reason to revalidate them, such as investigating runner-dependent flakiness. A full rerun restarts passing unit shards, packages, and platform checks too. If fixing the failure changes code, push the fix and validate the new commit; rerunning an older run still tests its original commit.

On a partial retry, the unit-selection plan or full set of shard artifacts may be absent for that attempt. Unit execution falls back to the full test inventory; incomplete selection evidence is advisory and cannot justify enabling selection. Inspect artifact requirements before retrying release or publishing jobs.

## Stage, Commit and Discard (Stage 4)

The workspace UI writes through one host entry point: `git.mutate` (runtime RPC) and `git:mutate` (desktop IPC), exposed as `window.api.git.mutate` and `mutateRuntimeGitWorkspace` in the renderer. Each request carries the host-issued context ID, the previewed `expectedState`, the file path and, for partial changes, the issued diff `documentId` plus hunk/line IDs. Paths, IDs and the context are re-validated on the execution host; the renderer never sends a patch.

Partial staging is built on the host from the confirmed diff. A replacement pair (old line plus its new line) and any block that touches a missing final newline move together, because staging one side alone would duplicate a line or produce an impossible newline boundary; pure addition and pure deletion blocks keep per-line granularity. Rename, binary, oversized, non-UTF-8, symlink, mode-only and unmerged changes do not offer partial staging and keep whole-file operations. Unstaging a rename acts on both paths.

Before a write the host re-reads the authorized discovery and the exact file. The content fence covers HEAD, the path's index records and the current worktree bytes (files above 16 MiB use their filesystem identity instead of a full hash). A mismatched preview state or fence stops the operation and the UI refreshes real state; a selection is never re-applied to a similar fragment of newer content. Writes run in one queue keyed by the common Git directory, so linked worktrees of the same repository serialize with each other. This detects conflicts with external writers through Git locks and these fences; it is not a transaction over the checkout.

Commit consumes only the real index: a host preview lists the staged files with unborn/detached/branch state and refuses when the staged listing is truncated. Orca passes no `--no-verify` and disables no signing, so hooks and signing failures surface with their Git message and a refreshed state; a hook that stages files is visible in the committed set rather than hidden. Cancellation or a dropped connection is reported as an unknown outcome, and nothing is retried automatically.

Discard applies only to unstaged changes of tracked regular files. It requires a host preview token, writes a recovery copy (plus a manifest) under the checkout's `orca-recovery` Git metadata directory before overwriting, and refuses when that copy cannot be stored. The new discard path never removes untracked files, and `restoreDiscard` restores the copy only while the file still matches the post-discard state. Recovery entries are listed per context; this is a recovery copy for Orca's discard, not a general Git undo.

Staging a submodule gitlink is explicit: the parent records the reviewed child commit with `update-index --cacheinfo 160000`, after checking the child HEAD, the child context identity and the parent index record. It does not stage child files, move the child index or create a child commit, and committing the parent never commits the child. Exiting `git.stage`/`git.unstage`/`git.commit` and the bulk stage/discard routes remain compatible for CLI and older clients; they share the same queue and low-level primitives, while the workspace UI uses `git.mutate` for previews, freshness and receipt outcomes.

Known limits: only local macOS Electron was exercised for this stage; SSH/WSL/Windows hosts and release packaging were not run. The queue is per host process and common Git directory, not cross-host. Recovery copies are per checkout Git dir and are not garbage-collected automatically.
