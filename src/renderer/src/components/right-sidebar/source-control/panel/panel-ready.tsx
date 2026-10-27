import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SourceControlWorkspaceCatalog } from './workspace-catalog'
import { useWorkspaceCatalog } from './use-workspace-catalog'
import { SourceControlWorkspaceChanges } from './workspace-changes'
import { SourceControlWorkspaceLog } from './workspace-log'
import { SourceControlWorkspacePopup } from './workspace-popup'
import {
  consumeGitContextPopupRequest,
  GIT_CONTEXT_POPUP_EVENT
} from '@/lib/git-context-popup-command'
import { BulkActionBar } from '../commit/bulk-action-bar'
import { SourceControlHeaderToolbar } from './header-toolbar'
import { SourceControlNotesShelf } from '../notes/notes-shelf'
import { SourceControlPanelContent } from './panel-content'
import { SourceControlPanelDialogs } from './panel-dialogs'
import type { SourceControlPanelReadyProps } from './panel-props'

/** The panel chrome: toolbar, notes shelf, the scrolling file surface, bulk bar and dialog layer. */
export function SourceControlPanelReady(props: SourceControlPanelReadyProps) {
  const { model, worktreePath } = props
  const [view, setView] = useState<'changes' | 'log' | 'submodules'>('changes')
  const [logRevision, setLogRevision] = useState<string | null>(null)
  const [popupOpen, setPopupOpen] = useState(false)
  const catalog = useWorkspaceCatalog(
    model.activeRepoTarget
      ? {
          target: model.activeRepoTarget,
          worktreeId: model.activeWorktreeId,
          worktreePath,
          connectionId: model.activeConnectionId ?? undefined
        }
      : null,
    props.activeRepo.id
  )
  const selectedRepository = catalog.snapshot?.repositories.find(
    (repository) => repository.context.id === catalog.selected
  )
  const selectedModule = catalog.snapshot?.submodules.find(
    (entry) => entry.contextId === catalog.selected
  )
  useEffect(() => {
    const open = () => {
      consumeGitContextPopupRequest()
      setPopupOpen(true)
    }
    window.addEventListener(GIT_CONTEXT_POPUP_EVENT, open)
    if (consumeGitContextPopupRequest()) {
      setPopupOpen(true)
    }
    return () => window.removeEventListener(GIT_CONTEXT_POPUP_EVENT, open)
  }, [])
  useEffect(() => {
    const selectContext = (event: Event, nextView: 'changes' | 'log') => {
      if (
        !(event instanceof CustomEvent) ||
        event.detail?.worktreeId !== model.activeWorktreeId
      ) {
        return
      }
      // Why: a gitlink opened from a child diff reports that child checkout as the
      // root; the context id is already verified against this worktree's authorized
      // snapshot, so it decides whether the event may select anything.
      if (
        catalog.snapshot?.repositories.some((item) => item.context.id === event.detail.contextId)
      ) {
        catalog.setSelected(event.detail.contextId)
        setLogRevision(nextView === 'log' ? (event.detail.revision ?? null) : null)
        setView(nextView)
      }
    }
    const openChild = (event: Event) => selectContext(event, 'changes')
    const openChildLog = (event: Event) => selectContext(event, 'log')
    window.addEventListener('orca:git-context-changes', openChild)
    window.addEventListener('orca:git-context-log', openChildLog)
    return () => {
      window.removeEventListener('orca:git-context-changes', openChild)
      window.removeEventListener('orca:git-context-log', openChildLog)
    }
  }, [catalog, model.activeWorktreeId, worktreePath])

  // Why: the Log offers refs as browsable revisions, so ask the catalog for this
  // context's ref list while the view is open instead of on every snapshot read.
  const { requestRefs, selected: selectedContextId } = catalog
  useEffect(() => {
    if (view === 'log' && selectedContextId) {
      requestRefs(selectedContextId)
    }
  }, [requestRefs, selectedContextId, view])
  const {
    activeGroupId,
    activeWorktreeId,
    branchLineTotal,
    branchSummary,
    bulkStagePaths,
    bulkUnstagePaths,
    clearSelection,
    compareBaseRef,
    deleteDiffComment,
    diffCommentCount,
    diffCommentsCopied,
    diffCommentsExpanded,
    diffCommentsForActive,
    filterExpanded,
    filterQuery,
    gitIdentityDisplay,
    handleBulkStage,
    handleBulkUnstage,
    handleCopyDiffComments,
    handleCreatePrHeaderClick,
    handleOpenComment,
    handleRelinkSuppressedGitHubPR,
    handleSourceControlKeyDown,
    handleToggleSourceControlViewMode,
    hostedReview,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isExecutingBulk,
    manualReviewUrl,
    openHostedReviewInChecks,
    prGenerating,
    refreshBranchCompare,
    selectedKeys,
    setBaseRefDialogOpen,
    setDiffCommentsExpanded,
    setFileListScrollElement,
    setFilterExpanded,
    setFilterQuery,
    setPendingDiffCommentsClear,
    setSourceControlRoot,
    settings,
    sourceControlViewMode,
    suppressedGitHubPRState,
    visibleCreatePrHeaderAction
  } = model

  return (
    <>
      <div
        ref={setSourceControlRoot}
        className="relative flex h-full flex-col overflow-hidden"
        onKeyDown={view === 'changes' ? handleSourceControlKeyDown : undefined}
      >
        <div className="flex gap-1 border-b border-border p-1" aria-label="Source Control views">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={view === 'changes'}
            onClick={() => setView('changes')}
          >
            Changes
          </Button>
          <Button variant="ghost" size="xs" aria-pressed={view === 'log'} onClick={() => setView('log')}>
            Log
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={view === 'submodules'}
            onClick={() => setView('submodules')}
          >
            Submodules
          </Button>
        </div>
        {view === 'changes' && (
          <SourceControlHeaderToolbar
            filterQuery={filterQuery}
            filterExpanded={filterExpanded}
            onFilterQueryChange={setFilterQuery}
            onFilterExpandedChange={setFilterExpanded}
            visibleCreatePrHeaderAction={visibleCreatePrHeaderAction}
            hostedReview={hostedReview}
            isCreatePrIntentInFlight={isCreatePrIntentInFlight}
            isCreatingPr={isCreatingPr || prGenerating}
            onCreatePrHeaderClick={handleCreatePrHeaderClick}
            onOpenHostedReviewInChecks={openHostedReviewInChecks}
            suppressedGitHubPRNumber={
              suppressedGitHubPRState?.status === 'matched' ? suppressedGitHubPRState.number : null
            }
            onRelinkSuppressedGitHubPR={handleRelinkSuppressedGitHubPR}
            sourceControlViewMode={sourceControlViewMode}
            viewModeToggleDisabled={settings === null}
            onToggleViewMode={handleToggleSourceControlViewMode}
            onChangeBaseRef={() => setBaseRefDialogOpen(true)}
            onRefreshBranchCompare={() => void refreshBranchCompare()}
            branchCompareRefreshDisabled={!branchSummary || branchSummary.status === 'loading'}
            diffCommentCount={diffCommentCount}
            onExpandNotes={() => setDiffCommentsExpanded(true)}
            branchSummary={branchSummary}
            branchLineTotal={branchLineTotal}
            compareBaseRef={compareBaseRef}
            headDisplay={gitIdentityDisplay}
            manualReviewUrl={manualReviewUrl}
          />
        )}

        {/* Why: hidden when count is 0 — notes are created from the diff view, so an empty Notes shelf here is pure chrome. */}
        {view === 'changes' && activeWorktreeId && worktreePath && diffCommentCount > 0 && (
          <SourceControlNotesShelf
            activeWorktreeId={activeWorktreeId}
            activeGroupId={activeGroupId}
            diffCommentsForActive={diffCommentsForActive}
            diffCommentCount={diffCommentCount}
            diffCommentsExpanded={diffCommentsExpanded}
            setDiffCommentsExpanded={setDiffCommentsExpanded}
            diffCommentsCopied={diffCommentsCopied}
            handleCopyDiffComments={handleCopyDiffComments}
            setPendingDiffCommentsClear={setPendingDiffCommentsClear}
            deleteDiffComment={deleteDiffComment}
            handleOpenComment={handleOpenComment}
          />
        )}

        <div
          data-git-changes-scroll
          ref={setFileListScrollElement}
          className="relative flex flex-1 flex-col overflow-auto scrollbar-sleek pt-1"
          style={{ paddingBottom: selectedKeys.size > 0 ? 50 : undefined }}
        >
          {view === 'submodules' && model.activeRepoTarget ? (
            <SourceControlWorkspaceCatalog
              model={catalog}
              onOpenLog={() => {
                setLogRevision(null)
                setView('log')
              }}
            />
          ) : view === 'submodules' ? (
            <p role="alert" className="p-3 text-xs text-destructive">
              Git execution host is unavailable.
            </p>
          ) : view === 'log' ? (
            selectedRepository && catalog.context && catalog.snapshot ? (
              <SourceControlWorkspaceLog
                key={`log:${selectedRepository.context.id}`}
                repository={selectedRepository}
                context={catalog.context}
                label={selectedModule?.path ?? 'Root'}
                isRoot={selectedRepository.context.id === catalog.snapshot.rootContextId}
                revision={logRevision}
              />
            ) : (
              <p role="status" className="p-3 text-xs">
                {catalog.error ?? 'Loading Git contexts…'}
              </p>
            )
          ) : (
            <SourceControlPanelContent
              {...props}
              rootSelected={catalog.selected === catalog.snapshot?.rootContextId}
              changes={
                selectedRepository && catalog.context && catalog.snapshot ? (
                  <SourceControlWorkspaceChanges
                    key={selectedRepository.context.id}
                    repository={selectedRepository}
                    context={catalog.context}
                    label={selectedModule?.path ?? 'Root'}
                    refreshGeneration={catalog.snapshot}
                    submodules={catalog.snapshot.submodules}
                    showCommit={selectedRepository.context.id !== catalog.snapshot.rootContextId}
                    onRefresh={catalog.refresh}
                    onOpenLog={() => {
                      setLogRevision(null)
                      setView('log')
                    }}
                  />
                ) : (
                  <p role="status" className="p-3 text-xs">
                    {catalog.error ?? 'Loading Git contexts…'}
                  </p>
                )
              }
            />
          )}
        </div>

        {view === 'changes' &&
          catalog.selected === catalog.snapshot?.rootContextId &&
          selectedKeys.size > 0 && (
            <BulkActionBar
              selectedCount={selectedKeys.size}
              stageableCount={bulkStagePaths.length}
              unstageableCount={bulkUnstagePaths.length}
              onStage={handleBulkStage}
              onUnstage={handleBulkUnstage}
              onClear={clearSelection}
              isExecuting={isExecutingBulk}
            />
          )}
      </div>

      <SourceControlWorkspacePopup
        model={catalog}
        open={popupOpen}
        onOpenChange={setPopupOpen}
        onChanges={() => {
          setLogRevision(null)
          setView('changes')
        }}
        onLog={() => {
          setLogRevision(null)
          setView('log')
        }}
      />
      <SourceControlPanelDialogs {...props} />
    </>
  )
}
