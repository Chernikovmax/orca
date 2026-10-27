# Этап 3 — Changes и качественный diff

## Результат

В `orca/` продолжены сохранённые незакоммиченные результаты этапов 1–2. Полностью реализован только этап 3: Changes корня и инициализированного дочернего checkout открывают настоящий diff в одном существующем editor/Monaco пути. Никаких stage-4 child commit/stage/discard или будущих Log/checkout команд не добавлено. Production приложение, пользовательский профиль и глобальный CLI не менялись.

Общая `SourceControlWorkspaceChanges` показывает Conflicts/Unstaged/Staged/Untracked, Tree/List, фильтр и соседние файлы. Выбор файла и прокрутка хранятся по host-issued context ID; режим Monaco Side by side/Unified — также по context ID. Открытая diff-вкладка помнит свой root worktree и selection, не подменяет ребёнка корнем. При обновлении snapshot её read-only содержимое перечитывается, поздний ответ не заменяет новую selection; изменение входов во время чтения помечается stale и предлагает Reload. Monaco сохраняет штатные word highlight, context folding и next/previous hunk.

`GitDiffSelection` явно задаёт HEAD/index/worktree/commit/empty стороны и оба пути rename. Общий bounded reader использован для обычного, commit и branch diff; отсутствующая HEAD в unborn репозитории даёт пустую сторону. Чтение только по запросу, максимум 8 MiB содержимого; бинарный файл, большой файл, неподдерживаемый UTF-8, symlink, mode и unmerged index получают соответствующее представление. Gitlink diff показывает OID старого/нового child commit и кнопку перехода в Changes ребёнка. Каталог по-прежнему читает porcelain с `--ignore-submodules=all`; pointer rows для staged/unstaged/conflict восстанавливаются из авторизованной HEAD/index/child metadata, без смешивания дочерних файлов с родительским index. При выбранном ребёнке родительские commit/branch/bulk actions скрыты.

Мигрированы shared RPC schema, provider, main/runtime RPC, IPC, preload, local/runtime renderer client, editor open actions и view models. Существующие CLI `file diff` и `file open-changed` продолжают отправлять прежний запрос и проходят их regression suite; context selector дополнительно перепроверяется после разрешения зарегистрированного worktree на execution host. Нет произвольного cwd или пути ребёнка как полномочия, нет shell/fetch/lazy-fetch на чтении.

## Наблюдённые проверки

Среда: Darwin arm64, checkout `/Users/chernikovmax/orca/projects/light/orca`, Node 24.22.1 через process-local `npm exec --package=node@24.22.1`, Electron 43.8.1. `npm exec` не устанавливал глобальный Orca CLI.

| Проверка | Результат |
|---|---|
| Focused Vitest на real Git/status/cache/RPC/IPC/watchers/CLI, 11 файлов | **141 passed**, 11 files, 15.42 s test duration |
| Дополнительный real Git regression после восстановления gitlink rows | **14 passed**, 3 files |
| Финальный real Git check после стабильной сортировки нескольких gitlink rows | **11 passed**, 2 files |
| TypeScript `config/tsconfig.web.json --noEmit --composite false` | exit 0 |
| Targeted node dependency graph с `src/types/build-constants.d.ts` | exit 0 |
| RPC catalog `generate-rpc-params-catalog.mjs --check` и targeted oxlint | exit 0 |
| Electron-vite `--mode e2e`, `VITE_EXPOSE_STORE=true`, CLI prepare пропущен | exit 0; 176 renderer boot chunks, 6058.5 KB minified |
| Настоящий Electron: stage-3 root/child/gitlink + соседние catalog/popup/golden specs | **4 passed / 1.3m**, один worker, hidden BrowserWindow |

Команды проверок:

```sh
npm exec --yes --package=node@24.22.1 -- vitest run --config config/vitest.config.ts \
  src/main/git/source-control/git-diff-document-real-git.test.ts \
  src/main/git/source-control/git-workspace-status-real-git.test.ts \
  src/main/git/status-diff.test.ts src/main/git/status-diff-settled-cache.test.ts \
  src/main/git/status-submodule.test.ts src/main/git/status-submodule-path-cache.test.ts \
  src/main/runtime/rpc/methods/git.test.ts \
  src/main/ipc/worktree-base-directory-watcher.test.ts \
  src/main/ipc/worktree-git-status-ref-watch.test.ts \
  src/main/ipc/filesystem-git-status-staging.test.ts src/cli/handlers/file.test.ts \
  src/renderer/src/store/slices/editor/actions/editor-open-diff.test.ts
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.web.json --noEmit --composite false
npm exec --yes --package=node@24.22.1 -- node config/scripts/generate-rpc-params-catalog.mjs --check
```

Последний путь `editor-open-diff.test.ts` в команде не найден Vitest; он запустил **11** подходящих файлов, а не заявленные 12. Отдельные editor/Monaco assertions выполнены реальным Electron spec. Targeted node check запускался временным `.cache/stage3-node-tsconfig.json` с перечисленными backend/transport файлами; временный config удалён после проверки.

Build и smoke:

Для воспроизведения `.cache/stage3-playwright.config.ts` (временный файл, удалён после smoke):

```ts
import { defineConfig } from '@stablyai/playwright-test'

export default defineConfig({
  testDir: '../tests/e2e',
  testMatch: [
    'git-workspace-diff.spec.ts',
    'git-workspace-popup.spec.ts',
    'git-workspace-catalog.spec.ts',
    'golden-source-control-open-diff.spec.ts'
  ],
  timeout: 120_000,
  workers: 1,
  projects: [{ name: 'electron-headless', metadata: { orcaHeadful: false } }]
})
```

```sh
env VITE_EXPOSE_STORE=true ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node config/scripts/run-electron-vite-build.mjs --mode e2e
env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test \
  --config .cache/stage3-playwright.config.ts --project electron-headless
```

Временный Playwright config выбирал четыре постоянных spec и отключал stock globalSetup/globalTeardown, которые могли бы подготовить глобальный CLI. `helpers/orca-app.ts` создал disposable HOME/userData и остановил только свои Electron процессы; Git fixture создана отдельно и удалена после shutdown. E2E действительно открыл root staged и unstaged Monaco original/modified, child staged и unstaged (CRLF/без завершающего newline), gitlink → child Changes, binary и >8 MiB, затем проверил внешнюю правку в modified Monaco и неизменность HEAD/index/status root, `one`, `two` до неё. Видимое окно не поднималось. Catalog проверяет рекурсию и worktree isolation; popup — refs/keyboard, golden — прежний diff/open путь. Снимок hidden renderer: `orca/.cache/stage3-child-diff.png`.

Real Git regression отдельно проверяет added/deleted/modified/rename со старым и новым путём (включая Unicode, newline, tab, CRLF), staged+unstaged одного файла, бинарный blob, большой файл, неподдерживаемую кодировку, symlink/mode, HEAD/index/worktree/commit, unborn HEAD, borrowed context/path escape, parent gitlink OID и изоляцию соседнего checkout. Для двух изменившихся дочерних gitlink повторный snapshot сохраняет тот же `expectedState`: порядок pointer rows стабилен, хотя discovery конкурентен. Старые tests, которые привязывались к mocked implementation вместо поведения, заменены настоящими Git fixtures; mock-echo тест не сохранялся.

## Найденные регрессии и пределы

Первая интеграция дала **3 passed / 1 failed** в Electron: golden Monaco существовал, но был нулевой высоты под новым wrapper; вложенный viewer теперь имеет flex-column parent. Следующий прогон **2 passed / 2 failed** выявил отсутствие parent gitlink row: каталог умышленно читает `--ignore-submodules=all`, поэтому status не содержит gitlink. Синтезированы только pointer rows из уже авторизованной metadata и добавлен real Git regression; итоговый прогон **4 passed**. В диагностических прогонах не ослаблялись assertions и не менялся stock golden spec.

Полные `tsc` node/CLI не завершились из-за ошибок вне stage-3 файлов: `locale-text-collators.test.ts` extension и `import.meta` в `orcad-artifacts.test.ts`/`hello-orca-panel-messages.test.ts`. Полный `tsconfig.e2e.json` — существующий ratcheted, не-clean project: missing `@orca-cloud/relay-contract`/`pg` и множество ошибок не связанных E2E specs. Узкий E2E TS graph также столкнулся с конфликтом прежних ambient `__paneManagers` types (`env.d.ts` и `helpers/runtime-types.ts`); поэтому E2E compile exit 0 не заявляется. Узкий node graph и web project проверены; реальные E2E spec прошли. Настоящие SSH/WSL/Windows execution hosts, release package, native visible-window focus и нагрузка 128 Git contexts не запускались; локальный smoke не является доказательством этих платформ.

Modern Web Guidance: для Tree/List, фильтра и навигации использованы native accessible buttons/input с `aria-pressed`, `aria-expanded`, именованными group/region и явными loading/status текстами. Никаких новых modal primitives или browser-only CSS features не введено.
