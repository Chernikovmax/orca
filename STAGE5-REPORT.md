# Этап 5 — История, граф и сравнение ревизий

## Результат

В `orca/` продолжены сохранённые незакоммиченные изменения этапов 1–4. Полностью реализован только этап 5: Source Control получил Log-поверхность для выбранного Git-контекста (корень или любой инициализированный сабмодуль), порционную историю с фиксацией OID, фильтры, виртуализированный список с графом, явный выбор родителя merge-коммита, файлы выбранного коммита, сравнение двух ревизий и переход из gitlink diff в историю сабмодуля. Использован существующий `git.history` reader, существующий граф/строки, существующие commit-diff вкладки и тот же transport/authorization; второй history backend и mutations этапа 6 не добавлялись. Production bundle, глобальный CLI и пользовательский профиль не менялись.

## Контракт

- **Один reader.** `loadGitHistoryFromExecutor` расширен: `GitHistoryOptions` получил `contextId`, `revision`, `cursor { tipOid, offset }`, `path`, `message`; `GitHistoryResult` — `generation`, `tipOid`, `browsedRef`, `empty`, `nextCursor`. Валидация cursor/фильтров вынесена в `src/shared/git-history-options.ts`, разрешение ref/OID — в `src/shared/git-history-refs.ts`; loader остаётся в пределах 300-line gate. `src/main/git/history.ts` делегирует в `getWorkspaceHistory`, поэтому и IPC, и provider используют один путь.
- **Pinned pages.** Первая страница разрешает ревизию (HEAD, локальная/удалённая ветка, тег, полный OID) в commit OID. Продолжение передаёт этот OID и `offset`, читает `git log --skip=<offset> -n limit+1`; уже видимые страницы не сдвигаются внешним commit или движением refs. `generation` — токен над contextId/tip/фильтрами; страница другого generation/tip не добавляется (чистая функция `workspace-log-model.ts`), а renderer перечитывает первую страницу. Поздний ответ отбрасывается sequence guard. Snapshot `head/branch/refs` образует `signature`: изменение HEAD/refs перечитывает историю.
- **Фильтры и офлайн.** Revision selector (HEAD, heads, remotes, tags), repository-relative path (`:(literal)` pathspec) и регистронезависимый поиск по message (`--fixed-strings --regexp-ignore-case --grep`). Чтение без shell, `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=''`, без external diff, 8 MiB stdout и 15 s timeout. Отсутствующий локально объект (`bad object`, `Could not read`, `revision walk setup failed`) классифицируется как `unavailable` с текстом «not available locally; no fetch was attempted»; `invalid-input`, `limit` и `git-error` отделены.
- **UI.** `SourceControlWorkspaceLog` — третья view рядом с Changes/Submodules; Open Log доступен из popup контекстов, из заголовка Changes и как `Open child Log` в gitlink diff. Список виртуализирован (фиксированная высота строки, окно + overscan, keyboard selection), а граф строится по всем загруженным элементам, поэтому lanes сохраняются при подгрузке. Unborn checkout показывает «No commits in this checkout yet», detached HEAD подписан коротким OID.
- **Merge и ревизии.** Детали показывают `parentIds`; каждый родитель — кнопка с `aria-pressed` (по умолчанию первый), для root commit доступен `Empty tree`. «Use as compare base» фиксирует произвольную базу, после чего выбор другого коммита показывает diff `base..target`. Список файлов — `getWorkspaceCommitCompare` → существующий `getCommitCompare(checkout, commit, options, baseOid)`; `git.commitCompare` расширен `contextId`/`baseOid` в IPC, runtime RPC, preload и web client. Невалидная база даёт `invalid-base` с явным сообщением.
- **Diff вызывающих.** Файл коммита открывается существующей commit-diff вкладкой: `openCommitDiff` принимает `gitDiffSelection` (стороны commit/empty + contextId + oldPath), а `useEditorPanelDiffContentLoader` предпочитает выданную selection маршруту commitDiff, поэтому дочерний diff читается через уже авторизованный `git.diff`. Идентификатор вкладки получает context suffix.
- **Авторизация.** `readAuthorizedGitContext` выполняет свежий `getStatus(includeWorkspace)` и `verifyWorkspaceContext` для каждого чтения по `contextId`. Неизвестный id и контекст другого worktree отклоняются; история ребёнка не отвечается коммитами родителя. Чтение без `contextId` сохраняет legacy-поведение для CLI/старых клиентов.

## Затронутые файлы (основное)

Новые: `src/shared/git-history-{options,refs}.ts`, `src/main/git/source-control/git-workspace-{history,read}.ts`, `git-workspace-history-real-git.test.ts`, renderer `panel/{workspace-log.tsx,workspace-log-list.tsx,workspace-log-details.tsx,workspace-log-model.ts,use-workspace-log.ts,workspace-log.test.tsx,workspace-log-model.test.ts}`, E2E `tests/e2e/git-workspace-log.spec.ts`.

Изменено: `src/shared/git-history.ts`, `git-history-types.ts`, `src/main/git/history.ts`, `commit-compare.ts`, IPC `filesystem-git-status-handlers.ts` и `git-remote/compare-handlers.ts`, provider contract/local provider, RPC `git.ts`, `runtime-git-diff-commands.ts`, preload bridge/API, web `web-git-api.ts`, renderer `runtime-git-diff-client.ts`, editor loader, `GitDiffDocumentSurface.tsx`, `open-history-diff.ts`, `panel-ready.tsx`, `workspace-popup{,-refs}.tsx`, `workspace-changes.tsx`, `workspace-catalog.tsx`, `git-params.ts`. Документация: `CHANGELOG.md`, `docs/reference/git-workflow.md`, `PLAN.md`, `ARCHITECTURE.md`.

## Выполненные проверки

Среда: Darwin arm64, checkout `/Users/chernikovmax/orca/projects/light/orca`, Node 24.22.1 через process-local `npm exec`, Electron 43.8.1. Глобальный CLI не устанавливался.

| Проверка | Результат |
|---|---|
| Новый real-Git suite истории (`git-workspace-history-real-git.test.ts`) | **10 passed** |
| History-focused batch (shared history/graph/real-repo + новый real-Git + model + UI) | **45 passed / 6 files** |
| Renderer Log UI/model (включая keyboard selection) | **8 passed / 2 files** |
| Broad transport/diff/renderer batch (RPC/provider/runtime/editor/store/UI history) | **243 passed / 19 files** |
| Stage 1–4 backend + transport + renderer regression | **260 passed / 18 files** |
| Web TypeScript (`config/tsconfig.web.json --noEmit --composite false`) | exit 0 |
| Node TypeScript (`config/tsconfig.node.json --noEmit --composite false`) | exit 0 |
| RPC catalog `generate-rpc-params-catalog.mjs --check` | exit 0 |
| Targeted oxlint по stage-5 файлам | exit 0 |
| Electron-vite build `--mode e2e`, `VITE_EXPOSE_STORE=true` | exit 0; **176 chunks, 6061.6 KB** |
| Настоящий Electron: log + popup/catalog/diff/mutation/golden | **6 passed / 2.2 m**, hidden window (финальный прогон при load ~11) |

Команды:

```sh
npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run \
  --config config/vitest.config.ts \
  src/shared/git-history.test.ts src/shared/git-history-graph.test.ts \
  src/shared/git-history-real-repository.test.ts src/shared/git-history-message-allocation.test.ts \
  src/shared/git-history-ref-display.test.ts src/main/runtime/rpc/methods/git.test.ts \
  src/main/git/status-branch-compare.test.ts src/main/providers/local-git-provider.test.ts \
  src/main/runtime/orca-runtime-git-branch-diff.test.ts src/main/runtime/orca-runtime-git-diff-budget.test.ts \
  src/main/runtime/orca-runtime-git.test.ts src/main/runtime/runtime-git-branch-compare-admission.test.ts \
  src/main/ipc/filesystem-branch-compare-diff.test.ts \
  src/renderer/src/components/editor/editor-panel-diff-reload.test.ts \
  src/renderer/src/components/editor/combined-diff-on-demand-load.test.ts \
  src/renderer/src/store/slices/editor-branch-diff-snapshots.test.ts \
  src/renderer/src/store/slices/editor-git-status-reconciliation.test.ts \
  src/renderer/src/components/right-sidebar/source-control/panel/workspace-log.test.tsx \
  src/renderer/src/components/right-sidebar/source-control/panel/workspace-log-model.test.ts
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.web.json --noEmit --composite false
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.node.json --noEmit --composite false
node config/scripts/generate-rpc-params-catalog.mjs --check
env VITE_EXPOSE_STORE=true ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node config/scripts/run-electron-vite-build.mjs --mode e2e
env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test \
  --config .cache/stage5-playwright.config.ts --project electron-headless
```

Временный `.cache/stage5-playwright.config.ts` выбирал шесть постоянных spec и отключал stock global setup/teardown (они могли готовить глобальный CLI); после прогона удалён. `helpers/orca-app.ts` создавал disposable HOME/userData и завершал только собственные Electron-процессы. Снимки: `.cache/stage5-log-root.png`, `stage5-log-child.png`, `stage5-log-empty.png`.

## Покрытые сценарии приёмки

Real Git (временный fixture с merge graph, четырьмя checkout и linked worktree):

- 130 дополнительных коммитов: страницы 50/50/… собираются без дублей и пропусков и точно совпадают с `git rev-list --topo-order`; `generation`/`tipOid` стабильны; commit, созданный между страницами, не сдвигает pinned walk; новый первый запрос даёт другой generation и tip.
- Merge-коммит: оба родителя в правильном порядке; сравнение с первым и вторым родителем дают разные наборы файлов; явная несуществующая база даёт `invalid-base` с «no fetch».
- Фильтры path/message возвращают только нужные коммиты; escape-path отклоняется.
- Дочерний checkout: своя история и свои файлы коммита, ни один root-commit не появляется; context, выданный другому worktree, отклоняется.
- Detached HEAD: `currentRef` — commit, tip совпадает с реальным HEAD. Два worktree одного репозитория имеют разные истории.
- Unborn checkout: пустой результат, `empty: true`, `tipOid: ''`. Запрос несуществующей ревизии и удалённый локальный объект (и для revision, и во время `git log`) дают явную ошибку без fetch.

Electron (root + сабмодули, настоящий Git и Monaco):

1. Log открывается из view switch; первая страница 50+, догрузка до конца истории показывает реальное количество коммитов.
2. Merge-коммит после фильтра по сообщению сохраняет SVG графа; детали показывают двух родителей; Parent 1/Parent 2 дают разные файлы.
3. Файл коммита открывает существующую Monaco-вкладку; modified-сторона содержит реальное содержимое выбранного коммита.
4. «Use as compare base» + выбор другой ревизии показывает сравнение двух ревизий и файл разницы; Exit compare возвращает обычный режим.
5. Внешний commit в root + focus перечитывает первую страницу, не смешивая страницы; верхняя строка — новый commit.
6. Popup → Open Log для `one/same` показывает историю ребёнка; фильтр по root-сообщению не находит коммитов и родительская история не подставляется.
7. Gitlink diff → `Open child Log` открывает Log выбранного сабмодуля; Open Log из заголовка Changes делает то же для текущего контекста.
8. Внешний detached HEAD показывает `HEAD · <oid>`; после возврата на ветку состояние снова обычное.
9. Пустой (unborn) репозиторий показывает «No commits in this checkout yet» и `HEAD · unborn`.
10. Удалённый локальный объект в сабмодуле показывает alert «no fetch was attempted»; после восстановления объекта Refresh возвращает историю.
11. До/после просмотра (и после собственного внешнего commit теста) HEAD, `show-ref`, `ls-files --stage` и `status --porcelain` всех пяти checkout совпадают; окно hidden; попутно прошли popup/catalog/diff/mutation/golden specs.

## Найденные регрессии и пределы

- Arrow-навигация popup: добавление второй кнопки действия сдвигало индекс, и ArrowDown из поиска refs попадал в «Open Log» вместо первой ref. Кнопки помечены `data-navigation-action`, и ArrowDown из поиска теперь целенаправленно выбирает первую ref; ArrowUp с ref по-прежнему достигает действий. Существующий popup spec прошёл без ослабления.
- `getDiff` в local provider при отсутствии selection больше не передаёт trailing `undefined`, иначе parity-тест провайдера и WSL-проверка последнего аргумента ломались. Это сохранение прежней формы вызова, не ослабление теста.
- Первая версия UI не классифицировала `Could not read <oid>` как missing object — alert показывал сырой `git log`; добавлена классификация и real-Git проверка для missing ancestor и missing revision.
- Заголовок Log брал `repository.branch` как полный ref (`refs/heads/master`) и не показывал unborn; теперь имя нормализуется, а unborn и pinned ОID-ревизия подписаны явно.
- `generation`-несовпадение при догрузке сначала терялось: notice очищался успешной перезагрузкой. Теперь уведомление сохраняется до смены фильтров/Refresh, а страница другого поколения не добавляется.
- Два промежуточных Electron-прогона при системной load average ~32 падали не на Log-сценарии, а на 5-секундном ожидании обновления списка в уже существующем mutation spec (страница успевала обновиться позже). Та же исходная сборка при load ~11 дала финальные **6 passed**; assertions и таймауты stage-4 spec не менялись. Это зафиксированная чувствительность UI-smoke к загруженности машины, а не выданная за стабильный результат.
- Пределы: страница 50 (max 200), не более 5000 загруженных коммитов (`--skip`), фиксированная высота виртуализированной строки; combined «open all changes» доступен только для root, дочерние контексты открывают файлы по одному. Проверен только локальный macOS Electron; SSH/WSL/Windows execution hosts и release package не запускались. На больших историях `--skip` линеен по числу загруженных коммитов — это осознанный предел, а не обещание произвольной глубины.

## Следующий этап

Этап 6 (ветки, remotes, завершение меню переключателя) не начинался. Изменения этапов 1–5 сохранены без commit/publish.
