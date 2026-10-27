# Этап 1 — Git-контексты, status и каталог сабмодулей

## Результат

Этап 1 реализован в `orca/`; этапы 2–9 не запускались. Сохранённая работа предыдущей попытки продолжена, а не заменена. Коммитов, публикации, изменений установленного app bundle и глобальной настройки CLI не выполнялось.

Путь пользователя: Source Control → Submodules → выбор Root/инициализированного сабмодуля → read-only Changes этого checkout. Каталог показывает clean-контексты, текущую ветку/detached/unborn, HEAD/index gitlinks и checkout OID, независимые new HEAD/dirty files/staged gitlink/conflicts, unavailable/uninitialized/blocked и unknown/limited descendants. Есть Loading, диагностика, incomplete и Refresh; прежний Changes/Monaco diff сохранён. Popup и Git-мутации здесь намеренно отсутствуют: это следующие этапы плана, не заглушки текущего этапа.

## Реализация и authority

- `getStatus(root, { includeWorkspace: true }) → GitStatusResult.workspace` расширяет существующий status pipeline. IPC, runtime RPC, provider options, preload и renderer client передают флаг; executionHostId добавляется доверенным host routing после разрешения worktree.
- `GitContextRef` связывает host, root, checkout, реальные git-dir и common git-dir. `RepositoryState` использует существующий `GitStatusEntry`; `SubmoduleEntry` отдельно хранит parent HEAD/index/conflict OID, current OID, dirty/conflict и полноту потомков. `expectedState` — hash HEAD/index/status, не атомарная транзакция и не mutation token, достаточный без новой проверки для записи.
- Источники discovery: HEAD/index gitlinks; `.gitmodules` в HEAD, всех index stages и worktree; local config без includes. Декларация без gitlink сохраняется как диагностическая строка, но не разрешает чтение checkout. Эта проверка перенесена перед любым обращением к дочернему пути.
- Относительные пути с `..`, абсолютные/альтернативные Windows пути, `.git`-компоненты, symlink checkout, внешние gitfile/commondir и канонические выходы за разрешённые metadata boundaries отвергаются. Ошибка ребёнка не прерывает здоровые контексты.
- Прежний argv-based runner: NUL-delimited machine metadata, separate stderr, 8 MiB maxBuffer, 15 s metadata-command timeout, max depth 16, contexts/rows 128, concurrency 4. Unsupported non-UTF-8 metadata возвращает ошибку вместо потери identity. `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=''`, optional locks disabled; shell/fetch/clone отсутствуют в catalog path.
- Старый lazy submodule expansion получает авторизованный контекст из того же каталога, не содержит второй status-реализации. Его consumer-visible committed-range/staged-limit тесты перенесены с mocked subprocess responses на настоящий Git.
- Existing recursive filesystem/runtime subscriptions, git-common metadata watchers и их event classifier переиспользуются. Добавлены bounded host-authorized metadata watch paths, debounce 300 ms, focus/visibility reconciliation и visible-only 15 s safety polling. В настоящем Electron обнаружена и устранена потеря fs events из-за `null` connectionId против отсутствующего поля; сопоставление учитывает также host canonical root.

## Выполненные проверки

Среда: Darwin arm64, Node 24.22.1 через `npm exec --package=node@24.22.1`, существующие project-local dependencies и Electron 43.8.1. Ниже — фактически выполненные проверки, не перечень предполагаемого покрытия.

| Проверка | Результат |
|---|---|
| Vitest: 8 выбранных файлов | 138 passed, 8 files passed |
| Финальный отдельный real-Git suite после extraction redaction/error helpers | 6 passed, 1 file passed |
| Native TypeScript, `config/tsconfig.node.json`, затем `config/tsconfig.web.json`, `--noEmit --composite false` | exit 0, без diagnostics |
| Targeted oxlint на новых workspace modules/types, catalog/panel и Electron spec | exit 0 |
| `run-electron-vite-build.mjs --mode e2e`, `VITE_EXPOSE_STORE=true` | exit 0; boot graph 176 chunks / 6057.6 KB minified |
| Настоящий hidden Electron: новый catalog journey + существующий golden Source Control Monaco diff | 2 passed, 26.6 s Playwright duration в финальном прогоне |

Выбранные Vitest owners:

- `src/main/git/source-control/git-workspace-status-real-git.test.ts`
- `src/main/git/status-submodule.test.ts`
- `src/main/git/status-submodule-path-cache.test.ts`
- `src/main/runtime/rpc/methods/git.test.ts`
- `src/main/ipc/worktree-base-directory-watcher.test.ts`
- `src/main/ipc/worktree-git-status-ref-watch.test.ts`
- `src/main/ipc/filesystem-git-status-staging.test.ts`
- `src/cli/handlers/file.test.ts`

Основная команда unit: `npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <перечисленные paths>`. Не запускался полный repository suite.

### Реальный Git fixture

`createGitWorkspaceFixture` создаёт disposable HOME, root с `one` и `two`, вложенный `one/same` и linked worktree `second`. У `one` и `one/same` одинаковое имя `same` на разных уровнях; `two` и `one/same` используют один локальный URL, но разные checkout identity. Git commands fixture имеют собственные user.name/email, отключённый signing и hooks path; конфигурация пользователя не используется для fixture mutations.

Фактически проверены:

1. Новый commit ребёнка вместе с dirty tracked и unusual Unicode/newline/tab untracked путём: current OID отличается от index; dirty и new HEAD одновременно true. После parent `git add one` current==index, но staged gitlink и dirty остаются независимыми.
2. Разные identity linked worktree при общем commonGitDir и разных gitDir; незаполненные сабмодули second имеют unknown descendants, а не пустой подтверждённый subtree.
3. Настоящий merge conflict внутри `two`; sibling contexts доступны. Deinit `one/same` сохраняет uninitialized запись. Рассогласованные HEAD/index/worktree declarations и local URL отображаются; credentials/query secrets не попадают в snapshot.
4. Index-only gitlink с неизвестным OID, checkout symlink, `../` declaration и внешняя `.git` pointer: явные unknown/blocked/error, здоровый sibling не теряется.
5. Promisor repository с физически отсутствующим локальным tree object и localhost HTTP listener: ошибка одного контекста, здоровый `two`, incomplete snapshot и **ровно 0 HTTP requests**.
6. Oversized metadata (>128 module declarations): limit error/incomplete, не фиктивное пустое healthy tree.
7. Legacy expansion: реальные working и commit-range строки, staged parent HEAD→index range, cap с двумя конкретными changed paths и отказ escaping path.

### Настоящий Electron UI

Постоянный сценарий `tests/e2e/git-workspace-catalog.spec.ts` использует существующий `helpers/orca-app.ts` с `createElectronHomeIsolation`, новым disposable userData/HOME и scoped process shutdown. `ORCA_BACKGROUND_LAUNCH=1`, `ORCA_E2E_HEADLESS=1`, `ORCA_DISABLE_MACOS_LOGIN_SHELL=1`; окно не показывается, что проверено через `BrowserWindow.isVisible() === false`.

DOM/UI assertions прошли для:

- открытия Submodules, завершённого local snapshot, трёх начальных строк и clean sibling;
- одновременных new HEAD и dirty files в `one`, выбора контекста и настоящего `file.txt` в его Changes;
- внешнего создания `externally-created.txt` и появления строки **до 12 s**, без ручного Refresh (раньше safety polling 15 s);
- реального merge conflict `two`, focus event reconciliation и conflict row в Changes;
- metadata path mismatch, incomplete status, Refresh loading state;
- deinit nested module, uninitialized + Descendants unknown;
- внешнего запрещённого gitfile у `two`, access-denied на его строке при сохранении dirty `one`;
- выбора реально обнаруженного linked worktree `second` через существующий detected-worktree state, двух uninitialized строк без состояния первого checkout;
- неизменного parent staged-набора и сохранности внешнего untracked файла после просмотра.

`golden-source-control-open-diff.spec.ts` также прошёл в настоящем Electron: существующий Source Control открывает Monaco original/modified; regression старого diff сценария не обнаружен.

Screenshot: `orca/.cache/stage1-git-contexts.png`, получен с hidden renderer и просмотрен. Видны реальный sidebar, Root, mixed-state child, uninitialized nested и mismatch/blocked rows; снимок сделан во время дополнительного watcher refresh, поэтому Loading и предыдущий snapshot одновременно видимы. DOM assertions проверяют отдельные завершённые состояния; screenshot не выдаётся за полный transcript всех сценариев.

Для безопасного smoke использован временный `.cache/stage1-playwright.config.ts`: только два названных spec, один electron-headless worker, без stock globalSetup (тот может устанавливать глобальный dev CLI). Команда: `env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test --config .cache/stage1-playwright.config.ts --project electron-headless`. Временный config и диагностическое console instrumentation после проверки удалены; spec остаётся постоянным и совместимым со штатным harness.

## Обнаруженные и исправленные проблемы проверки

- Первый новый UI smoke воспроизвёл missing external-file refresh. Raw IPC event доказал доставку настоящего fs event; исправлена нормализация optional connectionId в panel и canonical-root matching в catalog. Финальный тест прошёл без ослабления 12 s ожидания.
- Golden activation helper перечисляет только managed worktrees; linked fixture был в настоящем detected catalog. Smoke теперь выбирает существующую обнаруженную запись, не подделывает worktree metadata и не меняет production helper.
- Typecheck нашёл optional URL `.at(-1)`, nullable target/connectionId; исправлены checked narrowing и явный unavailable UI при отсутствии host target.
- Lint потребовал braces и ограничение длины module; error/redaction выделены в небольшой `git-workspace-error.ts`, без re-export compatibility shim.
- Первый CLI путь `@stablyai/playwright-test/cli.js` оказался несуществующим; использован реальный `@playwright/test/cli.js` из dependencies. Это не приложение/feature failure.

## Границы и безопасность запуска

Проверены локальные реальные Git/Electron сценарии. Настоящий SSH/WSL/Windows host, release package, PTY interactive smoke, OS-cold performance и popup этапа 2 не проверялись. Существующие routing/process conventions сохранены; локальный smoke не доказывает remote-platform acceptance.

Координатор сообщил о потере production runtime и его восстановлении во время работы. Worker не выполнял `killall`, `pkill`, `orca open`, остановку production сервиса или установленного bundle; запускал только project build, TypeScript/Vitest/oxlint и existing isolated Playwright harness. Причина production disconnect не установлена; отсутствие причинной связи не заявляется как доказанный факт. Жизненный цикл test Electron обслуживал process-scoped repository harness.

Этап 1 завершён; следующий этап разрешён только отдельной сессией координатора. Изменения не закоммичены и не опубликованы.

## Modern Web Guidance

Я проверил accessibility guidance и сохранил native buttons, heading/list structure, labelled regions и status/error announcements вместо custom keyboard widgets: “Prefer HTML elements and attributes to ARIA”. Новые popup/navigation patterns этапа 2 не внедрялись.
