import { GitHistoryPanel } from '../sync/git-history-panel'
import { shouldShowSourceControlCompareUnavailableCard } from './header-toolbar'
import { shouldRenderCommitArea } from '../commit/component-gates'
import { SourceControlBranchSection } from '../listing/branch-section'
import { SourceControlContentStatus } from '../listing/content-status'
import { CompareUnavailable } from '../sync/compare-summary'
import { SourceControlCommitSurface } from './commit-surface'
import { SourceControlForkPushNotice } from './fork-push-notice'
import type { SourceControlPanelReadyProps } from './panel-props'

/** The scrolling surface: status, commit affordances, the file sections and the history dock. */
export function SourceControlPanelContent(
  props: SourceControlPanelReadyProps & { changes: React.ReactNode; rootSelected: boolean }
) {
  const { activeWorktree, currentWorktreeId, model, worktreePath } = props
  const {
    activeConnectionId,
    branchEntries,
    branchSummary,
    collapsedSections,
    collapsedTreeDirs,
    conflictOperation,
    diffCommentCountByPath,
    displaySections,
    fileFilterState,
    fileListScrollElement,
    filterQuery,
    filteredBranchEntries,
    gitHistoryState,
    handleCommitAction,
    handleAbortOperationForConflict,
    handleResolveConflictsWithAI,
    handleStageWorktreeChanges,
    hasUncommittedEntries,
    isAbortingOperation,
    isCheckingRecoveryAdmission,
    isExecutingBulk,
    isGitHistoryVisible,
    loadCommitFiles,
    normalizedFilter,
    openBranchAllDiffs,
    openCommitFile,
    openCommittedDiff,
    openConflictReview,
    openHistoryCommitDiff,
    refreshActiveGitStatus,
    refreshBranchCompare,
    refreshGitHistory,
    repositoryHuge,
    revealInExplorer,
    setBaseRefDialogOpen,
    sourceControlAiActionsVisible,
    sourceControlViewMode,
    toggleSection,
    toggleTreeDir,
    unresolvedConflicts,
    unresolvedConflictReviewEntries,
    visibleBranchTreeRows
  } = model

  const hasFilteredUncommittedEntries = displaySections.length > 0
  const hasFilteredBranchEntries = filteredBranchEntries.length > 0
  const showGenericEmptyState =
    !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0

  return (
    <>
      {!props.rootSelected ? (
        <p className="p-3 text-xs text-muted-foreground">
          Child checkout changes · parent commit and branch actions are unavailable in this context.
        </p>
      ) : (
        <>
          <SourceControlContentStatus
            unresolvedConflictCount={unresolvedConflictReviewEntries.length}
            conflictOperation={conflictOperation}
            sourceControlAiActionsVisible={sourceControlAiActionsVisible}
            isRecoveryBusy={isCheckingRecoveryAdmission}
            isAbortingOperation={isAbortingOperation}
            onAbortOperation={handleAbortOperationForConflict}
            onResolveWithAi={() => void handleResolveConflictsWithAI()}
            onReviewConflicts={() => {
              openConflictReview(
                currentWorktreeId,
                worktreePath,
                unresolvedConflictReviewEntries,
                'live-summary'
              )
            }}
            repositoryHuge={repositoryHuge}
            worktreeId={currentWorktreeId}
            onRetryStatus={refreshActiveGitStatus}
            onStageAllChanges={handleStageWorktreeChanges}
            isExecutingBulk={isExecutingBulk}
            showGenericEmptyState={showGenericEmptyState}
            normalizedFilter={normalizedFilter}
            branchBaseRef={branchSummary?.baseRef ?? null}
            filterTooLarge={fileFilterState.tooLarge}
            hasFilteredUncommittedEntries={hasFilteredUncommittedEntries}
            hasFilteredBranchEntries={hasFilteredBranchEntries}
            filterQuery={filterQuery}
          />

          {/* Why: keep CommitArea mounted across normal states — gating on hasUncommittedEntries (#1448) would unmount the action surface on clean worktrees and mid-commit as the staged list clears. Active merge/rebase/cherry-pick is the exception. */}
          <SourceControlForkPushNotice pushTarget={activeWorktree.pushTarget ?? null} />

          {shouldRenderCommitArea(unresolvedConflicts.length, conflictOperation) && (
            <SourceControlCommitSurface {...props} showGenericEmptyState={showGenericEmptyState} />
          )}

          {props.changes}

          {shouldShowSourceControlCompareUnavailableCard(
            branchSummary,
            hasUncommittedEntries,
            branchEntries.length > 0,
            Boolean(normalizedFilter)
          ) && branchSummary ? (
            <CompareUnavailable
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          ) : null}

          {branchSummary?.status === 'ready' && hasFilteredBranchEntries && (
            <SourceControlBranchSection
              branchSummary={branchSummary}
              filteredBranchEntries={filteredBranchEntries}
              totalBranchEntryCount={branchEntries.length}
              collapsedSections={collapsedSections}
              toggleSection={toggleSection}
              sourceControlViewMode={sourceControlViewMode}
              visibleBranchTreeRows={visibleBranchTreeRows}
              fileListScrollElement={fileListScrollElement}
              collapsedTreeDirs={collapsedTreeDirs}
              toggleTreeDir={toggleTreeDir}
              currentWorktreeId={currentWorktreeId}
              worktreePath={worktreePath}
              revealInExplorer={revealInExplorer}
              activeConnectionId={activeConnectionId}
              openCommittedDiff={openCommittedDiff}
              openBranchAllDiffs={openBranchAllDiffs}
              diffCommentCountByPath={diffCommentCountByPath}
            />
          )}

          {isGitHistoryVisible && (
            // Why: the graph is reference context, so keep it docked at the bottom as the pane scrolls.
            <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-border bg-sidebar/95 backdrop-blur-sm">
              <GitHistoryPanel
                state={gitHistoryState}
                collapsed={collapsedSections.has('history')}
                onToggle={() => toggleSection('history')}
                onRefresh={() => void refreshGitHistory()}
                onOpenCommit={(item) => void openHistoryCommitDiff(item)}
                onLoadCommitFiles={loadCommitFiles}
                onOpenCommitFile={openCommitFile}
                onCommitAction={handleCommitAction}
              />
            </div>
          )}
        </>
      )}
      {!props.rootSelected && props.changes}
    </>
  )
}
