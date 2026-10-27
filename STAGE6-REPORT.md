# Этап 6 — Ветки, remotes и завершение меню переключателя

## Результат

В `orca/` продолжены сохранённые незакоммиченные изменения этапов 1–5. Полностью реализован только этап 6: popup контекстов получил реальные New Branch, checkout локальной/remote-ветки, тега и полного OID, явные fetch/push с прогрессом, upstream/ahead/behind с актуальностью загруженных refs, а также explicit merge/rebase с честным незавершённым состоянием и Git continue/abort. Все записи идут через существующий host mutation service `mutateGitWorkspace`, транспорт `git.mutate`/`git:mutate`, context authorization и очередь по common git-dir; второго backend, обхода fences и path-as-authority не добавлено. Полноценный resolver конфликтов не реализовывался (этап 8), этап 7 не начинался. Production bundle, глобальный CLI и пользовательский профиль не менялись.

## Контракт

- **Один вход.** `GitMutationAction` расширен `checkout`, `createBranch`, `fetch`, `push`, `merge`, `rebase`, `continueOperation`, `abortOperation`. Они используют те же `git.mutate`/`git:mutate`, preload, web client, `readAuthorizedWorkspace`/`verifyWorkspaceContext` и `withGitMutationQueue` по common git-dir, что stage 4. Второго Git-клиента нет.
- **Fences.** Checkout/New Branch/merge/rebase/continue/abort требуют `expectedHead` (полный OID; `''` для unborn) и сверяют его после повторного discovery; неполный status discovery отклоняется. Push требует `expectedRefOid` и сверяет OID выбранной ветки. Fetch не пишет worktree/index и не требует state fence. `expectedState` остаётся контрактом stage 4 для stage/commit/discard; branch-действия его не используют, чтобы быстрые последовательные действия не упирались в устаревший hash.
- **Checkout.** Local branch по короткому имени (полный `refs/heads/...` отсоединил бы HEAD), remote branch создаёт локальную ветку с `--track`, tag/полный OID — detached. Отказ: текущая ветка, незавершённая операция/конфликт, ветка в другом живом worktree (`worktree list --porcelain -z`, реальный путь в сообщении), пересечение dirty entries с путями `diff --name-only HEAD <target>`; несвязанные локальные изменения не блокируются. Stash/`reset --hard`/`clean`/force отсутствуют.
- **New Branch.** Имя проверяется `check-ref-format`; ветка создаётся и явно переключается. Старт с remote ref ставит tracking, старт с локального ref/тега/OID — нет. Существующая ветка отклоняется.
- **Refs и актуальность.** `GitWorkspaceRef` содержит upstream/OID/ahead/behind/upstreamGone из локального `%(upstream:track)`; `RepositoryState` получил `refsReadAt`, `lastFetchAt` (mtime этого checkout's `FETCH_HEAD`) и имена remotes без URL. Ahead/behind никогда не ходят в сеть; UI пишет, что это remote-tracking данные и fetch автоматически не выполняется.
- **Fetch/push.** Remote обязан быть в свежем `git remote`; URL не принимается. Аргументы: `fetch --progress --prune --no-recurse-submodules <remote> [<branch>]`, `push --progress --no-recurse-submodules [--set-upstream] <remote> <ref>:<ref>`. Сеть идёт через существующий execution-host Git runner с его SSH policy/credential helpers и `GIT_TERMINAL_PROMPT=0`; timeout 300 s. Прогресс — только разобранные `phase/percent`, без stderr/URL/секретов. Различаются `rejected` (non-fast-forward/remote has newer), `authentication`, известный `network` и `unknown-outcome` (timeout/abort/kill). Unknown не повторяется автоматически, UI перечитывает состояние. Force-push не предусмотрен.
- **Прогресс.** Streaming RPC `git.mutationProgress` по клиентскому `progressId`: host публикует bounded кадры из `createGitProgressRecordReader`, подписка завершается по `done`/unsubscribe. При недоступности подписки сама операция продолжает работать; прогресс не является источником истины.
- **Merge/rebase.** Требуют чистый index/worktree и отсутствие незавершённой операции. `merge --no-edit <ref>` и `rebase <ref>` вызываются явно по локально разрешённому коммиту. Конфликт/остановка возвращает `conflict` и свежее состояние, но не success. `RepositoryState.operationInProgress` вычисляется по `MERGE_HEAD`/`rebase-merge`/`rebase-apply`/`CHERRY_PICK_HEAD`; Continue (`-c core.editor=true … --continue`) и Abort выбираются по фактическому маркеру, после чего маркеры перечитываются. Cherry-pick и resolver — вне этапа.
- **UI.** Popup: New Branch, Checkout, Merge into current, Rebase current onto this, New branch from here, Fetch, Fetch this branch, Push с select remote/push branch, явный Publish (set upstream), detached checkout по полному OID, upstream/ahead/behind, время чтения refs/последнего fetch, progress, unfinished-operation с Continue/Abort и notice. Все действия — native buttons/selects с `data-navigation-item`; ArrowDown из поиска идёт к первой ref, ArrowUp/Tab достигают действий, Enter выполняет. Selects сохраняют native arrow-keys. Изменения показывают unfinished operation и число конфликтов; черновики остаются по context ID.
- **Совместимость.** Существующие `git.status`/`git.diff`/`git.history`/stage-4 мутации продолжают работать; новые поля status (`refsReadAt`, `lastFetchAt`, `remotes`, расширенные refs) и `operationInProgress` дополнительны, а `GitMutate` новые поля опциональны. Web preload прокидывает новый request без второго транспорта и использует тот же длинный timeout для сетевых действий.

## Затронутые файлы (основное)

Новые: `src/main/git/source-control/git-workspace-{branch-refs,branch-guards,branch-actions,integrate,sync,progress}.ts`, `src/main/runtime/rpc/methods/git-progress-methods.ts`, renderer `panel/{workspace-popup-branch-actions.tsx,workspace-popup-sync-actions.tsx,use-workspace-branch-actions.ts}`, `src/renderer/src/runtime/runtime-git-progress-client.ts`, тесты `git-workspace-branch-real-git.test.ts`, `git-workspace-branch-units.test.ts`, `tests/e2e/git-workspace-branches.spec.ts`.

Изменено: `src/shared/{git-workspace-types.ts,git-workspace-mutation.ts,git-status-types.ts}`, `src/shared/rpc-contract/git-params.ts`, `src/shared/rpc-contract/rpc-params-catalog.generated.ts`, `src/main/git/source-control/{git-workspace-refs.ts,git-workspace-mutation.ts,git-workspace-mutation-error.ts,git-conflict-operation.ts,status-read.ts,git-workspace-status.ts}`, `src/main/runtime/rpc/methods/git.ts`, preload `git-operation-api.ts`, renderer `runtime-git-working-tree-client.ts`, `web-git-api.ts`, `panel/{workspace-popup.tsx,workspace-popup-refs.tsx,workspace-changes.tsx}`. Документация: `CHANGELOG.md`, `docs/reference/git-workflow.md`, `PLAN.md`, `ARCHITECTURE.md`.

## Выполненные проверки

Среда: Darwin arm64, checkout `/Users/chernikovmax/orca/projects/light/orca`, Node 24.22.1 через process-local `npm exec`, Electron 43.8.1. Глобальный CLI не устанавливался; production bundle и пользовательский профиль не изменялись.

| Проверка | Результат |
|---|---|
| Новый real-Git suite веток/remotes/merge/rebase (`git-workspace-branch-real-git.test.ts`) | **13 passed** |
| Pure unit suite refs/fences/progress (`git-workspace-branch-units.test.ts`) | **7 passed** |
| Broad regression source-control + transport + renderer | **398 passed / 401** (39 files); 2 ambient `SSH_ASKPASS=/usr/bin/false` failures pass with `env -u SSH_ASKPASS`; 1 pre-existing stage-3 corrupt-index test failure, its files untouched by stage 6 |
| Web TypeScript (`config/tsconfig.web.json --noEmit --composite false`) | exit 0 |
| Node TypeScript (`config/tsconfig.node.json --noEmit --composite false`) | exit 0 |
| RPC catalog `generate-rpc-params-catalog.mjs --check` | exit 0 |
| Targeted oxlint по stage-6 файлам | exit 0 |
| Electron-vite build `--mode e2e`, `VITE_EXPOSE_STORE=true` | exit 0; **176 chunks, 6061.7 KB** |
| Настоящий Electron: новый stage-6 spec | **3 passed** (индивидуальные прогоны и финальный полный прогон) |
| Настоящий Electron: полный набор stage-6 + popup/catalog/diff/mutation/log/golden | **9 passed / 3.5 m**, hidden window (24.8 ms shell, 748.3 ms root refs) |

Точные команды:

```sh
npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run \
  --config config/vitest.config.ts \
  src/main/git/source-control/git-workspace-branch-real-git.test.ts \
  src/main/git/source-control/git-workspace-branch-units.test.ts
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.web.json --noEmit --composite false
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.node.json --noEmit --composite false
node config/scripts/generate-rpc-params-catalog.mjs --check
node_modules/.bin/oxlint <stage-6 files>
npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run \
  --config config/vitest.config.ts \
  src/main/git/source-control/*.test.ts src/shared/git-history*.test.ts \
  src/shared/git-progress-records.test.ts src/main/git/status-diff.test.ts \
  src/main/git/status-diff-settled-cache.test.ts src/main/git/status-submodule.test.ts \
  src/main/git/git-network-safety-real-git.test.ts src/main/git/worktree-list-porcelain.test.ts \
  src/main/runtime/rpc/methods/git.test.ts src/main/runtime/runtime-git-sync-commands.test.ts \
  src/main/runtime/orca-runtime-git.test.ts src/main/providers/local-git-provider.test.ts \
  src/main/ipc/filesystem-git-status-staging.test.ts src/renderer/src/runtime/runtime-git-client.test.ts \
  src/renderer/src/components/right-sidebar/source-control/panel/*.test.* \
  src/renderer/src/components/right-sidebar/GitHistoryPanel.test.tsx
env VITE_EXPOSE_STORE=true ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node config/scripts/run-electron-vite-build.mjs --mode e2e
env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test \
  --config .cache/stage6-playwright.config.ts --project electron-headless
```

Временный `.cache/stage6-playwright.config.ts` выбирал семь постоянных spec и отключал stock global setup/teardown (они могли готовить глобальный CLI); после финального прогона он удалён. `helpers/orca-app.ts` создавал disposable HOME/userData и завершал только собственные Electron-процессы; `killall`/`pkill` не применялись. Снимки делались во время прогона (`.cache/stage6-popup-*.png`) и удалены после проверки.

## Покрытые сценарии приёмки

Real Git (временный fixture с root, `one`, `one/same`, `two`, linked worktree `second`, настоящий локальный bare remote, HTTP 401/hanging серверы):

- Checkout `refs/heads/feature-one` в `one`: меняется только HEAD выбранного checkout; HEAD/refs/index root, `two` и `nested` совпадают до/после. Возврат на `main` восстанавливает OID.
- Remote branch checkout создаёт локальную ветку с upstream `refs/remotes/stage6/...`; tag и полный OID дают detached HEAD; полноценный OID проверяется и при checkout.
- New Branch с remote start point создаёт локальную ветку с tracking; существующее имя отклоняется.
- Ветка, занятая linked worktree `second`, отклоняется с категорией `busy` и реальным путём; HEAD не меняется.
- Dirty-блокировка: изменение `file.txt`, которое затрагивает целевая ветка, отклоняется (`dirty`); несвязанный untracked-файл не мешает checkout и сохраняется.
- Push: явный remote/ref, `--set-upstream` только по запросу; bare ref обновляется. Изменение локальной ветки после review даёт `stale` по `expectedRefOid`. Non-fast-forward отклоняется категорией `rejected`, remote и локальная ветка не меняются.
- HTTP 401 даёт `authentication` и для push, и для fetch; сообщение не содержит URL. Push к зависшему HTTP-серверу, прерванный после того, как запрос уже ушёл, даёт `unknown-outcome` и отсутствие auto-retry; после сверки реального состояния явный повтор на другой remote успешен.
- Fetch: обновляет remote-tracking ref и `lastFetchAt`; ahead/behind (0/0 → 1/0 → 0/1) считаются по загруженным refs, до fetch остаются старыми. Fetch одной ветки не создаёт другие remote refs. `stage6/main` checkout принимает explicit branch.
- Merge fast-forward и merge conflict: конфликт возвращает `conflict`, `operationInProgress: true`, HEAD не двигается; Continue без разрешения снова `conflict`; после внешнего разрешения и `git add` Continue создаёт merge commit; Abort возвращает pre-merge HEAD и чистое состояние. Merge/rebase с dirty-деревом отклоняются, второй checkout во время незавершённой операции — `operation-in-progress`.
- Rebase: успешный rebase линеаризует историю; конфликтный rebase даёт `rebase` и `operationInProgress`, Abort возвращает HEAD; Continue после разрешения завершает rebase. Маркеры после завершения отсутствуют.

Electron (root + сабмодули, настоящий Git и Monaco, реальные bare remotes, скрытое окно):

1. Popup → `one/same` → Open Changes → черновик; возврат к `one`, dirty-блокировка, затем checkout `selected-branch` по клавиатуре (focus + Enter). Root HEAD/refs/index и sibling checkouts не изменились; черновик `one/same` сохранился.
2. New Branch `from-popup` через Enter в форме; ветка создана и активна. Tag `release-e2e` даёт detached; полный OID через `Commit id` + Enter снова detached на выбранном коммите; строка контекста показывает `detached`.
3. Ветка `second`, занятая linked worktree, даёт понятную ошибку; root остаётся на `main`.
4. Fetch с явным `stage6`, progress-индикатор виден во время реального fetch, затем notice `Fetched stage6`; ahead/behind и freshness обновляются. Push с явной веткой и progress обновляет bare ref. Non-fast-forward push показывает `Push rejected`/`does not force-push`; remote и локальная ветка не меняются.
5. Merge conflict показывает `Merge in progress`, число конфликтов и Abort; Abort очищает состояние. Rebase завершается только после Git. Второй merge conflict разрешается внешним edit + `git add`, затем Continue создаёт настоящий merge commit; `unfinished` исчезает.
6. Соседние popup/catalog/diff/mutation/log/golden spec прошли в том же прогоне (см. таблицу).

## Найденные регрессии и пределы

- Первая версия checkout передавала полный `refs/heads/...` в `git checkout`, что **отсоединяло HEAD** вместо переключения ветки. Это поймал real-Git test; исправлено коротким именем после проверки полного ref, проверка `symbolic-ref` добавлена.
- `git fetch`/`git push` по умолчанию могли рекурсивно затронуть сабмодули (fixture падал на `upload-pack: not our ref`). Добавлен явный `--no-recurse-submodules`: выбранный контекст не выполняет скрытую сеть за соседей.
- Быстрые последовательные действия с `expectedState` упирались в устаревший hash после собственного checkout/fetch. Для branch-действий введён `expectedHead` + `expectedRefOid`, а renderer отслеживает HEAD из receipt; обновление из snapshot не перетирает более свежий receipt, но следует реальному внешнему HEAD.
- Первая версия progress не разбирала `remote: Counting objects` как отдельный title; добавлены `remote: Counting objects`/`remote: Compressing objects`, а подписка получает поздний `done` из bounded completed cache.
- Popup navigation перехватывала ArrowUp/Down у новых native `<select>`; добавлено исключение, чтобы remote/push choices сохраняли клавиатурное поведение.
- Временный e2e fixture должен был иметь dirty root, иначе stock harness не находит root commit box; это свойство тестового fixture, не продукта.
- Broad regression: **398 passed / 401**. Два падения `git-network-safety-real-git.test.ts` — от ambient `SSH_ASKPASS=/usr/bin/false` в текущей оболочке (ожидается пустой); с `env -u SSH_ASKPASS` файл проходит. Один тест `blob-absence-real-git.test.ts` («does not substitute HEAD for a corrupt index blob») падает в `git-diff-document-read.ts` на `cat-file -s` отсутствующего объекта; этот файл и его тест — untracked stage-3 изменения, stage 6 их не касался, поэтому баг зафиксирован как предел, а не исправлен в чужом этапе.
- Полные Electron-прогоны выявили два дефекта: (1) новый banner незавершённой операции использовал `role="status"` и ломал селектор существующего catalog-теста; заменён на `aria-live` без role. (2) После закрытия/открытия popup форма New Branch могла использовать HEAD из ещё не обновлённого snapshot и получала честный `stale`; HEAD из последнего receipt теперь сохраняется по context ID между remount, а формы выключены до загрузки refs. Оба spec прошли отдельно, затем финальный полный прогон дал **9 passed**. Один промежуточный полный прогон также показывал 10-секундное ожидание обновления mutation spec под нагрузкой; в двух последующих полных прогонах он прошёл.
- Пределы: проверен только локальный macOS Electron с настоящими локальными bare remotes; SSH/WSL/Windows execution hosts и release package не запускались. Теги можно checkout, но не создавать; push только локальных веток; fetch/push не рекурсируют в сабмодули; cherry-pick и полноценный conflict resolver — этап 8. Прогресс зависит от того, печатает ли Git meter; UI всегда показывает фазу подключения/завершения. Recovery-копии stage 4 не GC-ятся.

## Следующий этап

Этап 7 (полное обслуживание сабмодулей и пакетные операции) не начинался. Изменения этапов 1–6 сохранены без commit/publish.
