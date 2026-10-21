# План: перерозподіл ролей між інструментами

## Мета

1. Розвантажити Claude (дефіцитні ліміти підписки): ролі, що читають багато коду й документації (`architect`, `review`), віддати Gemini (`antigravity`) з великим контекстним вікном.
2. Будь-яка роль, включно з диригентом, має працювати без конкретного інструмента: якщо немає підписки на claude, codex чи antigravity, роль переходить до наявного.

## Що вже є (коміт 0f1c3fc)

- `tools_enabled` у `project.json` обмежує набір інструментів; `doctor` перевіряє наявність, прапорці й авторизацію, `doctor --apply` зберігає мапу ролей ([tools.mjs:100-137](.agents/delivery/lib/tools.mjs#L100-L137)).
- Усі 8 ролей покриваються навіть одним інструментом; `review`, `qa_design`, `qa_run` відокремлюються від `dev`, коли є другий інструмент. Якщо інструмент один, видається `weak independence` із пом'якшеннями ([tools.mjs:139-151](.agents/delivery/lib/tools.mjs#L139-L151)).
- Диригент може бути Claude Code, Codex або Gemini/Antigravity (`conductor`, `detectConductor`, окремі точки входу `.claude/skills/deliver` і `.agents/skills/deliver`). Claude-ролі йдуть через subagent у Claude Code і через `claude -p` в інших ([tools.mjs:166-179](.agents/delivery/lib/tools.mjs#L166-L179)).
- Таблиця комбінацій набору й диригента описана в [README.md:84-104](.agents/delivery/README.md#L84-L104).

## Що лишається зробити

### 1. Змінити дефолтний розподіл

Цільовий розподіл:

| Роль | Було | Стане |
|---|---|---|
| ba, teamlead, report | claude | claude |
| architect | claude | **antigravity** |
| review | claude | **antigravity** |
| qa_design, qa_run | antigravity | antigravity |
| dev | codex | codex |

Файли:
- [detect.mjs:8-11](.agents/delivery/lib/detect.mjs#L8-L11): `DEFAULT_ROLES`;
- [project.json:63-72](.agents/delivery/project.json#L63-L72): `roles` цього репозиторію.

### 2. Виправити черги підстановки (`FALLBACK`)

[tools.mjs:91-97](.agents/delivery/lib/tools.mjs#L91-L97). Сьогодні для `architect` черги немає, тому береться `default` з claude першим. Для `review` claude теж перший. Нові черги:

```js
architect: ['antigravity', 'claude', 'codex'],
review:    ['antigravity', 'claude', 'codex'],
```

Решта (`ba`, `teamlead`, `report`) лишається на `default`: claude, antigravity, codex. Перевірити, що відокремлення від dev у [tools.mjs:126-133](.agents/delivery/lib/tools.mjs#L126-L133) працює з новою чергою `review`.

### 3. Перевірити ролі без Claude

Пройти кожну роль у `roles/*.md` і `.agents/skills/deliver-*/SKILL.md` і знайти припущення, що виконавець — Claude або subagent:
- чи коректно `architect` і `review` запускаються через `agy -p` і повертають вивід за [review.schema.json](.agents/delivery/schemas/review.schema.json);
- чи `ba` і `report` (діалог із PO, підсумковий звіт) працюють, якщо їх виконує codex або antigravity;
- чи немає в промптах ролей згадок інструментів, доступних лише в Claude Code.

### 4. Тести

[selftest.mjs](.agents/delivery/lib/selftest.mjs): оновити очікування для дефолтних ролей і додати кейси:
- усі інструменти доступні → architect і review на antigravity;
- вимкнено antigravity → architect і review переходять на claude, потім на codex;
- вимкнено claude → ba, teamlead, report переходять на antigravity, потім на codex;
- вимкнено codex → dev переходить на claude, review лишається окремим від dev;
- доступний один інструмент → усі ролі на ньому, `weak independence` для review, qa_design, qa_run.

### 5. Документація

[README.md](.agents/delivery/README.md) і [INSTALL.md](.agents/delivery/INSTALL.md): оновити дефолтну таблицю ролей і пояснення, чому саме так (великий контекст для architect/review, діалог із PO на claude).

### 6. Запуск

`node .agents/delivery/delivery.mjs selftest` — усе зелене. Потім `doctor` на цьому репозиторії для перевірки реальної мапи.

## Відкриті питання

- Чи стабільно `agy` віддає структурований JSON для `review` (прапорець `--output-format json` у команді вже є)?
- Міграція вже налаштованих проєктів: їхній `project.json` збереже старі ролі. Достатньо змінити дефолти для нових чи потрібен окремий крок у `doctor`?
- Чи якість `ba` і `report` залишиться прийнятною, коли їх виконує не Claude (діалог із PO є найчутливішим місцем)?
