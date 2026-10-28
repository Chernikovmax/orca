# Git Workspace для Orca

Статус: этапы 0–9 реализованы и прошли описанную локальную приёмку на официальном checkout. Git-каталог, Changes/diff, popup, частичные операции, история, ветки/remotes, обслуживание сабмодулей, пакеты commit/publish и contextual conflict resolver используют существующие host authority, editor и transport. Performance budgets этапа 0 выполнены; это не доказательство live-поддержки всех execution hosts. Пользователь опубликовал этапы 1–7 коммитом `60503340e85a532d56791769f6854d32a921c695` и после завершения проверок отдельно разрешил commit/push готовых этапов 8–9 в текущую ветку форка `Chernikovmax/orca`. Порядок — PLAN.md; доказательства — STAGE1–STAGE9-REPORT.md.

## Цель

Нативная Git-поверхность Orca с удобством JetBrains: обзор изменений, качественный diff, частичные коммиты, история веток и разрешение конфликтов. Без IntelliJ Platform, JVM и зависимости от сервисов JetBrains.

Не цель: копирование всех возможностей WebStorm, собственная реализация Git или отдельный Git-клиент рядом с Orca.

## Подтверждённый контекст и ограничения

### Проверка этапа 0

Официальный source установлен по `/Applications/Orca.app/Contents/Resources/app-update.yml` (`owner: stablyai`, `repo: orca`, `provider: github`) и metadata `app.asar:package.json` (`homepage`). [GitHub API](https://api.github.com/repos/stablyai/orca) подтверждает публичный MIT repository [stablyai/orca](https://github.com/stablyai/orca); URL не подбирался по названию. Установленный Orca — `1.4.237`, commit `73930bedee1b2492f8445d1867580924bf4db15e` по `orca-local-build.json`.

В `orca repo list`, `project list` (6 проектов) и `worktree list` (16 записей, без truncation) исходников приложения не было. Проверены `/Users/chernikovmax/orca/{projects,workspaces}`, `WebstormProjects`, `IdeaProjects` и проектные каталоги `Documents`; доступного checkout Orca не найдено. Это область поиска, не утверждение об отсутствии исходников на всех дисках/хостах.

С разрешения координатора создан отдельный checkout: `/Users/chernikovmax/orca/projects/light/orca`, `git clone --depth 1 --filter=blob:none https://github.com/stablyai/orca.git orca`. Исследован revision `e73ca2aec7c98773f9b3027a6eb12dabbd89cfa2` (package version `1.4.214`). Это не revision установленной production-сборки; результаты ниже относятся к checkout, а не к performance production.

### Реализованный срез этапа 7

Обслуживание сабмодулей использует существующий `git.mutate` через IPC/RPC/preload, без второго Git backend. Host-issued preview связывает действие с контекстом, аргументами, сырыми URL и content/index fence `.gitmodules`/gitlink; renderer получает безопасные отображаемые URL, а не authority для их повторной записи. Initialize раскрывает ранее неизвестных потомков только после явного подтверждения рекурсии и валидирует каждый уровень отдельно. Checkout различает index родителя и доступную локальную remote-ревизию, не делает скрытый fetch. Для разработки после detached checkout используется существующий New Branch.

Lifecycle разделён по ответственности на metadata, preview/state, initialize и apply; пакет — на plan/state, run, mutation dispatch, actions/runtime/reconcile и destination proof. Все операции используют существующий runner и очередь затронутого common Git dir. Межрепозиторные переходы освобождают очередь и повторно проверяют зависимости; одновременно несколько очередей не удерживаются.

Remove — намеренно data-preserving deregistration: stage-0 gitlink удаляется из index через NUL-delimited `update-index --index-info`, выбранная декларация меняется в worktree `.gitmodules`, но checkout, неопубликованные commit, local config и `.git/modules` остаются. Нет force/deinit/физического удаления и скрытого staging остальных metadata-изменений. Add отказывается от unrelated dirty `.gitmodules`. URL sync не использует сеть и разделяет запись родительской конфигурации и child remote на проверяемые шаги; частичный результат не называется транзакцией.

Batch строится из явного выбора контекстов/рекурсии, staged paths, сообщений и destinations. Commit идёт от листьев к корню; каждый parent gitlink требует отдельного подтверждения точного нового child OID. Push идёт child-first и требует доказательства достижимости OID на выбранном remote плюс соответствия URL из публикуемого parent commit фактическому child destination; относительный URL разрешается относительно destination родителя. Непроверяемые/множественные destinations блокируют родителя. Доказательство point-in-time, не атомарная гарантия против внешнего изменения remote.

Прогресс — ограниченное host-only состояние: до 64 batch preview на 15 минут; `inspectOnly` не запускает Git и не возобновляет шаг. Состояние не переживает host restart; нужен новый preview. Повтор разрешён только явно для known-failed следующего шага после revalidation, не для completed/unknown commit/push.

Проверка: 306 passed в 19 файлах финального последовательного Vitest-прогона, включая 15 lifecycle и 6 batch real-Git сценариев. Настоящий скрытый Electron: 14 выбранных сценариев прошли тремя последовательными группами, пять из них новые для этапа 7; сборка boot graph — 176 chunks / 6062.0 KB minified. Проверены local macOS arm64, временные настоящие Git-репозитории/local bare remotes и loopback HTTP. SSH/WSL/Windows, release packaging и весь набор репозитория не проверялись. Подробности — STAGE7-REPORT.md.

### Реализованный срез этапа 8

`git.mutate` получил `readConflict`, `saveConflict`, `resolveConflict` и отдельный `GitWorkspaceConflictDocument`. Host читает реальные index stages 1/2/3 и result офлайн; содержимое ограничено 8 MiB на сторону, бинарные bytes не декодируются с потерями. Private documents ограничены 32 записями/64 MiB/15 минутами. Перед записью проверяются host-issued context, checkout identity, HEAD/operation markers, index OID/mode/stages и точные worktree bytes/mode/absence; очередь остаётся общей для common Git directory.

Существующий editor и conflict review показывают один resolver: read-only base/ours/theirs, editable Monaco result, блоковые choices и навигация. Save пишет только worktree, возвращая новый token; Mark Resolved отдельно записывает stage 0 или явное удаление. Generic filesystem save/autosave не обходит этот путь. Черновики разделены по owner/worktree/absolute path; stale write блокируется, explicit Reload сохраняет предыдущую несохранённую версию для восстановления.

Add/add, modify/delete, rename-associated paths, binary/symlink и gitlink представлены явно. Whole-side choice сохраняет bytes/mode, edited result учитывает `.gitattributes` normalization. Gitlink показывает оба child OID, открывает существующие child Changes/branch/commit и записывает явно выбранный локально проверенный commit только в parent index. Незакоммиченные невыбранные child files остаются нетронутыми. Merge/rebase/cherry-pick continue/abort проверяют реальные markers; rebase sides подписаны в реальной stage-семантике.

Проверка этапа 8: 233 passed в 27 выбранных host/editor/transport файлах, включая 13 conflict real-Git сценариев; 4 новых hidden Electron journeys прошли одним последовательным прогоном. E2E build: 176 chunks / 6062.4 KB minified. На реальных данных воспроизведены и исправлены ошибки CRLF index normalization и несовместимости legacy conflict-metadata guard с contextual opening. Проверены local macOS arm64 и изолированные временные Git fixture; remote/Windows runtime и release package не заявляются проверенными. См. STAGE8-REPORT.md.

### Сквозная приёмка и hardening этапа 9

Ошибочный legacy root porcelain переходит к тому же безопасному workspace reader, сохраняя реальные root entries и явные discovery errors вместо ложного clean. Preview/write и HEAD fencing проверяют полноту выбранного repository; unavailable sibling не блокирует здоровый child commit. Lifecycle и dependency batch сохраняют свои более широкие completeness guards.

Checkout/New Branch принудительно отключают Git submodule recursion, чтобы пользовательский `submodule.recurse=true` не менял HEAD/branch/index невыбранного ребёнка. Conflict writer отказывает при нескольких hard links до truncate. Resolved document перечитывается при повторном открытии; inactive clean renderer cache освобождается без потери unsaved/recovery данных. Длинный popup ограничен grid track и собственными scroll regions, без clipping вместо решения sizing.

Uncached diff не читает неиспользуемый status/upstream для unstaged, не запускает отдельный blob-size probe и не вызывает config для действительно отсутствующего `.gitmodules`. Read buffers ограничены нужным размером, обрабатываются только инициализированные bytesRead. Для обычного index→worktree staging pre-patch fence отдаёт те же index records displayed base; после Git patch сохраняется полная fresh HEAD/index/content проверка. Изменение index во время blob read даёт stale без writable token. Racy-write cache margin не ослаблен.

Проверка: 524 passed / 46 файлов и 49 passed / 7 cache/stamp файлов (573 / 53, два последовательных прогона), Node/Web TypeScript/catalog/lint exit 0. Настоящие hidden Electron группы покрывают прежние 14 journeys, 4 conflict journeys, watcher/draft recovery и длинный popup; после последнего producer повторены IPC/fresh-host/CLI и root/child partial-stage flow. В полном каталоге 129 строк/25 hover дали 0 Git starts; история 323 commit прошла 7 страниц с 43–44 DOM строками. Финальные latency/memory значения, ранние отказы и неизменённые budgets — STAGE9-REPORT.md.

Live inventory: только local host, environments отсутствуют. Remote disconnect/unknown outcome подтверждён loopback HTTP, не live SSH/WSL/Windows. CLI smoke использует текущие source handlers и настоящий RuntimeClient socket, не packaged executable. Release package, другие платформы и весь repository suite не заявляются проверенными. Worker завершён без оставшихся изменений; own fixtures/scripts удалены, raw evidence оставлен в ignored cache. Source commit/push разрешён последующим прямым указанием пользователя; временные данные не включаются.

### Карта переиспользования

Все пути ниже относительно корня checkout Orca (во внешней папке проекта это `orca/`); исторические описания этапа 0 не объявляют тогдашние отсутствовавшие функции реализованными.

| Область | Реальные точки и потребители | Решение |
|---|---|---|
| CLI открытия | `src/cli/handlers/file.ts:146-165,217-300`, `FILE_HANDLERS`, `openFileDiff`; `file diff --staged` передаёт `staged: true`; `open-changed` читает `git.status` и различает `entry.area` | Сохранить команды и их status-to-open цикл |
| Runtime transport | `src/cli/runtime/client.ts:74-147`, `RuntimeClient.call`; `src/main/runtime/rpc/methods/{files,git}.ts`; `src/main/runtime/files/file-access.ts:77-115`, `openMobileDiff` | Расширять существующие RPC `files.openDiff`, `git.status`, `git.diff`; не создавать второй транспорт |
| Host identity/authorization | `src/main/runtime/runtime-git-command-target.ts:17-110`, `RuntimeGitTarget.executionHostId`; `runtime-git-status-commands.ts:21-34`; `src/main/ipc/filesystem/filesystem-git-status-handlers.ts:42-88`; `registered-worktree-roots-cache.ts` | Сохранить execution-host routing, workspace permission, проверку зарегистрированных корней и безопасного относительного пути; Git-контексты сабмодулей должны расширять эту authority |
| Git/process | `src/main/git/source-control/status-read.ts:41-52`, `getStatus`; `source-control/file-diff.ts:32-59`, `getDiff` и stamped settled cache; `src/main/git/runner.ts`; `src/main/git/command-runner/git-stream-stdout.ts:58-120`, `gitStreamStdout`; `src/shared/git-status-types.ts` | Расширять текущий porcelain-v2 pipeline, diff cache и centralized process admission; статус/diff не читать отдельным клиентом |
| Watchers | `src/main/ipc/worktree-base-directory-watcher.ts:38-96`, `worktree-git-status-ref-watch.ts:14-86` | Переиспользовать существующее наблюдение Git metadata/upstream; отдельно проверить per-worktree/common git-dir для каталога потомков |
| Renderer / local и remote | `src/renderer/src/runtime/runtime-git-diff-client.ts:10-133`, `getRuntimeGitDiff`: `window.api.git.diff` для local/SSH и `callRuntimeRpc('git.diff')` для runtime-owned worktree | Мигрировать оба пути и shared params `src/shared/rpc-contract/{git,files}-params.ts` вместе |
| Source Control / ветка | `src/renderer/src/components/right-sidebar/SourceControl.tsx`; `source-control/panel/{panel,use-panel-model,header-toolbar,branch-context-row,panel-content,panel-dialogs}.tsx` (model — `.ts`); `SourceControlBranchContextRow` | Расширять first-party panel. Имеющаяся `Change base ref` открывает compare-base picker, не checkout и не popup каталогов сабмодулей |
| Diff / editor | `src/renderer/src/components/editor/{EditorContent,EditorDiffFileSurface}.tsx`; `src/renderer/src/store/slices/editor/actions/{open-unstaged-diff,open-history-diff,open-combined-diff}.ts`; `types/open-file.ts:31-99`, `OpenFile` | Переиспользовать Monaco и существующие staged/unstaged/branch/commit/combined diff-вкладки, снимки и routing |
| Persistence | `src/renderer/src/lib/workspace-session.ts:117-200`, `buildEditorSessionData` | Сейчас сохраняются только `mode === 'edit'`; diff-вкладки не восстанавливаются после restart. Сохранение Git-контекста/позиции из предложения ещё предстоит реализовать |
| Сабмодули | `source-control/listing/{submodule-expansion,entry-actions}.ts`; `source-control/commit/discard-all-sequence.ts` | Уже есть раскрытие nested status и запрет parent stage для worktree-only дочерних изменений; gitlink stage разрешён. Это не доказательство полного рекурсивного каталога/branch workflow |
| Extensions / поставка | `src/renderer/src/store/plugin-panels.ts`, `right-sidebar/plugin-panel-activity-items.ts`; `.github/CONTRIBUTING.md`, `config/electron-builder.config.cjs`, `.github/workflows/release-cut.yml` | Plugin sidebar panels реально существуют, но Git-specific hook не установлен. Выбран путь изменения ядра существующего Source Control с обычной сборкой; выпуск maintainer-managed, установленный bundle не патчится |

Потребители изменяемых контрактов: CLI, runtime RPC, host provider, отдельный Electron IPC, preload `window.api.git`, renderer local/remote clients, editor actions, Source Control и shared status/params. Изменение только renderer либо только `git.status` RPC оставит другой путь немигрированным.

### Существующее покрытие и фактический smoke

Найдены `src/cli/handlers/file.test.ts`, `file-absolute-paths.test.ts`, `src/main/runtime/rpc/methods/{files,git}.test.ts`, `runtime-git-target-execution-host.test.ts`, `runtime-git-execution-host-ownership.test.ts`, `src/main/ipc/filesystem-git-status-staging.test.ts`, `worktree-git-status-ref-watch.test.ts`, `worktree-base-directory-watcher.test.ts`; renderer — `editor-open-diff.test.ts`, `editor-branch-diff-snapshots.test.ts`, `workspace-session.test.ts`, `SourceControl.preview-open.test.tsx`. Наличие этих тестов не означает их запуск в этапе 0.

Реально выполнен `tests/e2e/golden-source-control-open-diff.spec.ts`: **1 passed**, настоящий собранный Electron, скрытое окно, настоящий Git и Monaco с проверкой original/modified текста. Дополнительный временный baseline-сценарий на двух размерах fixture: **2 passed**, после просмотра `git status --porcelain` содержит ровно ` M src/index.ts`; index/commit не изменены просмотрщиком. Временные config/spec удалены после измерения, постоянные тесты и application source не менялись.

Сборка `node config/scripts/run-electron-vite-build.mjs --mode e2e` с `VITE_EXPOSE_STORE=true` прошла; renderer boot graph: 175 chunks, 6057.4 KB minified. Smoke запускает output этой сборки через существующий `helpers/orca-app.ts`, не установленный app bundle. Fixture использует отдельные HOME/userData через `createElectronHomeIsolation`, `ORCA_BACKGROUND_LAUNCH=1` и `ORCA_E2E_HEADLESS=1`, проверяет `app.getPath('home')` и завершает свои процессы.

### Воспроизводимый baseline

Среда: darwin arm64, Node `24.22.1` через `npm exec --package=node@24.22.1`, pinned pnpm `12.14.0`, Electron `43.8.1`, указанный checkout. Два временных локальных репозитория/профиля; seed из `helpers/seeded-test-repo.ts` (6 tracked файлов), дополнительно 100 либо 10000 файлов `baseline/<n>.txt`, по одной строке `baseline file <n>`. После commit fixture меняется только `src/index.ts`: `world` → `golden daily loop`. Нет remotes, сабмодулей и фонового fetch. Это масштаб tracked file count, не нагрузка 10000 dirty-файлов или большой diff.

Порядок: `waitForSessionReady` → `openGoldenSourceControl` (включая automatic refresh) → пять последовательных реальных `window.api.git.status({worktreePath})` и `window.api.git.diff({worktreePath,filePath:'src/index.ts',staged:false})` с `performance.now()` в renderer → click строки `index.ts` → видимость Monaco и обоих текстов → `app.getAppMetrics()` → фактический Git status. Файловый кэш ОС не сбрасывался. IPC ниже **warm**, не cold-first; первый UI diff — первое открытие редактора в новом профиле, но данные предварительно прочитаны. Попытка перехватить первый automatic status в renderer не дала измерения (замена contextBridge API не сохранилась); `null` не превращён в число.

| Метрика | 100 дополнительных файлов | 10000 дополнительных файлов |
|---|---:|---:|
| Первый explicit warm status, ms | 85.9 | 232.6 |
| Warm status median, n=5, ms | 55.7 | 236.9 |
| Первый explicit diff IPC, ms | 37.9 | 27.9 |
| Diff IPC median, n=5, ms | 30.5 | 13.9 |
| Первое открытие Monaco до проверенного текста, ms | 944.0 | 883.5 |
| Renderer working set после diff, MiB | 419.8 | 415.2 |
| Сумма working set Browser/GPU/Utility/Tab, MiB | 772.5 | 798.0 |
| Fresh-process host `getStatus`, n=1, ms (отдельный сценарий) | 83.4 | 106.3 |
| Fresh-process host `getDiff`, n=1, ms (отдельный сценарий) | 23.1 | 26.3 |

Raw status samples, ms: ordinary `[85.9,54.9,52.0,55.7,59.7]`, large `[232.6,283.2,235.8,236.9,239.2]`; diff: ordinary `[37.9,29.1,30.5,25.4,38.5]`, large `[27.9,14.6,13.7,13.6,13.9]`. Working set — моментный OS показатель, не JS heap, не peak и не уникальная физическая память (сумма может учитывать shared pages несколько раз). Между прогонами память и latency заметно варьировались; статистических p95 из одного профиля нет.

Дополнительно выполнен first-call **host** probe: для каждого размера новый Node 24 процесс (`node --import tsx`), прямые импорты `getStatus` из `src/main/git/source-control/status-read.ts:41` и `getDiff` из `file-diff.ts:32`, новая временная Git fixture с 100/10000 однострочными файлами и `index.ts`, первый status и первый unstaged diff без IPC/UI/watchers/предварительного refresh. Оба вызова вернули реальное изменение, Git status остался ` M index.ts`. Это cold **application cache**, не cold disk и не cold Electron IPC; отсчёт начинается после загрузки модулей и создания fixture. При cleanup большой fixture возник `ENOTEMPTY` из-за background Git housekeeping; оставшийся собственный временный каталог удалён отдельно, данные измерения до cleanup получены успешно.

First-call host бюджеты для этой отдельной fixture: status ≤150 ms / ≤250 ms (ordinary/large), diff ≤75 ms. Эти пределы не сравниваются с IPC latency другой таблицы как с одним слоем.

Бюджеты для повторения **этого же** сценария: warm status median ≤100 ms / ≤500 ms (ordinary/large), diff IPC median ≤75 ms, первое отображение Monaco ≤1500 ms, renderer working set ≤600 MiB, сумма app working sets ≤1200 MiB. Это принятые регрессионные пределы с запасом, не гарантия для всех репозиториев/платформ. На этапе 0 новый popup отсутствовал, поэтому его baseline был **N/A**; первое измерение новой поверхности и отдельные бюджеты зафиксированы в STAGE2-REPORT.md, без сравнения с выдуманным pre-feature результатом.

### Dev-запуск и границы проверки

Официальная инструкция — `.github/CONTRIBUTING.md`: Node 24, pnpm, pinned Bun, `pnpm install`, `pnpm dev`. Скрипт `dev` собирает process-host, проверяет native runtime и запускает `config/scripts/run-electron-vite-dev.mjs`. Изоляция профиля поддержана `ORCA_DEV_USER_DATA_PATH`; проверки дополнительно изолируют HOME. Не использовать обычный `pnpm build:cli`/stock E2E global setup без проверки: `prepare:cli-output` вызывает `install-dev-cli.mjs`, который пытается создать `/usr/local/bin/orca-dev`; в этапе 0 он не запускался.

Исходная shell-среда имела Node `22.23.2`, pnpm `7.26.3`, без Bun. Установка выполнялась через `npm exec --yes --package=node@24.22.1 --package=pnpm@12.14.0 -- pnpm install --frozen-lockfile --store-dir .cache/stage0-pnpm-store`, с `ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0`, без изменения глобальных npm/pnpm настроек. Dependencies и process-host собраны, Electron загружен; полный postinstall не завершился: native rebuild patched `node-pty` получил `undici read ETIMEDOUT`. Ошибка SDK `fatal error: 'memory' file not found` у optional `cpu-features` устранена для retry через process-local `CPLUS_INCLUDE_PATH=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1`.

Повтор `rebuild-native-deps.mjs`, отдельный `electron-rebuild --version 43.8.1 --only node-pty --dist-url https://artifacts.electronjs.org/headers/dist --force`, затем bounded `curl --continue-at -` через оба официальных URL обрывались после примерно 24 KiB ответа. В `.electron-gyp` готовых headers не было; в `Library/Caches/node-gyp` только Node 18/22/24. Решение: 16 KiB HTTP Range-запросы к `https://artifacts.electronjs.org/headers/dist/v43.8.1/node-v43.8.1-headers.tar.gz`, каждый с `--http1.1 --connect-timeout 10 --max-time 20`; последовательная сборка диапазонов `0..347328` дала **347329 bytes**, SHA-256 **`f58c89ed15655b3abb9af6077df5534999d707cc1c9de4cd92b1c4ff20e57632`**, совпадающий с официальным `https://www.electronjs.org/headers/v43.8.1/SHASUMS256.txt`. Архив проверен до извлечения в `orca/.cache/node_headers`; кэш оставлен для следующих сессий.

С process-local `npm_package_config_node_gyp_nodedir=$PWD/.cache/node_headers`, `npm_config_nodedir=$PWD/.cache/node_headers` и указанным `CPLUS_INCLUDE_PATH` команда `node config/scripts/rebuild-native-deps.mjs` завершилась **exit 0**, затем `node config/scripts/ensure-native-runtime.mjs --runtime=electron` — **exit 0**. Native prerequisite устранён без патча исходников, отключения guard или изменения глобальной конфигурации.

Затем реально запущен dev watcher `node config/scripts/run-electron-vite-dev.mjs` (после уже выполненного process-host build и native guard; это runner из `pnpm dev`). Из корня checkout использованы следующие process-local переменные; каталоги созданные, Node 24 — тот же локальный binary из `npm exec`:

```sh
HOME="$PWD/.cache/stage0-dev-profile/home"
USERPROFILE="$HOME"
ORCA_E2E_USER_DATA_DIR="$PWD/.cache/stage0-dev-profile"
ORCA_E2E_HOME_DIR="$HOME"
ORCA_DEV_USER_DATA_PATH="$PWD/.cache/stage0-dev-profile"
ORCA_BACKGROUND_LAUNCH=1
ORCA_E2E_HEADLESS=1
ORCA_DISABLE_MACOS_LOGIN_SHELL=1
ORCA_SKIP_DEV_CLI_PREPARE=1
ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1
ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0
```

Это список значений для `env ... node config/scripts/run-electron-vite-dev.mjs`, не инструкция менять shell profile. Первый запуск без совпадающего HOME безопасно отказан preflight guard (`Refusing to start E2E outside its disposable home boundary`); после корректной HOME-изоляции — Vite `http://localhost:5173/`, DevTools `127.0.0.1:9354`. Через Playwright CDP наблюдались title **Orca**, UI **No workspaces found / Add a project to get started** и onboarding нового профиля: пользовательские production workspaces не загружены. Окно оставалось скрытым; собственный dev service остановлен после наблюдения.

Не подтверждены: интерактивный PTY, cold OS-cache latency, staged UI, remote host, новый popup и release-package smoke; они не выводятся из Git/diff smoke. Полная stock-команда `pnpm dev` не запускалась буквально: проверены её build/native prerequisites и настоящий dev runner без установки глобального CLI. Build output мог быть пересобран dev watcher; baseline относится к предыдущей `--mode e2e` сборке указанного revision.

### Реализованный контракт этапа 1

- Существующий `getStatus` получил opt-in `includeWorkspace`; `GitStatusResult.workspace` несёт `GitWorkspaceSnapshot`. Renderer передаёт только флаг, а execution-host identity добавляется после разрешения зарегистрированного worktree в IPC/runtime. Прежние status/CLI/diff ответы сохраняют форму.
- Реализация: `src/main/git/source-control/git-workspace-{context,discovery,error,status,watch-paths}.ts`; типы — `src/shared/git-workspace-types.ts`. `RepositoryState.entries` переиспользует `GitStatusEntry`, без параллельного ChangeEntry-парсера. `expectedState` — отпечаток HEAD/index/status для последующей сверки, не обещание атомарности и не разрешение мутации.
- Git runner прежний: argv без shell, NUL metadata, stderr отдельно от bounded stdout; `GIT_NO_LAZY_FETCH=1`, запрет протоколов и optional locks. Каталог не вызывает fetch/clone. HEAD/index перепроверяются в пределах прохода; расхождения дают incomplete.
- Authority ребёнка: HEAD/index gitlink, безопасный относительный путь без symlink-компонентов, канонический checkout внутри корня, git-dir/common git-dir внутри разрешённых metadata directories. `.gitmodules` сама по себе не выдаёт разрешения. Identity включает host, root, checkout, git-dir/common git-dir; одинаковые URL и общий object store не объединяют worktree.
- Полнота и ограничения явные: max depth 16, max contexts/rows 128, concurrency 4, metadata maxBuffer 8 MiB, timeout 15 s на команду. Неинициализированное дерево — unknown descendants, а не пустое дерево; ошибки изолируются по контекстам.
- UI: `source-control/panel/workspace-catalog.tsx`, вход Changes/Submodules в `panel-ready.tsx`; loading/error/incomplete/Refresh, root и все обнаруженные строки, независимые dirty/new HEAD/staged gitlink/conflict, OID и URL без credentials, read-only Changes выбранного контекста. Старый lazy expansion также проверяет каталог перед чтением ребёнка.
- Инвалидация: существующие filesystem/runtime subscriptions и git-common watcher получают авторизованные metadata paths, coalescing 300 ms, focus/visibility refresh, visible-only reconciliation 15 s. Исправлена потеря событий из-за `null` vs absent connectionId; сравниваются также выданные host canonical roots.
- Проверки: 138 tests в 8 файлах, node/web tsc, targeted lint — pass; настоящий hidden Electron — 2 passed, включая прежний Monaco diff. Smoke использовал только disposable fixtures/HOME/userData и process-owned harness shutdown. Не проверены настоящий remote/WSL/Windows host и release package; этап 2 не запускался.

### Реализованный контракт этапа 2

- `SourceControlWorkspacePopup` открывается из текущей branch/detached identity в Source Control и по `Ctrl+Alt+G`; keyboard routing открывает нужную activity view. Popup и Submodules получают одну модель `useWorkspaceCatalog`, общий snapshot и выбранный context ID.
- Левая часть показывает Root и все известные строки, в том числе clean, detached, conflicted и uninitialized; полные относительные пути различают одинаковые имена. Цвет детерминирован по identity из существующих graph tokens. Есть Tree/Flat, collapse/expand и поиск имени/пути.
- Правая часть всегда подписана выбранным контекстом. `workspaceRefsContextId` — опциональный selector существующего `git.status`/IPC/preload/provider/RPC, не cwd и не authority. Host читает refs только совпавшего контекста из уже авторизованного discovery. `RepositoryState.refs/refsError` содержат локальные heads/remotes/tags либо явную ошибку.
- Чтение refs — один bounded `for-each-ref` для выбранного контекста: не больше 10000 строк, прежние 8 MiB/15 s и offline runner. Нет fetch/clone, shell, второго backend или subprocess на hover. Изменение selection может перечитать общий snapshot; popup shell не ждёт refs.
- Recent означает **просмотренные refs**, не checkout. Ref name/OID/upstream доступны для инспекции; favorites, recent, ref query и inspected ref сохраняются отдельно по host-issued context identity в изолированном renderer profile. Ключ компонента меняется вместе с контекстом, поздние snapshot-ответы отменяются/игнорируются; ветки соседа не показываются во время загрузки.
- Enter/Right входят из repository results в refs, Up/Down двигают focus, Left возвращает к поиску репозиториев, Tab достигает остальных native controls, Escape закрывает popup. Используются существующие Radix dialog focus/IME/dismiss conventions; focus refs переносится после mount нового keyed subtree, при закрытии возвращается к вызывающему элементу, если он ещё существует.
- Open Changes выбирает ровно этот контекст в существующем Submodules/Context changes списке. Это настоящий read-only список файлов выбранного checkout, не имитация root Changes и не новый diff этапа 3.
- Uninitialized/blocked/error строки остаются видимы; причины unavailable refs и неизвестные потомки указаны. Initialize, Log, checkout, создание веток и прочие будущие мутации не представлены фиктивными командами.
- При внешнем deinit во время discovery проверяется наличие `.git` и повторно сверяется context identity перед использованием metadata. Недействительный контекст удаляется из опубликованных repository states, вместо подстановки branch/status родителя; обычные metadata-limit ошибки сохраняют доступный частичный status.
- Проверка и новый popup baseline/budget описаны в STAGE2-REPORT.md. Этап 3 не запускался; настоящий remote/WSL/Windows host этим локальным smoke не подтверждается.


### Реализованный контракт этапа 3

- `GitDiffSelection` задаёт левую/правую стороны HEAD/index/worktree/commit/empty, `oldPath` для rename и host-issued `contextId`. `getDiff` и commit/branch comparisons используют один bounded reader `git-diff-document-read.ts` и существующий Git runner; статус выбранного ребёнка разрешается и повторно проверяется на execution host через тот же workspace discovery, а не по пути из renderer.
- Shared `GitDiffDocument` возвращает метаданные сторон (путь, mode/OID, размер, переносы строк, завершающий newline), поколение/stale и специальные виды binary/large/encoding/symlink/gitlink/mode/conflict. Read content ограничен 8 MiB, не следует symlink, не выполняет promisor lazy-fetch; absent HEAD/side имеет явный смысл. Gitlink OID принадлежит своему repository, доступный дочерний context открывается из вкладки.
- `SourceControlWorkspaceChanges` — общая root/child Changes поверхность с четырьмя группами, tree/list, фильтром и навигацией. Состояние выбора/scroll и режим side-by-side/unified привязаны к context ID; Monaco сохраняет word highlight, context folding и hunk navigation. При смене snapshot открытые read-only Git diff tabs перезагружаются; результат старого запроса не заменяет вкладку.
- IPC/preload, runtime RPC/provider и editor open actions передают один и тот же optional selection; прежние CLI `file diff`/`open-changed` не требуют нового аргумента. Root mutation controls не показываются при просмотре child Changes; частичный stage, child commit/discard и Log пока не реализованы.
- Локальные реальные Git regressions и изолированный Electron smoke задокументированы в STAGE3-REPORT.md. Настоящий remote/WSL/Windows execution host и release bundle там не объявлены проверенными.

### Реализованный контракт этапа 4

- Один host-entry point: `mutateGitWorkspace` за `git.mutate` (runtime RPC) и `git:mutate` (Electron IPC), preload `window.api.git.mutate` и renderer `mutateRuntimeGitWorkspace`. Запрос несёт host-issued `contextId`, `expectedState`, путь и для partial — `documentId` + `hunkIds`/`lineIds`; произвольный patch и path-as-authority не принимаются. `git.stage`/`git.unstage`/`git.commit` и bulk-маршруты сохранены для CLI/старых клиентов и делят те же примитивы.
- Host хранит bounded registry выданных diff-строк (128) и строит patch по выбранным идентификаторам. Чистые addition/delete-блоки поддержаны по строкам; замена и блок с отсутствующим final newline перемещаются вместе. Rename, binary, >8 MiB, non-UTF-8, symlink, mode-only и unmerged частично не поддерживаются (`partialUnavailable`), файловые операции остаются. Rename stage/unstage действует на оба пути.
- Freshness: перед записью повторно выполняется авторизованный discovery, проверяется `expectedState` (HEAD/index records/status) и content fence (HEAD, index-записи пути, байты worktree; >16 MiB — filesystem identity). Несовпадение — `stale` без записи. Это обнаружение конфликтов, не транзакция против внешних писателей.
- Очередь: `withGitMutationQueue` сериализует все Orca-записи по ключу process + common git-dir; linked worktrees одного репозитория ждут друг друга, acquisition order детерминирован. Существующие `stageFile`/`unstageFile`/bulk/`discardChanges`/`commitChanges` обёрнуты той же очередью.
- Commit: preview реального staged-набора (unborn/detached/branch, отказ при усечённом listing), `git commit -m` без `--no-verify` и без отключения signing. Hook/signing failure возвращает текст Git и свежий state; hook-изменения не скрываются. Abort/kill после старта — `outcome: 'unknown'`, без автоматического retry. Дочерние контексты имеют commit panel и draft по context ID.
- Discard: только unstaged tracked regular files; host preview token, подтверждение, копия+manifest в `<gitDir>/orca-recovery` до перезаписи, отказ при невозможности копии. Новый путь не удаляет untracked. `restoreDiscard` пишет копию только при совпадении post-discard fence; `listRecoveries` — bounded список по контексту.
- Gitlink: `stageGitlink` проверяет полный child OID, child HEAD, child context и parent index, пишет `update-index --add --cacheinfo 160000,<oid>,<path>` и перечитывает запись; child index/HEAD/файлы не меняются, parent commit не коммитит child.
- UI: тот же `SourceControlWorkspaceChanges` показывает Stage/Unstage/Discard/Stage gitlink для выбранного контекста, commit panel/preview/draft для дочерних контекстов, recovery list/restore и discard confirmation; diff surface получает панель выбора строк/hunks с host-issued ID. Ручные bulk/PR-сценарии продолжают использовать совместимые маршруты, но через ту же очередь.
- Пределы: проверен только локальный macOS Electron; root commit (существующая commit surface) идёт по прежнему per-worktree контракту без `expectedState`, дочерний — по полностью проверенному. Recovery-копии не GC-ятся; freshness >16 MiB не хэширует все байты; remote/WSL/Windows и release package не проверялись. Доказательства — STAGE4-REPORT.md.

### Реализованный контракт этапа 5

- Один reader: существующий `loadGitHistoryFromExecutor` (shared) и `git.history`/`getHistory`; второй history backend не добавлялся. `GitHistoryOptions` получил `contextId`, `revision`, `cursor {tipOid, offset}`, `path`, `message`; `GitHistoryResult` — `generation`, `tipOid`, `browsedRef`, `empty`, `nextCursor`. Валидация вынесена в `git-history-options.ts`, разрешение ref/OID — в `git-history-refs.ts`; файл loader остаётся под 300-line gate.
- Фиксация и страницы: первая страница разрешает ревизию (HEAD, ветка, тег, полный OID) в commit OID; продолжение использует этот OID и `--skip=<offset>` (не более 5000), `-n limit+1`. `generation` — токен над contextId/tip/фильтрами; страница другого generation/tip не добавляется, а renderer перечитывает первую страницу. Поздний ответ отбрасывается по sequence guard. Изменение HEAD/refs в snapshot меняет `signature` и перезапускает историю; `Recent`/`baseRef`/incoming-outgoing boundary rows остаются только для HEAD без фильтров.
- Фильтры: `revision` (ref name или полный OID), `path` (repository-relative, `:(literal)` pathspec) и `message` (`--fixed-strings --regexp-ignore-case --grep`). Чтение офлайн: `gitReadOptionsForWorktree` + `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=''`, без external diff и без shell; 8 MiB stdout/15 s. Ошибка `bad object`/`Could not read` классифицируется как `unavailable` с текстом «not available locally; no fetch was attempted»; `invalid-input`/`limit`/`git-error` отделены.
- UI: `SourceControlWorkspaceLog` — третья view рядом с Changes/Submodules, плюс Open Log из popup, из заголовка Changes и `Open child Log` в gitlink diff. `useWorkspaceLog` владеет страницами/фильтрами/статусом, `workspace-log-model` — чистый merge страниц (generation/tip/dedupe), `workspace-log-list` виртуализирует строки фиксированной высоты с keyboard selection, общий `buildGitHistoryViewModels`/`GitHistoryRow`/`GitHistoryGraphSvg` рисуют lanes; appended pages пересобирают graph по загруженному списку.
- Merge и ревизии: детали показывают `parentIds`; каждый родитель — кнопка с `aria-pressed`, по умолчанию первый, отдельно `Empty tree` для root commit. «Use as compare base» фиксирует произвольную базу. Список файлов — `getWorkspaceCommitCompare` → существующий `getCommitCompare` с `baseOid`; `git.commitCompare` расширен `contextId`/`baseOid` (IPC/RPC/preload/web), невалидная база даёт `invalid-base` с явной ошибкой. Файл открывается существующей commit-diff вкладкой: `openCommitDiff` теперь принимает `gitDiffSelection` (стороны commit/empty + contextId), а loader предпочитает выданную selection маршруту commitDiff, поэтому child diff читается через уже авторизованный `git.diff`.
- Авторизация: `readAuthorizedGitContext` выполняет свежий `getStatus(includeWorkspace)` и `verifyWorkspaceContext`; `getWorkspaceHistory`/`getWorkspaceCommitCompare` выбирают checkout по host-issued `contextId`. Контекст другого worktree или неизвестный id отклоняются; история ребёнка не отвечается родителем; `root` без `contextId` сохраняет legacy-путь.
- Пределы: 50 строк на страницу (max 200), 5000 загруженных (offset cap), virtualization фиксированной высоты, combined «open all» только для root. Проверен локальный macOS Electron; remote/WSL/Windows и release package не проверялись. Доказательства — STAGE5-REPORT.md.

### Реализованный контракт этапа 6

- Один вход для записей: `mutateGitWorkspace` получил действия `checkout`, `createBranch`, `fetch`, `push`, `merge`, `rebase`, `continueOperation`, `abortOperation`. Они идут через те же `git.mutate`/`git:mutate`, preload, web client, `getStatus(includeWorkspace)`, context authorization и `withGitMutationQueue` по common git-dir. Второй backend, обход очереди или path-as-authority не добавлялись.
- Проверки перед записью: действия с изменением checkout требуют `expectedHead` (host-issued snapshot HEAD, `''` для unborn) и сверяют его после повторного discovery; `push` требует `expectedRefOid` и сверяет OID выбранной локальной ветки. `fetch` не пишет worktree/index и не требует state fence. `expectedState` остаётся контрактом stage 4 для stage/commit/discard. Stale HEAD/OID отклоняется без записи.
- Checkout отделён от просмотра: local branch проверяется по свежим refs и переключается коротким именем (полный `refs/heads/...` как checkout-цель отсоединил бы HEAD); remote branch создаёт локальную ветку с `--track`; тег или полный OID даёт detached HEAD. Отказ: текущая ветка, unfinished operation/conflict, ветка в другом живом worktree (`worktree list --porcelain -z`, реальный путь в сообщении), пересечение dirty entries с `diff --name-only HEAD <target>` (прочие локальные изменения сохраняются). Автоматического stash, `reset --hard`, `clean` или force нет. New Branch проверяет имя через `check-ref-format`, создаёт и переключает явно; старт с remote ref ставит tracking.
- Refs и актуальность: `GitWorkspaceRef` несёт full name/OID/upstream/ahead/behind/upstreamGone. Ahead/behind читаются только из локального `%(upstream:track)` загруженных refs; сеть не вызывается. `RepositoryState` получил `refsReadAt`, `lastFetchAt` (mtime этого checkout's `FETCH_HEAD`) и имена remotes без URL. Сообщение UI прямо говорит, что это remote-tracking данные на момент чтения и Orca не делает fetch автоматически.
- Fetch/push: remote обязан быть в свежем `git remote` (URL не принимается), можно указать одну ветку. Аргументы: `fetch --progress --prune --no-recurse-submodules <remote> [<branch>]`; `push --progress --no-recurse-submodules [--set-upstream] <remote> <local-ref>:<same-ref>`. Сеть использует существующий execution-host Git runner (SSH policy/credential helpers, `GIT_TERMINAL_PROMPT=0`), 300 s timeout; прогресс — только разобранные проценты, без stderr/URL/секретов. Различаются `rejected` (non-fast-forward/remote has newer), `authentication`, `network` (известный отказ соединения) и `unknown-outcome` (таймаут/обрыв/убитый процесс): unknown не повторяется, а UI перечитывает состояние. Force-push не предусмотрен.
- Прогресс: streaming RPC `git.mutationProgress` с клиентским `progressId`; host публикует bounded кадры (`phase`, `percent`, `done`) из `createGitProgressRecordReader`, подписка закрывается по `done`/unsubscribe. IPC, remote runtime, web client и renderer используют один маршрут; при недоступности подписки сама операция не блокируется.
- Merge/rebase: требуют чистый index/worktree и отсутствие незавершённой операции; вызываются явно как `merge --no-edit <ref>` и `rebase <ref>` по разрешённому локально коммиту. Конфликт/остановка возвращает `conflict` и свежее состояние, но не success; `RepositoryState.operationInProgress` вычисляется по `MERGE_HEAD`/`rebase-merge`/`rebase-apply`/`CHERRY_PICK_HEAD`, а не по `conflictOperation === 'unknown'`. Continue/abort выбираются по фактическим маркерам: `-c core.editor=true merge|rebase --continue` и `merge|rebase --abort`; после команды маркеры перечитываются, поэтому success не заявляется до завершения. Cherry-pick явно относится к следующему этапу.
- UI: popup получил New Branch, Checkout, Merge/Rebase для выбранного ref, Fetch/Push с явными remote/ref, индикатор прогресса, upstream/ahead/behind, время чтения refs/последнего fetch, состояние незавершённой операции с Continue/Abort и notice. Все действия — native buttons/selects с `data-navigation-item`; ArrowDown из поиска ведёт к первой ref, стрелки/Tab достигают действий, Enter выполняет выбранное. Left/right выбор контекста и ref по-прежнему только просмотр. Changes показывает незавершённую операцию и число конфликтов, а сами continue/abort доступны в popup. Черновики остаются по context ID и не сбрасываются checkout.
- Пределы этапа: проверен локальный macOS Electron с настоящими локальными bare remotes; SSH/WSL/Windows execution hosts и release package не запускались. Теги можно checkout, но не создавать; push только локальных веток; cherry-pick и полноценный resolver — этап 8. Fetch/push не рекурсируют в сабмодули (`--no-recurse-submodules`), это осознанная граница выбранного контекста. Доказательства — STAGE6-REPORT.md.

## Основные решения

1. Git — установленный бинарник на execution host соответствующего worktree.
2. Git-операции выполняются в существующем host runtime, не в UI и не через команды, напечатанные в терминал агента.
3. Используются существующие транспорт, авторизация, редактор и diff-поверхность Orca, если они подходят по контракту.
4. Реальный Git index — единственный источник состава будущего коммита. Никакого скрытого staging area и незаметного `add --all`.
5. Новая панель и существующие вкладки diff используют один backend и одну модель изменений.
6. Локальные операции работают офлайн. Сетевые операции используют существующие SSH/credential-механизмы хоста, без облачного посредника.
7. Сабмодули — полноценные Git-контексты с собственными index, HEAD и историей. Обзор всего дерева доступен из корневого worktree; родитель хранит только ссылку gitlink, а не содержимое дочернего репозитория.

## Пользовательская поверхность

Git Workspace привязан к активному worktree и выбранному Git-контексту внутри него: корню либо сабмодулю любой вложенности. Выбранный файл, положение просмотра и черновик сообщения сохраняются отдельно для каждого контекста. Для работы с сабмодулем не требуется вручную регистрировать его как отдельный проект Orca.

Разделы:

- **Changes**: группы Unstaged, Staged, Untracked и Conflicts; фильтрация, дерево/список файлов, diff и поле коммита.
- **Log**: виртуализированная история, граф родителей, фильтры, ветки и теги, файлы выбранного коммита.
- **Branches**: локальные/удалённые ветки, переключение, fetch, push и явно выбранный способ интеграции изменений.
- **Merge**: base/ours/theirs и редактируемый result; явное подтверждение разрешения конфликта.
- **Submodules**: полный список известных сабмодулей, дерево вложенности и плоский поиск по имени/пути; переход в Changes/Log/Branches/Merge выбранного сабмодуля без потери корневого контекста.

Diff поддерживает side-by-side и unified, подсветку строк и слов, сворачивание неизменённых областей, переход к следующему файлу/изменению. Бинарные и слишком большие файлы получают явное специальное представление, а не зависающий текстовый редактор.

Выбор для коммита имеет конкретную семантику: действие Stage переносит файл, hunk или выбранные строки в index; Commit сохраняет показанный staged-набор. Галочка не должна одновременно означать выделение строки UI и неявное изменение index.

### Быстрый переключатель репозиториев и веток

UX-референс — предоставленный пользователем скриншот JetBrains: единый popup со списком репозиториев слева и меню веток/действий выбранного репозитория справа. Это основной быстрый вход, а не необходимость каждый раз открывать отдельную страницу Submodules.

- Открывается из индикатора ветки в панели Orca и с клавиатуры.
- В списке явно присутствуют корневой репозиторий и все обнаруженные сабмодули. Плоский режим показывает всех известных потомков; путь и breadcrumbs различают одинаковые имена. Дерево вложенности доступно как альтернативный вид.
- Строка показывает имя/путь, стабильный цвет контекста, текущую ветку либо короткий OID с явной меткой detached HEAD, dirty/conflict и состояние инициализации. Полный OID доступен в подробностях/копировании, а не вытесняет имя.
- Поиск находит репозитории по имени/пути, ветки и доступные действия. Результаты веток помечены контекстом; одинаковые названия в разных репозиториях не сливаются.
- Выбор строки открывает справа меню именно этого контекста: New Branch, Checkout Tag/Revision, Recent, Local Branches, Remote Branches и Tags; отдельно доступны Open Changes, Open Log и submodule-действия.
- Ветка показывает upstream, если он задан; избранные и недавние ветки сохраняются отдельно по контекстам. Выбранный контекст всегда указан в заголовке правого меню.
- Навигация работает без мыши: поиск, вверх/вниз по результатам, переход в меню и назад, явное выполнение через Enter. Один hover/выделение ничего не переключает в Git.
- Выбор Git-контекста для просмотра и checkout ветки — разные команды. Checkout затрагивает только указанный репозиторий; одинаковая ветка у соседних сабмодулей не переключается автоматически.
- Для неинициализированной записи показывается доступный путь и действие Initialize вместо фиктивного меню веток. Необнаруженные потомки и ошибки видимы, clean-репозитории из списка не исчезают.

Переключатель и панель Submodules используют один каталог Git-контекстов и общий кэш refs/status. Изменение ветки внутри сабмодуля обновляет его строку и gitlink-состояние родителя, но не выполняет stage/commit родителя.


### Сабмодули: обзор и действия

Для каждой строки показываются путь, родитель, URL источника без credential-секретов, состояние инициализации/доступности, ветка либо detached HEAD, текущий commit, gitlink родителя в HEAD и index, изменения внутри сабмодуля и конфликты. Состояния независимы: сабмодуль может одновременно иметь другой commit и незакоммиченные файлы. Ahead/behind показываются только относительно известного upstream и загруженных refs; без fetch это не утверждение о текущем состоянии сервера.

Пользователь может:

- открыть diff, историю, ветки и конфликты сабмодуля; stage/unstage и commit работают только с его index;
- инициализировать выбранные сабмодули, включая вложенные по явному выбору;
- привести checkout к commit, записанному в index родителя, с preview целевого OID и предупреждением о detached HEAD;
- отдельно обновить выбранную ветку сабмодуля до явно выбранной remote-ревизии; это не то же действие, что восстановить записанный родителем commit;
- подготовить в родителе изменение gitlink на текущий commit сабмодуля и просмотреть сравнение старой/новой ревизий;
- fetch/push и переключать ветки в выбранном сабмодуле; создавать ветку перед разработкой из detached HEAD;
- добавить сабмодуль, синхронизировать URL по preview различий и удалить сабмодуль с отдельным подтверждением и защитой локальных данных;
- выполнить поддерживаемое действие над выбранными сабмодулями с явной областью рекурсии, preview и результатом по каждому репозиторию.

Обнаружение объединяет `.gitmodules` в рабочем дереве, index/HEAD, gitlink entries и локальную конфигурацию. Несоответствия и конфликты отображаются, а не скрываются. Нельзя использовать только обход инициализированных checkout: так пропадут неинициализированные сабмодули.

Вложенные сабмодули перечисляются по доступным деревьям и объектам. Если содержимое неинициализированного дочернего репозитория отсутствует локально, его потомки помечаются как «ещё не обнаружены», а не как пустой список. Для полного раскрытия предлагается явная загрузка необходимых данных; просмотр сам по себе не запускает clone/fetch.

Ключевой workflow: commit внутри дочернего репозитория → явный stage его gitlink в родителе → commit родителя. Для нескольких уровней порядок идёт от листьев к корню. Публикация дочерних commit предшествует публикации ссылающихся на них родителей; доступность нужного OID проверяется для выбранного remote назначения, а не предполагается по наличию любого remote.

Commit родителя не коммитит и не публикует файлы внутри сабмодуля. Общее действие над деревом — последовательность независимых операций с частичными результатами, не атомарная транзакция. При сбое пользователь видит завершённые и неисполненные шаги; скрытого отката уже опубликованных commit нет.


## Компоненты

### 1. Git Workspace UI

Отвечает за навигацию, команды пользователя, отображение состояния и подтверждения опасных действий. Не строит shell-команды и не разбирает stdout Git.

Diff view — адаптер к существующему редактору/просмотрщику Orca. Новый движок выбирается только после проверки возможностей текущего.

### 2. Git client state

Хранит загруженный snapshot, состояние запросов, выбранные ревизии, фильтры и черновики. Не дублирует index или историю Git.

Ответ для старого worktree или старого поколения запроса не заменяет актуальный экран. Устаревший diff помечается до повторного применения действий.

### 3. Git service в host runtime

Разрешает workspace identity в доверенный путь, проверяет доступ, исполняет операции, формирует типизированные ответы, координирует записи и инвалидирует состояние.

Удалённый репозиторий обслуживается на удалённом host. На клиент не копируется весь checkout; передаются нужные метаданные и содержимое открытых файлов.

### 4. Git process adapter

Единая точка запуска Git: массив аргументов без shell, правильный cwd, stdin, раздельные stdout/stderr, лимиты вывода и управление процессом.

Использует машинные форматы, в том числе porcelain и NUL-разделители для путей. Не разбирает локализованные сообщения для определения статуса файла. Отключает внешние diff/textconv-команды для машинного чтения.

Hooks и signing при commit не отключаются. Они могут менять состояние и требуют повторного чтения результата операции.

### 5. Инвалидация и обновление

Переиспользует файловые события Orca; добавляет наблюдение за реальными per-worktree git-dir и common git-dir, а не предполагает, что `.git` всегда каталог.

События объединяются; после мутации, возвращения фокуса и ручного Refresh состояние перечитывается. Watcher — сигнал перечитать данные, не источник истины. Переполнение watcher и ограничения удалённого host компенсируются сверкой при обращении/обновлении.

## Идентичность и данные

Минимальные сущности:

- `WorkspaceRef`: execution host и существующая identity worktree; клиент не передаёт произвольный cwd для выполнения команд.
- `GitContextRef`: `WorkspaceRef` и выданная host identity корневого/дочернего checkout. Host проверяет принадлежность к обнаруженному дереву; путь из `.gitmodules` не является разрешением читать или изменять произвольный каталог.
- `SubmoduleEntry`: identity родителя, имя и путь, declared/effective URL, доступность checkout/метаданных, HEAD/index gitlink OID родителя, текущий OID сабмодуля, ветка, dirty/conflict flags и полнота обнаружения потомков. Одинаковый URL в двух путях не объединяет контексты.
- `RepositoryState`: HEAD или unborn HEAD, ветка или detached HEAD, состояние merge/rebase/cherry-pick, staged/unstaged/untracked/conflicted entries.
- `ChangeEntry`: исходный и новый путь, вид изменения, index/worktree статусы, режим файла, признак бинарного/специального содержимого.
- `DiffSpec`: явные левая и правая стороны — HEAD, index, worktree либо commit OID; при rename учитываются оба пути.
- `DiffDocument`: идентификатор, стороны, hunks, отображаемое содержимое и токены исходного состояния.
- `OperationResult`: завершение, отмена либо неизвестный исход; структурированная причина ошибки и безопасные диагностические сведения.

Пути передаются с сохранением идентичности. Отображаемое имя не используется как файловый идентификатор; нужна явная политика для имён, не представимых обычной UTF-8 строкой.

Состояние перечитывается согласованными проходами с проверкой изменений. Нельзя обещать атомарный snapshot всех файлов checkout: внешний процесс может писать в любой момент.

## Контракты

Проектные операции; итоговые имена должны следовать соглашениям Orca:

- `getStatus(workspace)`
- `getDiff(workspace, diffSpec)`
- `stagePaths / unstagePaths(workspace, entries, expectedState)`
- `applySelection(workspace, diffId, hunkOrLineIds, direction, expectedState)`
- `commit(workspace, message, expectedHead, expectedIndex)`
- `getLog(workspace, revisionQuery, cursor)`
- `getCommitChanges(workspace, commitOid, parentOid)`
- `listRefs / fetch / push / switchBranch`
- `getConflict / saveConflictResult / markResolved`
- события `workspaceInvalidated` и `operationProgress`, если существующий транспорт поддерживает подписки.
- `listSubmodules(workspace, discoveryScope)` — дерево и плоский список, независимые статусы и явная полнота обхода.
- `initSubmodules / checkoutRecordedCommit / updateToRevision / syncSubmoduleUrls` — выбранные контексты, ожидаемые состояния и явная область рекурсии.
- `stageGitlink(parentContext, childContext, expectedChildOid, expectedParentIndex)` — записывает ссылку, не stage файлов дочернего репозитория.
- `addSubmodule / removeSubmodule` — preview плана, URL/путь, ожидаемые состояния и подтверждение затрагиваемых локальных данных.

Операции status/diff/log/stage/commit/branches/remotes принимают `GitContextRef`, а не только корневой workspace. У неинициализированного сабмодуля недоступные операции отключены с причиной; это не ошибка всего обзора.

Patch строится на host по выданному diff и выбранным идентификаторам. UI не присылает произвольный patch для применения.

История фиксируется на разрешённых OID и выдаётся порциями. Изменение refs приводит к обновлению запроса, а не смешению страниц разных состояний истории. У merge-коммита явно выбирается родитель сравнения.

## Безопасность изменений и конкурентность

- Записи самого Orca координируются по common git-dir: простой консервативный вариант — одна очередь мутаций на репозиторий, включая связанные worktree.
- Очередь не блокирует внешние CLI, IDE и агентов. Используются Git locks и проверка ожидаемых HEAD/index/содержимого; это обнаружение конфликтов, не глобальная транзакция checkout.
- Перед частичным stage/unstage проверяются стороны исходного diff. При несовпадении операция прекращается, diff обновляется. Нельзя автоматически применять прежний выбор к похожему фрагменту нового файла.
- Перед commit проверяется показанный пользователю index и HEAD. Известные изменения требуют повторного подтверждения; hooks и внешние процессы исключают обещание абсолютной изоляции.
- Отмена/потеря соединения не равна откату. Для неизвестного результата сначала проверяется состояние; commit/push не повторяются автоматически.
- Discard имеет отдельный preview и подтверждение. Для обычных файлов предусматривается восстанавливаемая копия до перезаписи/удаления; если её сохранить нельзя, destructive action не выполняется. Это не называется универсальным Undo для Git-операций.
- Untracked не удаляются при обычном discard tracked-файлов. Автоматического stash, reset --hard, clean или force-push нет.
- Переключение ветки с препятствующими изменениями возвращает понятную ошибку; Orca не прячет изменения автоматически.
- `ours` и `theirs` объясняются относительно текущей операции, особенно rebase. Конфликт не считается разрешённым только потому, что исчезли текстовые маркеры.
- Сабмодуль и родитель имеют разные Git locks и очереди. Межрепозиторные шаги не держат несколько очередей одновременно; перед каждым шагом повторно проверяются зависимости и ожидаемые OID.
- Обновление/удаление сабмодуля не использует force и не затирает dirty/untracked данные. Конфликт gitlink решается выбором/созданием дочернего commit с последующей явной записью ссылки в index родителя.
- Рекурсия и обход недоверенных путей контролируются host: проверяются канонические пути, symlink-переходы, посещённые контексты и пределы обхода. Выход за область доступа запрещён, неполный обход явно обозначается.
- Clone/fetch/init по URL из репозитория требуют явного действия; URL и изменения effective URL показываются до сети. Не разрешаются произвольные shell update-команды и небезопасные transport helpers из метаданных проекта.

Ошибки различаются: stale state, repository busy, conflict, authentication required, hook/signing failure, unsupported representation, unknown outcome. В диагностике не раскрываются credential-секреты.

## Производительность и хранение

- Сначала загружается список статусов; содержимое diff — только для открытого файла.
- История и длинные списки виртуализируются, log читается порциями.
- Кэш ограничен по памяти; неизменяемые commit/blob-данные ключуются OID. Worktree/index-кэш инвалидируется отдельно.
- Не запускается Git-процесс на каждую видимую строку или hover.
- Сохраняются только UI-настройки, черновики и ограниченные recovery-копии; собственного индекса всей истории и копии репозитория нет.
- Численные бюджеты задержки и памяти фиксируются после измерения текущего diff Orca на одинаковых репозиториях; заранее не обещаются неподтверждённые цифры.
- Статусы сабмодулей загружаются с ограниченной параллельностью и кэшируются по контекстам. Ошибка одного сабмодуля не блокирует список остальных. Обновление дочернего HEAD инвалидирует также строки gitlink у его родителей.

## Этапы реализации и критерии приёмки

### 0. Карта существующей интеграции

Найти текущие status/diff/process/IPC/editor/watchers и покрытие. Проверить доступность исходников и путь поставки изменения. Зафиксировать точки расширения и baseline запуска/памяти/задержек.

Приёмка: известны конкретные файлы и контракты; новое решение не дублирует backend существующего `file diff`.

### 1. Read-only Changes и diff

Status, группы файлов, staged/unstaged diff, side-by-side/unified, навигация и обновление при внешних изменениях.
В тот же этап входит Submodules: корневой список, вложенность, неинициализированные записи, переход в read-only контекст и отдельное отображение dirty-состояния и смены gitlink. Сабмодули — часть базовой архитектуры, не отложенный плагин.
В read-only части также реализуется быстрый popup репозиториев с текущими ветками/OID, поиском и переходом в Changes/Log. В этапе 3 его меню дополняется созданием/переключением веток, refs и действиями обслуживания сабмодулей.

Приёмка: корректные результаты для modified/added/deleted/renamed/untracked, файла с staged и unstaged изменениями одновременно, binary, CRLF, Unicode и необычных имён; переключение двух worktree не смешивает данные.

### 2. Подготовка и создание коммитов

Stage/unstage файлов, hunks и строк; preview index; сообщение и commit; безопасный discard.

Приёмка: коммит содержит ровно подготовленные изменения, остальные сохраняются. Проверяются изменения после открытия diff, hooks/signing failure, unborn HEAD, отмена и неизвестный исход операции. Ошибка частичного применения ничего не должна молча переносить в index.
Для сабмодулей: частичный commit внутри дочернего checkout не меняет index родителя; stage gitlink не коммитит дочерние файлы. Проверяются dirty-сабмодуль с новым HEAD, detached HEAD и цепочка вложенных сабмодулей.

### 3. История, ветки и remotes

Граф, фильтры, сравнение ревизий, branch switch, fetch/push и явные merge/rebase-сценарии вместо неявного выбора политики Pull.

Приёмка: корректные страницы log, merge-коммиты, detached HEAD, несколько worktree, локальный bare remote, отказ push и ошибка авторизации. Незакоммиченные изменения не теряются при неудачном switch.
Для сабмодулей добавляются init, checkout recorded commit, update to revision, sync URL, add/remove и пакетные действия с явной рекурсией. Приёмка включает неинициализированные и вложенные сабмодули, рассогласованные `.gitmodules`/gitlink, относительные URL, недоступный remote/OID, безопасный отказ при dirty checkout, две рабочие копии родителя и частичный сбой пакетного действия. Невозможность полностью раскрыть дерево без загрузки показывается явно.
Приёмка переключателя: работа с клавиатуры; одинаковые имена/ветки у разных сабмодулей; видимые clean, detached и uninitialized записи; поиск вложенных путей; checkout только в выбранном контексте; обновление строки после внешнего checkout и сохранение несвязанных UI-черновиков.

### 4. Разрешение конфликтов

Трёхстороннее сравнение с result, mark resolved, continue/abort для соответствующей Git-операции. Modify/delete, add/add, rename и binary показываются как отдельные случаи, а не как обычный текстовый конфликт.

Приёмка: полный конфликтный merge и rebase завершаются через UI; abort соответствует Git-семантике; результат не затирает изменения, внесённые после открытия resolver.
Для сабмодулей проверяется конфликт gitlink: просмотр обеих дочерних ревизий, выбор/создание результирующего commit и запись ссылки в родительский index без потери дочерних изменений.

### 5. Changelists и shelve как отдельное расширение

Если эти сценарии нужны для повседневной работы, добавить именованные группы независимо от index и явную модель хранения shelved changes. Не имитировать changelists через скрытый stash. Пересечение групп, rename и stale hunks требуют отдельного дизайна до реализации.

## Проверка реализации

Для парсеров и преобразования выбранных строк в patch — детерминированные тесты границ. Для поведения — интеграционные сценарии с настоящим Git во временных репозиториях, включая связанные worktree и локальный remote.
Обязателен сценарий корень → сабмодуль → вложенный сабмодуль с реальными локальными remote: обзор до init, раскрытие после init, правка и commit снизу вверх, публикация зависимостей, затем проверка checkout в чистом clone. Отдельно проверяются отсутствие незаметной сети при обзоре и запрет выхода путей за разрешённый контекст.

Каждый этап завершается прогоном реального UI Orca: действие пользователя → фактический index/commit/файл → проверка Git-состояния. Одних mock-тестов транспорта недостаточно.

На этапе планирования код и Git-состояние не менялись; команды discovery не доказывают корректность текущего GUI diff. Реализационный план уточняется по исходникам, без предположения о конкретном UI-фреймворке.
