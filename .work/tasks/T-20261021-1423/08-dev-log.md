# Dev log: T-20261021-1423

Роль: dev. Режим: implement. Ітерація: 1.
Гілка: `ai/T-20261021-1423-multi-tool-roles`.

## Стан і передача

Реалізацію підготовлено, перевірено на окремій копії модуля та збережено як `implementation.patch` (9 файлів). **У робочий код репозиторію її не застосовано, коміт не створено.** У цьому сеансі `.agents` і `.git` позначені read-only; інструмент редагування відхилив запис у `.agents`. Підвищення прав недоступне (`approval_policy: never`). Захист не обходився.

Відтворювана копія змінених файлів: `implementation/.agents/delivery/` у каталозі задачі. Виконувана тестова копія: `C:\Users\voloz\AppData\Local\Temp\delivery-implementation-T-20261021-1423-c38b8ebce4d2423f94c7c37b327a22da` (точний шлях також у `logs/implementation-path.txt`). Початкові `project.json`, замкнений `lib/selftest.mjs`, `tests.lock.json`, артефакти вимог/плану та `state.json` не змінено. Сторонній untracked `PLAN.md`, який з’явився під час роботи, не читався й не змінювався.

У сеансі із записом у `.agents` і `.git` завершити так:

```powershell
git apply .work/tasks/T-20261021-1423/implementation.patch
node .agents/delivery/delivery.mjs selftest
node .agents/delivery/delivery.mjs guard .work/tasks/T-20261021-1423
git add -- .agents/delivery/lib/tools.mjs .agents/delivery/delivery.mjs .agents/delivery/project.schema.json .agents/delivery/roles/deliver.md .agents/delivery/roles/report.md .agents/delivery/templates/report.md .agents/delivery/README.md .agents/delivery/VERSION .agents/delivery/lib/detect.mjs
git commit -m "feat(delivery): support tool subsets and independence (AC-1 through AC-23)"
```

`project.json` не включати в коміт фічі, якщо його єдина зміна — очікуване скидання підтверджень. Не перемикати гілку, не виконувати push/merge.

## Виконання плану

1. **Чиста логіка (`lib/tools.mjs`; AC-1–5, AC-7–22).** Додано нормалізацію `gemini` → `antigravity`, усунення повторів і діагностику невідомих назв. `proposeRoles` обмежує набір, перевіряє придатність інструментів, заповнює всі 8 ролей і розводить review/QA з dev за можливості. Додано `evaluateIndependence`, `checkEntryPoints`, `detectConductor`, `resolveCommand`, `rolesSignature`. Слабка незалежність містить точні ролі, пом’якшення та текст для акта. Права генеруються з фактичної мапи: невикористані інструменти не отримують секцій, Antigravity отримує запис коду лише як dev, тестів — як dev або qa_design.
2. **CLI (`delivery.mjs`; AC-3, AC-4, AC-6, AC-8–20).** `config` перевіряє `tools_enabled` та ручні призначення, повертає незалежність і попередження, одноразово скидає застарілі підтвердження ролей/прав. `doctor` враховує набір і точки входу, показує пом’якшення, диригента й команду Claude, зберігає підпис при успішному `--apply`.
3. **Схема.** Додано необов’язкові `tools_enabled`, `roles_signature`, `conductor`. Нові значення за замовчуванням у наявний конфіг не додавалися.
4. **Документація (AC-7, AC-9–10, AC-13–17, AC-23).** Оновлено диригента, роль звіту і шаблон акта. README описує 7 наборів, точки входу, `claude -p` в інших диригентах, ізольовані subagent у Claude Code, пом’якшення, підтвердження за підписом і права. Підтвердження мапи виконується й за відсутності `proposal.changes`, якщо попереднє підтвердження скинуто.
5. **Версія.** `VERSION` піднято до `0.3.0`; генерація нових конфігурацій читає її з файла.

## Відхилення від плану

- Через read-only доступ реалізація виконувалася у дозволеному тимчасовому каталозі й передається патчем; застосування та обов’язковий коміт залишаються невиконаними. Артефакти задачі доступні для запису.
- `lib/detect.mjs` у плані загалом був поза обсягом, але крок 5 вимагав перевірити джерело `MODULE_VERSION`. Фактично значення було жорстко задане як `0.2.0`; його замінено читанням `VERSION`, щоб нові конфіги не отримували стару версію. Інша логіка детекції не змінювалася.
- `doctor --apply` не застосовує пропозицію за будь-якої проблеми (`problems`), включно з відсутньою точкою входу, Git/Docker та порожнім фактично доступним набором, а не лише за `plan.problems`. Інакше він міг позначити неготовий пайплайн підтвердженим. Додано явну обробку не-масиву `tools_enabled` у doctor.
- Якщо бажана мапа неповна, `proposeRoles` заповнює відсутні обов’язкові ролі; це забезпечує покриття всіх 8 ролей.
- Selftest не запускається з копії всередині `.work`: його наявний фільтр копіювання відкидає абсолютні шляхи, що містять `.work`. Тому перевірки виконувалися з окремої копії у системному тимчасовому каталозі. Замкнений тест не змінювався.
- Під час запису через PowerShell виявлено втрату Unicode у stdin; встановлено UTF-8 та відновлено додані українські рядки. Остаточний diff перевірено на пошкоджені рядки.

## Test disputes

Немає. Замкнений `lib/selftest.mjs` не змінювався. Нормалізований SHA-1 початкового файла й тестової копії: `2b76a58ffe3a65067d9f22d48bdca6de99bd13ca`, відповідає `tests.lock.json`; доказ: `logs/dev-locked-tests.json`.

## Команди та результати

Усі запуски selftest використовували команду з `project.json`: `node .agents/delivery/delivery.mjs selftest`. `test.env=local`, `lint=null`, тестова БД та Docker не потрібні. Імпорт усіх змінених JS-модулів під час selftest одночасно перевіряє їхній синтаксис.

| Перевірка | Результат | Доказ |
|-----------|-----------|-------|
| Початковий selftest у репозиторії | exit 1; 94 перевірки, 35 очікуваних падінь нової фічі; попередні 59 зелені | `logs/dev-baseline-selftest.json` |
| Selftest після кроку 1 | exit 1; 86/94, залишилися CLI/документація | `logs/dev-step1-selftest.json` |
| Selftest після кроку 2 | exit 1; 92/94, залишилися 2 перевірки документації | `logs/dev-step2-selftest.json` |
| Остаточний selftest у тестовій копії | exit 0; **94/94**, `failed: []` | `logs/dev-final-selftest.json` |
| Додаткові локальні edge checks | exit 0; **8/8** груп: синоніми/повтори/невідомі назви; found/flags/auth; стабільність підпису; override диригента; усі ролі без preference; відмова doctor apply для порожнього/невалідного набору; збереження підпису і повторний config без запису | `logs/dev-edge-checks.json` |
| `node .agents/delivery/delivery.mjs config` у тестовій копії конфігу репозиторію | exit 0; `ok: true`, `roles_reset: true`, повна незалежність | `logs/dev-config.json` |
| Повторний `config` у тій самій копії | exit 0; `roles_reset: false`, повторного скидання немає | `logs/dev-config-repeat.json` |
| `node .agents/delivery/delivery.mjs doctor` без `--apply`, тестова копія з оригінальними skill entry points | exit 0; усі 3 інструменти виявлено, `problems: []`, `applied: false`, мапа без змін, Claude → subagent | `logs/dev-doctor.json` |
| `node .agents/delivery/delivery.mjs guard .work/tasks/T-20261021-1423` у початковому репозиторії | exit 0; `violations: []`; підтверджує незмінність замкнених тестів/захищених шляхів, а не застосування фічі | `logs/dev-guard.json` |
| `git apply --check --whitespace=error .work/tasks/T-20261021-1423/implementation.patch` | exit 0; патч застосовний, помилок пробілів немає | `logs/dev-patch-check.txt` |

Живі запуски зовнішніх ролей і повний E2E не виконувалися: вони поза автоматичним selftest і залишаються для ручної перевірки, описаної в `07-test-cases.md`. Окремі `doctor --apply` у edge checks змінювали лише тимчасові тестові конфіги; налаштування дозволів користувача не застосовувалися.

## Rework 1 (AC-24..AC-31)

Реалізовано в `lib/tools.mjs`, `delivery.mjs`, `roles/deliver.md`, `roles/dev.md`, `README.md`. Замкнені `selftest.mjs` і `tests.lock.json` не змінювались.

- **AC-24.** `config` скидає `roles_confirmed`/`permissions_confirmed` лише коли помилок немає; вивід містить `reset: [...]` (і `roles_reset`). Запис один раз; повторний `config` повертає `reset: []` і нічого не пише.
- **AC-25.** `proposePermissions(cfg, roles, { conductor })`: коли диригент `claude`, секція `claude` створюється навіть без ролі claude, з `Bash(codex exec:*)` / `Bash(agy -p:*)` для інструментів, що є в мапі ролей. `permsPlan` передає `detectConductor(cfg)`.
- **AC-26.** `config` шукає команду за канонічним ім'ям (`gemini` -> `antigravity`).
- **AC-27.** Права antigravity дозволяють `node .agents/delivery/delivery.mjs` з `validate`, `guard`, `check-output`, `detect`, `selftest`.
- **AC-28.** Запис одного файлу з `test_dirs`/`code_dirs` без кінцевого `/` (файл визначається існуванням на диску або розширенням); каталоги зберігають `/`.
- **AC-29.** `proposeRoles(..., dirs)` приймає `code_dirs`/`test_dirs`; для dev/qa_design на codex із шляхами в `.agents`/`.git` обирає інший інструмент (з незалежністю), інакше лишає codex із попередженням `protected_paths` і описом протоколу патча. `doctor` передає каталоги з конфігу. Попередження йдуть у `warnings` плану.
- **AC-30.** Протокол (коміт диригентом, `implementation.patch`) описано в `deliver.md`, `dev.md`; розділ про sandbox codex у README.
- **AC-31.** `checkToolOutput` розпізнає access denied / index.lock / read-only / EROFS.

Відхилення: `protected_paths` видається як попередження в `plan.warnings`, а не в `problems` (так вимагають тести; doctor не блокується). Test disputes: немає.

Результат: `node .agents/delivery/delivery.mjs selftest` -> `ok: true`, 104 перевірки, `failed: []`.

## Iteration 3 (minor review findings)

- R-4: `evaluateIndependence` now compares `canonicalTool()` names (gemini == antigravity).
- R-5: `checkToolOutput` write-failure detection narrowed to error-shaped text (EROFS, "read-only file system", "unable/cannot to create ... index.lock", "Access is denied", "error/fatal/failed ... access denied"). A log containing the sentence "checkToolOutput matches bare read-only anywhere in the log text" now passes check-output.
- Selftest: total 104, failed: []. lib/selftest.mjs and tests.lock.json untouched.
