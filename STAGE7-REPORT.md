# Этап 7 — обслуживание сабмодулей и пакетные операции

## Результат и граница публикации

Этап 7 завершён в проверенной локальной среде. Этапы 8–9 **не начаты**. После передачи `STAGE7_READY` правки этой сессии и её сабагентов остановлены до отдельного разрешения пользователя после согласованного commit/push сессией публикации `term_4e48fe00-3fd7-4848-8e73-43a1eb477a02`.

Commit/push исходного проекта эта сессия не выполняла. Commit/push в проверках относятся только к временным Git-fixture и локальным bare remote. Предоставленный пользователем fork `https://github.com/Chernikovmax/orca` здесь не менялся; remote и публикацию проверяет сессия публикации.

## Выполненные требования

- Initialize выбранного сабмодуля: offline-preview URL/пути/OID, явный выбор рекурсии, последовательное раскрытие ранее неизвестных потомков. Каждый обнаруженный уровень заново авторизуется и проверяется; unchecked `--recursive` не используется.
- Checkout различает commit из index родителя и выбранную локально доступную remote-tracking ревизию. Preview показывает полный целевой OID и detached HEAD; отсутствующие объекты не загружаются скрытым fetch.
- Создание рабочей ветки внутри detached-сабмодуля использует существующий New Branch выбранного контекста; настоящий UI-сценарий проверяет это после checkout remote-ревизии.
- URL sync показывает различия declared/effective URL и разрешает относительные URL на host. Без редактирования применяется текущая сырая декларация, а не её redacted отображение. Изменённый replacement URL — отдельный явный ввод. Preview/sync не используют сеть.
- Add выполняется в выбранном родителе после preview и отказывается от unrelated dirty `.gitmodules`, существующего назначения и небезопасного пути.
- Remove удаляет только проверенный stage-0 gitlink из index и выбранную worktree-декларацию `.gitmodules`, **не удаляя** checkout, неопубликованные commit, локальную конфигурацию или `.git/modules`. Нет force/deinit/cleanup. Остальные metadata-изменения не stage-ятся автоматически; `.gitmodules` пользователь stage-ит явно перед parent commit.
- Batch имеет явный выбор контекстов/рекурсии, staged paths, сообщений и публикаций, прогресс и результат каждого шага. Commit идёт от листьев к корню; каждый родитель требует отдельного подтверждения точного нового child OID перед staging gitlink.
- Publication идёт child-first. Перед parent push проверяются gitlink и URL из публикуемого parent commit, соответствие фактическому child destination и достижимость точного OID на явно fetched child branch. Относительный URL разрешается относительно destination родителя, не произвольного fetch remote. Непроверяемая доступность блокирует родителя.
- Межрепозиторные шаги освобождают очередь перед переходом и повторно проверяют зависимости. Known-failed следующий шаг допускает только явный retry после revalidation. Completed/unknown commit/push не воспроизводятся вслепую; дерево не объявляется одной транзакцией.

## Основные изменения

Все пути исходников ниже относительно `orca/`.

- `src/main/git/source-control/git-workspace-submodule-{metadata,preview-state,preview,initialize,apply}.ts` и `git-submodule-url.ts`: lifecycle, private preview authority, metadata/index fences, безопасное выполнение.
- `src/main/git/source-control/git-workspace-batch*.ts`: plan/state, execution, mutation dispatch, actions, reconciliation и destination/reachability proof. Старого re-export wrapper для submodule mutation не осталось.
- `git-workspace-mutation.ts`, `git-workspace-mutation-shared.ts`, `git-workspace-mutation-error.ts`: dispatch, разрешение только известных uninitialized gaps, отсутствие вложенного удержания очередей, корректные receipts.
- `src/shared/git-workspace-{mutation,batch}.ts`, `src/shared/rpc-contract/git-mutation-params.ts`, существующий runtime `rpc/methods/git.ts` и generated params catalog: новые действия проходят через существующий `git.mutate` / IPC / preload. Второй transport или Git backend не создавался.
- Renderer `source-control/panel/workspace-catalog.tsx`, `workspace-submodule-{actions,add}.tsx`, `workspace-batch-{actions,review}.tsx`, `use-workspace-batch-progress.ts`: reviews, confirmations, lifecycle и batch UI. Progress inspection читает только host-кэш, не запускает Git и не начинает/возобновляет шаг.
- Permanent tests: `git-workspace-submodule-real-git.test.ts`, `git-workspace-batch-real-git.test.ts`, `tests/e2e/git-workspace-submodules.spec.ts`; существующий catalog E2E использует точную строку контекста, а не substring всего текста.
- Обновлены `PLAN.md`, `ARCHITECTURE.md`, `orca/CHANGELOG.md`, `orca/docs/reference/git-workflow.md`.

## Фактические проверки

Финальный последовательный Vitest-прогон: **19 файлов, 306 тестов passed**, duration 416.37 s. В него включены 15 lifecycle и 6 batch real-Git сценариев, а также batch/status/diff/mutation/history/branch/queue, RPC/runtime/provider/IPC, renderer client/panel и CLI file-регрессии. Это выбранный релевантный набор, не полный suite репозитория.

Real-Git acceptance покрывает:

- root → child → nested, включая рекурсивную инициализацию ранее неизвестного потомка после deinit родителя, сохранение parent index и соседних данных;
- относительные URL, stale preview и изменение bytes `.gitmodules` при том же пути/URL;
- parent-index checkout, локальную remote-tracking ревизию, dirty child, реальный shallow/missing object без скрытого fetch;
- рассогласованные metadata, недоступный initialize remote и linked worktree родителя;
- add, отказ от unrelated dirty metadata и remove с неопубликованным commit и dirty sibling-декларацией;
- leaf-to-root commit, отдельные exact-OID подтверждения, child-first publication и чистый рекурсивный clone с выбранными ревизиями;
- частичный сбой публикации и explicit retry без повторного child push, исчезнувшую child branch и неправильный committed child URL;
- publication-only batch, прерванную HTTP-публикацию с outcome unknown без повторного запроса и inspect-only до запуска без network/write.

Настоящий собранный **скрытый Electron**: все 14 выбранных сценариев прошли **тремя последовательными группами: 3 + 9 + 2**, а не одним полностью зелёным запуском. Первые две группы останавливались на неверных тестовых селекторах; после их исправления следующие группы закрыли оставшиеся сценарии. Пять новых stage-7 сценариев проверяют initialize с рекурсией; remote/index checkout и New Branch; трёхуровневый batch commit с двумя parent confirmations; URL sync и data-preserving remove; add внутри выбранного child без изменения root index. Девять соседних сценариев покрывают branches, catalog, diff, log, mutation, popup и golden Monaco diff.

Финальные статические проверки после последних source/test-изменений завершились с exit 0:

- TypeScript `config/tsconfig.node.json`, `--noEmit --composite false`;
- TypeScript `config/tsconfig.web.json`, `--noEmit --composite false`;
- `node config/scripts/generate-rpc-params-catalog.mjs --check`;
- targeted `oxlint --threads=1` для lifecycle/batch/mutation/shared/schema/runtime/UI и двух изменённых E2E-файлов.

E2E build `node config/scripts/run-electron-vite-build.mjs --mode e2e` прошёл с `VITE_EXPOSE_STORE=true`; renderer boot graph: **176 chunks / 6062.0 KB minified**. Build уже включает окончательный data-preserving remove. После сборки production source не менялся. Предупреждения о крупных chunks/неэффективном dynamic import и Vitest/Vite native config loader остались предупреждениями, не скрывались.

## Воспроизведение выбранных проверок

Среда: macOS arm64, Node 24.22.1 через cached offline npm exec, Git 2.39.5 (Apple). Все тяжёлые команды запускались последовательно с `nice -n 15`; Vitest/Playwright — один worker, formatter/linter — один thread; TypeScript — heap limit 3072 MiB. Индексация не запускалась, остановленный LSP не перезапускался.

Префикс Node-команд:

```sh
nice -n 15 env UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 GOMAXPROCS=1 \
  npm exec --offline --package=node@24.22.1 -- node --max-old-space-size=3072
```

Финальный Vitest использовал `env -u SSH_ASKPASS`, `node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=1 --no-file-parallelism` и файлы:

```text
src/main/git/source-control/git-workspace-submodule-real-git.test.ts
src/main/git/source-control/git-workspace-batch-real-git.test.ts
src/main/git/source-control/git-workspace-status-real-git.test.ts
src/main/git/source-control/git-diff-document-real-git.test.ts
src/main/git/source-control/git-workspace-mutation-real-git.test.ts
src/main/git/source-control/git-workspace-history-real-git.test.ts
src/main/git/source-control/git-workspace-branch-real-git.test.ts
src/main/git/source-control/git-workspace-branch-units.test.ts
src/main/git/source-control/git-mutation-queue.test.ts
src/main/runtime/rpc/methods/git.test.ts
src/main/runtime/runtime-git-sync-commands.test.ts
src/main/runtime/orca-runtime-git.test.ts
src/main/providers/local-git-provider.test.ts
src/main/ipc/filesystem-git-status-staging.test.ts
src/renderer/src/runtime/runtime-git-client.test.ts
src/renderer/src/components/right-sidebar/source-control/panel/*.test.*
src/cli/handlers/file.test.ts
```

Electron запускался с `ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 PW_TEST_SCREENSHOT_NO_FONTS_READY=1` и `env -u SSH_ASKPASS`. Временный `.cache/stage7-playwright.config.ts` использовал `defineConfig` из `@stablyai/playwright-test`, `testDir: '../tests/e2e'`, `timeout: 180000`, `expect.timeout: 15000`, `workers: 1`, `retries: 0`, reporter `list` и project `{ name: 'electron-headless', grepInvert: /@headful/, metadata: { orcaHeadful: false } }`. Stock global setup/teardown не подключались, чтобы не трогать global CLI. Test match: `git-workspace-{submodules,branches,catalog,popup,diff,mutation,log}.spec.ts` и `golden-source-control-open-diff.spec.ts`. Временный config и случайные пустые scaffold-каталоги удалены после проверок.

## Найденные и исправленные ошибки

- Discovery честно помечает uninitialized gaps как incomplete; для initialize разрешены только эти известные gaps, а не произвольная неполнота/ошибка каталога.
- Обычный `git rm --cached` отказывал при dirty `.gitmodules`. Реальный Electron выявил отказ; замена на проверенную NUL-delimited index-info deletion без force подтверждена real-Git regression и UI. Checkout/OID и sibling metadata сохраняются.
- Publication-only batch больше не требует фиктивного commit; неизвестный исход публикации сохраняется и не replay-ится. Inspect-only до начала не запускает операции.
- Проверка parent publication учитывает именно URL committed parent tree и фактический child destination, в том числе relative URL; проверка существования OID только в локальной object database недостаточна.
- В E2E точная строка `two` заменяет substring, совпадавший также с `network`; add textbox адресуется реальным доступным именем `URL`.

## Ограничения и остановка

- Проверены local macOS arm64, временные настоящие Git-репозитории, local bare remotes и loopback HTTP. SSH/WSL/Windows execution hosts, внешние credentials/network remotes и release packaging не запускались.
- Полный suite репозитория не запускался. Ранее известная baseline-проблема corrupt-index в `blob-absence-real-git.test.ts` из этапа 6 в выбранный прогон не включалась и повторно не проверялась.
- Remove — сохранение данных, не обещание физической зачистки. Директория может стать untracked; HEAD metadata может сохранять историческую запись до parent commit.
- Раздельные/множественные child fetch/push endpoints и недоказуемая shallow ancestry блокируют parent publication. Remote proof — point-in-time; внешнее изменение remote после проверки не превращает несколько репозиториев в атомарную транзакцию.
- Batch state — до 64 планов на 15 минут в памяти host, не durable journal. Restart/истечение token требует нового чтения и preview; unknown outcome не даёт права автоматически повторить commit/push.
- Registry перед handoff показывает `SubmoduleLifecycle`, `WorkspaceBatch`, `SubmoduleUi` в состоянии parked. Активного или упавшего изменяющего сабагента нет; повторное выполнение им не отправляется. Проверки завершены, индексация не запускалась.
- Следующее действие — только сообщение `STAGE7_READY` сессии публикации. До разрешения пользователя после её commit/push никаких новых файловых правок, этапов 8–9, commit или push этой сессией.
