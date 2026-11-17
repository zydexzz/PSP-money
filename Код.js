/**
 * PSP деньги — перенос 2026 года из «PSP-наборы» в Битрикс24.
 *
 * ПРОБНЫЙ ПРОГОН: в Битриксе НИЧЕГО не меняется.
 * Скрипт читает таблицу и Битрикс и пишет в таблицу два листа:
 *   «План переноса»      — что будет сделано с каждой строкой при боевом прогоне;
 *   «Чек-лист для Гулим» — что поправить в таблице до боевого прогона.
 *
 * Запуск: функция dryRun.
 * Нужны два свойства скрипта (Настройки проекта → Свойства скрипта):
 *   BITRIX_WEBHOOK — адрес входящего вебхука (права: crm, user),
 *                    например https://example.bitrix24.ru/rest/1/abc123/
 *   SHEET_ID       — ID таблицы «PSP-наборы с 2024» (из её адреса).
 */

// ===================== НАСТРОЙКИ =====================

// ID таблицы «PSP-наборы с 2024» (кусок адреса между /d/ и /edit) хранится в свойстве скрипта SHEET_ID,
// как и вебхук, — в коде его нет.
function sheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Добавь свойство скрипта SHEET_ID (ID таблицы «PSP-наборы с 2024» из её адреса)');
  return id;
}
const DEAL_CATEGORY_ID = 0;   // воронка PSP
const INVOICE_TYPE_ID = 31;   // счета Битрикс24

// Листы потоков. order — порядок обработки (новые первыми), чтобы свежая сделка
// клиента досталась свежему потоку.
const STREAM_SHEETS = [
  { sheet: 'PSP KZ 2026 (октябрь)', stream: 'Поток · осень 2026', order: '2026-11-02' },
  { sheet: 'PSP KZ 2026',           stream: 'Поток · весна 2026', order: '2026-03-01' },
];

// Листы семинаров → значение «Поток / мероприятие».
const SEMINAR_SHEETS = [
  { sheet: 'Семинары 2026', sections: {
      '14': 'Семинар · Михаил Боттинг · 26–30.01.2026',
      '15': 'Семинар · Крис Дженкинс · 04–08.05.2026',
      '16': 'Семинар · Медведев и Смолий · 16–19.07.2026' } },
  { sheet: 'Семинар Бишкек',            event: 'Семинар · Бишкек · 10–13.09.2026' },
  { sheet: 'Семинар Михаил Боттинг',    event: 'Семинар · Михаил Боттинг · 26–30.09.2026' },
  { sheet: 'Семинар Крис Дженкинс',     event: 'Семинар · Крис Дженкинс · 19–23.10.2026' },
  { sheet: 'Семинар Медведев и Смолий', event: 'Семинар · Медведев и Смолий · 20–22.11.2026' },
  { sheet: 'Доступ к семинару',         event: '' },
];
const SEMINAR_PROGRAM = 'Семинар';

// Как программа записана в таблице → начало названия в списке Битрикса.
const PROGRAM_ALIASES = {
  'тренерпофизическойподготовке': 'Тренер по физической и функциональной подготовке',
};
const DEFAULT_RESPONSIBLE = 'Гулим';   // если в таблице ответственный не указан
const PHONEBOOK_SHEET = 'ПП в РФ';     // отсюда берём телефоны, которых нет в листах потоков

// Подписи полей сделки в Битриксе (коды скрипт находит сам).
const FIELD_LABELS = {
  program:      'Программа PSP',
  stream:       'Поток / мероприятие',
  discount:     'Скидка, %',
  payee:        'Получатель оплаты',
  contractNo:   '№ договора',
  contractDate: 'Дата договора',
  paidTotal:    'Оплачено всего',
  balance:      'Остаток',
};

// Поля, для которых код задан явно: в Битриксе есть несколько полей с таким названием.
// UF_CRM_1711453368 — настоящее «Программа PSP» (его заполняют); UF_CRM_6AF61DDE7C017 — пустой двойник.
const FIELD_CODES = {
  program: 'UF_CRM_1711453368',
};

// Как ответственные записаны в таблице → кусок имени пользователя в Битриксе.
const MANAGERS = {
  'гулим': 'гулим',
  'ставрик': 'иван psp',
  'влад': 'михаил psp',
  'берик': 'берик',
};

// Слова в примечаниях, которые означают «клиент мог выбыть» — спрашиваем Гулим.
const LEAVE_WORDS = ['отчисл', 'покинул', 'отказал', 'не будет обучаться', 'возврат', 'другой поток'];

// Вопрос про оплату семинара. Текст нужен в двух местах: где вопрос создаётся и где к нему подбирается список ответов.
const PAID_QUESTION = 'Семинар прошёл, оплата пустая: оплатил на месте или не пришёл?';

// Варианты выпадающего списка в колонке E чек-листа.
const ANSWER_SKIP = 'Не знаю — пропустить';
const ANSWER_PAID = 'Оплатил на месте';
const ANSWER_NO_SHOW = ['Не пришёл', 'Не пришёл, сделали возврат'];   // денег нет — переносить нечего
const PAID_ANSWERS = [ANSWER_PAID].concat(ANSWER_NO_SHOW, [ANSWER_SKIP]);

// Кусочки слов, по которым ответ считается пропуском (так Гулим пишет сейчас: «не помню», «спросить у СБ»).
const SKIP_WORDS = ['не знаю', 'не помн', 'пропуст', 'спросить', 'узнать', 'найти в битрикс'];

// ===================== ЗАПУСК =====================

function dryRun() {
  const plan = buildPlan_();
  writePlan_(plan.rows, plan.meta);
  writeChecklist_(plan.rows);
  Logger.log('Готово: строк ' + plan.rows.length + '. Смотри листы «План переноса» и «Чек-лист для Гулим».');
}

// Общая часть dryRun и liveRun: читает таблицу и Битрикс, считает план по каждой строке.
// В Битриксе ничего не меняет.
function buildPlan_() {
  const meta = loadMeta_();
  const rows = readRows_();
  fillPhones_(rows);
  markDuplicates_(rows);
  findContacts_(rows);
  findContactsByName_(rows);
  const dealsByContact = findDeals_(rows, meta);

  rows.sort((a, b) => (b.order || '').localeCompare(a.order || ''));
  const claimed = {};
  rows.forEach(row => {
    const deal = chooseDeal_(row, dealsByContact, meta, claimed);
    if (deal) { claimed[deal.ID] = true; row.deal = deal; }
  });

  const invoices = paidInvoices_(rows.filter(r => r.deal).map(r => r.deal.ID));
  rows.forEach(row => planRow_(row, meta, invoices));

  rows.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.line - b.line);
  return { meta: meta, rows: rows };
}

// ===================== БИТРИКС: МЕТАДАННЫЕ =====================

function loadMeta_() {
  const fields = call_('crm.deal.fields').result;
  const meta = { fields: {}, problems: [], notes: [], stageName: {}, stageId: {}, users: [] };

  Object.keys(FIELD_LABELS).forEach(key => {
    const label = norm_(FIELD_LABELS[key]);
    const hasLabel = code => [fields[code].formLabel, fields[code].listLabel, fields[code].filterLabel]
      .some(l => norm_(l) === label);
    let codes = Object.keys(fields).filter(code => code.indexOf('UF_CRM_') === 0 && hasLabel(code));
    const fixed = FIELD_CODES[key];
    if (fixed) {
      // Код задан явно: берём только его, остальные поля с тем же названием — лишь заметка.
      if (!fields[fixed] || !hasLabel(fixed)) {
        meta.problems.push('Поле «' + FIELD_LABELS[key] + '»: заданного кода ' + fixed + ' нет в Битриксе или у него другое название');
        codes = [];
      } else {
        const others = codes.filter(c => c !== fixed);
        if (others.length) meta.notes.push('Есть ещё поле «' + FIELD_LABELS[key] + '» (' + others.join(', ') + ') — скрипт его не использует');
        codes = [fixed];
      }
    } else if (codes.length !== 1) {
      meta.problems.push('Поле «' + FIELD_LABELS[key] + '»: в Битриксе найдено ' + codes.length);
    }
    if (codes.length) meta.fields[key] = { code: codes[0], items: fields[codes[0]].items || [],
      type: fields[codes[0]].type, multiple: !!fields[codes[0]].isMultiple };
  });
  if (!meta.fields.program || !meta.fields.stream) {
    throw new Error('Не нашёл поля «Программа PSP» или «Поток / мероприятие». ' + meta.problems.join('; '));
  }

  callAll_('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE' } }).forEach(s => {
    meta.stageName[s.STATUS_ID] = s.NAME;
    meta.stageId[norm_(s.NAME)] = s.STATUS_ID;
  });
  if (!meta.stageId[norm_('Оплата частями')]) meta.problems.push('Нет стадии «Оплата частями»');

  try {
    meta.users = callAll_('user.get', { ACTIVE: true }).map(u => ({
      id: u.ID, name: ((u.NAME || '') + ' ' + (u.LAST_NAME || '')).trim() }));
  } catch (e) {
    meta.problems.push('Не читаются пользователи (добавь вебхуку право user): ' + e.message);
  }

  // Оплаченная стадия смарт-счетов — нужна liveRun для счёта «Оплата до переноса».
  try {
    const cats = call_('crm.category.list', { entityTypeId: INVOICE_TYPE_ID }).result.categories || [];
    const cat = cats.find(c => c.isDefault === 'Y' || c.isDefault === true) || cats[0];
    if (!cat) throw new Error('нет направлений счетов');
    meta.invoiceCategory = cat.id;
    const st = callAll_('crm.status.list', { filter: { ENTITY_ID: 'SMART_INVOICE_STAGE_' + cat.id } });
    const paid = st.find(s => /:P$/.test(s.STATUS_ID));
    meta.invoicePaidStage = paid ? paid.STATUS_ID : 'DT' + INVOICE_TYPE_ID + '_' + cat.id + ':P';
  } catch (e) {
    meta.problems.push('Не читаются настройки счетов: ' + e.message);
  }
  return meta;
}

// ===================== ТАБЛИЦА =====================

function readRows_() {
  const ss = SpreadsheetApp.openById(sheetId_());
  const rows = [];
  STREAM_SHEETS.forEach(cfg => readStreamSheet_(ss, cfg, rows));
  SEMINAR_SHEETS.forEach(cfg => readSeminarSheet_(ss, cfg, rows));
  return rows;
}

function readStreamSheet_(ss, cfg, rows) {
  const sh = sheet_(ss, cfg.sheet);
  const v = sh.getDataRange().getDisplayValues();
  const h = header_(v);
  const hasRubCols = ('Сумма по договору (rub)' in h.map);

  for (let r = h.row + 1; r < v.length; r++) {
    const x = v[r];
    const fio = cell_(x, h, ['ФИО']);
    if (!fio) continue;

    const row = newRow_(cfg.sheet, r + 1, fio, cfg.order);
    row.program = cell_(x, h, ['Программа']);
    row.stream = cfg.stream;
    row.phone = phone_(cell_(x, h, ['Контакт']));
    const contract = cell_(x, h, ['Номер договора']);
    row.contractNo = /\d/.test(contract) ? contract : '';
    row.contractDate = date_(cell_(x, h, ['Дата договора']));
    row.discount = percent_(cell_(x, h, ['Скидка (%)']));
    row.responsible = cell_(x, h, ['Ответственный']);
    row.notes = [cell_(x, h, ['Эл.почта']), cell_(x, h, ['Примечание'])].join(' ').trim();

    const sumMain = money_(cell_(x, h, ['Сумма по договору (kt)', 'Сумма по договору']));
    const paidMain = money_(cell_(x, h, ['Оплачено (kzt)', 'Оплачено (тенге)']));
    let sumRub = money_(''), paidRub = money_('');
    if (hasRubCols) {
      sumRub = money_(cell_(x, h, ['Сумма по договору (rub)']), 'RUB');
      paidRub = money_(cell_(x, h, ['Оплачено (rub)']), 'RUB');
    }
    [sumMain, paidMain, sumRub, paidRub].forEach(m => {
      if (!m.ok) row.data.push('Не число: «' + m.text + '»');
    });

    if (!hasRubCols) {
      // весенний лист: одна колонка, рубли помечены «р.»
      row.currency = (sumMain.currency === 'RUB' || paidMain.currency === 'RUB') ? 'RUB' : 'KZT';
      row.sum = sumMain.amount;
      row.paid = paidMain.amount;
    } else {
      if (sumMain.amount && sumRub.amount) row.data.push('Сумма договора и в тенге, и в рублях');
      row.currency = sumRub.amount ? 'RUB' : (sumMain.amount ? 'KZT' : (paidRub.amount ? 'RUB' : 'KZT'));
      row.sum = row.currency === 'RUB' ? sumRub.amount : sumMain.amount;
      row.paid = row.currency === 'RUB' ? paidRub.amount : paidMain.amount;
      const otherPaid = row.currency === 'RUB' ? paidMain.amount : paidRub.amount;
      if (otherPaid) row.data.push('Договор в ' + row.currency + ', а оплата в другой валюте');
    }

    // Строка без договора и без денег — это интерес, не сделка с деньгами.
    const paidText = paidMain.text || paidRub.text;
    if (!row.contractNo && !row.paid && !paidText) continue;
    if (row.discount === 100 && !row.sum && !row.paid) continue;   // бесплатное место — денег нет

    row.payee = payee_(row, contract);
    leaveCheck_(row);
    rows.push(row);
  }
}

function readSeminarSheet_(ss, cfg, rows) {
  const sh = sheet_(ss, cfg.sheet);
  const v = sh.getDataRange().getDisplayValues();
  const h = header_(v);
  let event = cfg.event || '';
  const notesFrom = h.map['Спикер'];

  for (let r = h.row + 1; r < v.length; r++) {
    const x = v[r];
    const sec = String(x[0] || '').trim().match(/^\((\d+)\)/);
    if (sec && cfg.sections) { event = cfg.sections[sec[1]] || ''; continue; }
    const fio = cell_(x, h, ['ФИО']);
    if (!fio) continue;

    const row = newRow_(cfg.sheet, r + 1, fio, eventEnd_(event) || '2026-01-01');
    row.program = SEMINAR_PROGRAM;
    row.stream = event;
    row.phone = phone_(cell_(x, h, ['Эл.почта/Телефон']));
    const d = cell_(x, h, ['Дата договора']);
    if (date_(d)) row.contractDate = date_(d); else if (/\d/.test(d)) row.contractNo = d;
    row.discount = percent_(cell_(x, h, ['100%']));
    row.notes = notesFrom === undefined ? '' : x.slice(notesFrom).join(' ').trim();

    const sum = money_(cell_(x, h, ['Сумма по договору']), 'KZT');
    const paid = money_(cell_(x, h, ['Оплачено']), 'KZT');
    [sum, paid].forEach(m => { if (!m.ok) row.data.push('Не число: «' + m.text + '»'); });
    row.currency = sum.currency || paid.currency || 'KZT';
    row.sum = sum.amount;
    row.paid = paid.amount;
    if (paid.amount && paid.currency !== row.currency) {
      row.data.push('Оплата «' + paid.text + '» не в валюте договора: сколько это в ' + row.currency + '?');
      row.paid = 0;
    }

    const low = row.notes.toLowerCase();
    if (!row.sum && !row.paid && paid.ok) continue;          // бесплатно или пусто
    if (/отказ/.test(low) && !row.paid) continue;            // отказался, денег нет
    if (!event) row.data.push('Не указано, какой это семинар');
    if (row.sum && !row.paid && paid.ok && eventEnd_(event) && eventEnd_(event) < today_()) {
      row.data.push(PAID_QUESTION);
    }
    if (/возврат/.test(low)) row.data.push('Возврат: какая сумма в итоге осталась у PSP?');

    row.payee = row.currency === 'KZT' ? 'PSP KZ' : '';
    if (row.currency !== 'KZT') row.data.push('Валюта ' + row.currency + ': кто получатель?');
    rows.push(row);
  }
}

function newRow_(sheet, line, fio, order) {
  return { sheet: sheet, line: line, fio: fio, order: order, data: [], tech: [],
           program: '', stream: '', phone: '', contractNo: '', contractDate: '', discount: '',
           responsible: '', notes: '', currency: 'KZT', sum: 0, paid: 0, payee: '',
           contactIds: [], contactSrc: {}, deal: null };
}

function payee_(row, contractCell) {
  if (row.currency === 'KZT') return 'PSP KZ';
  const m = (contractCell + ' ' + row.notes + ' ' + row.fio).toLowerCase();
  if (/мма/.test(m)) return 'ММА';
  if (/(^|[\s(])ип([\s)]|$)/.test(m)) return 'ИП Нечувилин';
  row.data.push('Оплата в рублях без пометки «ИП» или «ММА»: кто получатель?');
  return '';
}

function leaveCheck_(row) {
  const low = row.notes.toLowerCase();
  const hit = LEAVE_WORDS.filter(w => low.indexOf(w) >= 0);
  if (hit.length) row.data.push('В примечании «' + row.notes + '»: выбыл? Если да, то по какой причине');
}

function markDuplicates_(rows) {
  const seen = {}, contracts = {};
  rows.forEach(row => {
    const where = '«' + row.sheet + '», строка ' + row.line;
    if (row.phone) {
      const key = row.phone + '|' + norm_(row.program) + '|' + norm_(row.stream);
      if (seen[key]) row.data.push('Дубль: тот же клиент и программа — ' + seen[key]);
      else seen[key] = where;
    }
    // Индивидуальный номер вида ФП-5/2026-03 должен быть уникальным (групповые С-3/2026 — нет).
    if (/\/\d{4}-\d+/.test(row.contractNo)) {
      const c = row.contractNo.replace(/\s/g, '');
      if (contracts[c]) row.data.push('Номер договора ' + c + ' уже есть у ' + contracts[c]);
      else contracts[c] = row.fio + ' (' + where + ')';
    }
  });
}

// ===================== БИТРИКС: ПОИСК =====================

function findContacts_(rows) {
  const cmds = {};
  rows.forEach((row, i) => {
    if (!row.phone) return;   // без телефона ищем по имени — см. findContactsByName_
    cmds['c' + i] = 'crm.duplicate.findbycomm?' +
      q_({ type: 'PHONE', values: ['+' + row.phone, row.phone], entity_type: 'CONTACT' });
  });
  const res = batch_(cmds);
  rows.forEach((row, i) => {
    const r = res.result['c' + i];
    row.contactIds = (r && r.CONTACT) ? r.CONTACT.map(String) : [];
    row.contactSrc = {};   // ID контакта → как найден: 'phone' или 'name'
    row.contactIds.forEach(id => row.contactSrc[id] = 'phone');
  });
}

function findDeals_(rows, meta) {
  const ids = [];
  rows.forEach(r => r.contactIds.forEach(id => { if (ids.indexOf(id) < 0) ids.push(id); }));
  const select = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'CLOSED', 'OPPORTUNITY', 'CURRENCY_ID', 'ASSIGNED_BY_ID',
                  'DATE_CREATE', meta.fields.program.code, meta.fields.stream.code];
  const cmds = {};
  // Все воронки: кандидаты потом только из PSP, но про остальные сделки клиента напишем в заметках.
  ids.forEach(id => cmds['d' + id] = 'crm.deal.list?' +
    q_({ filter: { CONTACT_ID: id }, select: select, order: { ID: 'DESC' } }));
  const res = batch_(cmds);
  const out = {};
  ids.forEach(id => out[id] = res.result['d' + id] || []);
  return out;
}

function chooseDeal_(row, dealsByContact, meta, claimed) {
  const pCode = meta.fields.program.code;
  const progId = itemId_(meta.fields.program, PROGRAM_ALIASES[norm_(row.program)] || row.program);
  const streamId = itemId_(meta.fields.stream, row.stream);
  row.progId = progId;
  row.streamId = streamId;
  if (row.program && !progId) row.tech.push('Программы «' + row.program + '» нет в списке Битрикса');

  let cands = [];
  const other = [];        // сделки клиента в других воронках — только для заметки
  const byPhone = {};      // ID сделки → true, если к ней привязан контакт, найденный по телефону
  row.contactIds.forEach(c => (dealsByContact[c] || []).forEach(d => {
    if (String(d.CATEGORY_ID) !== String(DEAL_CATEGORY_ID)) {
      if (other.indexOf(d.ID) < 0) other.push(d.ID);
      return;
    }
    if (row.contactSrc[c] === 'phone') byPhone[d.ID] = true;
    if (!claimed[d.ID] && !cands.some(x => x.ID === d.ID)) cands.push(d);
  }));
  if (other.length) row.tech.push('У клиента есть сделки в других воронках: ' + other.join(', '));
  // Сделку с другой программой не трогаем — у клиента может быть несколько договоров.
  cands = cands.filter(d => !d[pCode] || !progId || String(d[pCode]) === String(progId));
  if (!cands.length) return null;

  // Несколько подходящих сделок — сами не выбираем, спрашиваем Гулим (см. planRow_).
  if (cands.length > 1) {
    row.manyDealList = cands.slice().sort((a, b) => a.ID - b.ID);   // сами сделки — для чек-листа (стадия, дата, сумма)
    row.manyDeals = row.manyDealList.map(d => d.ID);
    return null;
  }
  row.foundByName = !byPhone[cands[0].ID];
  return cands[0];
}

function paidInvoices_(dealIds) {
  const cmds = {};
  dealIds.forEach(id => cmds['i' + id] = 'crm.item.list?' + q_({
    entityTypeId: INVOICE_TYPE_ID, filter: { parentId2: id },
    select: ['id', 'title', 'opportunity', 'currencyId', 'stageId'] }));
  const res = batch_(cmds);
  const out = {};
  dealIds.forEach(id => {
    const items = ((res.result['i' + id] || {}).items) || [];
    out[id] = items.filter(it => /:P$/.test(String(it.stageId)));
  });
  return out;
}

// ===================== ПЛАН ПО СТРОКЕ =====================

function planRow_(row, meta, invoices) {
  if (!row.deal) {
    // Ничего не создаём, пока Гулим не подтвердит, что сделки правда нет.
    if (row.manyDeals) {
      row.action = 'Несколько сделок — уточнить';
      // Вопрос списком: по строке на сделку (номер, стадия, дата, сумма). dealLinks — где в тексте номера,
      // чтобы в чек-листе сделать из них ссылки на Битрикс.
      const q = manyDealsQuestion_(row.manyDealList, meta);
      row.dealQ = q.text;
      row.dealLinks = q.links;
    } else {
      row.action = row.contactIds.length ? 'Контакт есть, сделки нет — уточнить' : 'Не найдено — уточнить';
      row.dealQ = 'Не нашёл сделку в Битриксе: впиши номер сделки или «нет — создать»';
    }
    row.data.push(row.dealQ);
    const search = MANAGERS[norm_(row.responsible)] || MANAGERS[norm_(DEFAULT_RESPONSIBLE)];
    const user = meta.users.find(u => norm_(u.name).indexOf(norm_(search)) >= 0);
    row.userName = user ? user.name : '';
  } else {
    row.action = 'Обновить сделку' + (row.foundByName ? ' (найдена по имени — проверь)' : '');
    // Старая сделка может быть прошлой покупкой клиента — её историю не затираем без Гулим.
    const created = String(row.deal.DATE_CREATE || '').slice(0, 10);
    if (created && created < '2025-09-01') {
      // Как и у «нескольких сделок»: номер — ссылка на сделку, дальше стадия, дата и сумма.
      const head = 'Нашёл сделку ';
      const id = String(row.deal.ID);
      row.dealQ = head + id + ' — ' + dealInfo_(row.deal, meta) +
        ': это эта же покупка? Если это прошлая — напиши «новая»';
      row.dealLinks = [{ start: head.length, end: head.length + id.length, url: dealUrl_(id) }];
      row.data.push(row.dealQ);
    }
  }

  const existing = row.deal ? (invoices[row.deal.ID] || []) : [];
  const sameCur = existing.filter(it => it.currencyId === row.currency);
  if (sameCur.length !== existing.length) row.tech.push('В сделке есть счета в другой валюте');
  row.invoicedBefore = sameCur.reduce((s, it) => s + Number(it.opportunity || 0), 0);
  row.transfer = row.paid - row.invoicedBefore;
  if (row.transfer < 0) row.tech.push('Счетов в Битриксе больше, чем оплачено по таблице');

  row.balance = row.sum ? row.sum - row.paid : '';
  if (row.sum && row.paid > row.sum) row.data.push('Оплачено больше суммы договора');
  if (!row.sum) row.data.push('Нет суммы договора');

  const stageNow = row.deal ? row.deal.STAGE_ID : '';
  row.stageNow = stageNow ? (meta.stageName[stageNow] || stageNow) : '';
  if (/LOSE$/.test(stageNow)) { row.stageNew = ''; row.tech.push('Сделка закрыта как проигранная — стадию не трогаем'); }
  else if (row.sum && row.paid >= row.sum) row.stageNew = 'Оплачено';
  else if (row.paid > 0) row.stageNew = 'Оплата частями';
  else row.stageNew = '';
  if (row.stageNew && row.stageNew === row.stageNow) row.stageNew = '';
}

// ===================== ВЫВОД =====================

function writePlan_(rows, meta) {
  const ss = SpreadsheetApp.openById(sheetId_());
  const sh = ss.getSheetByName('План переноса') || ss.insertSheet('План переноса');
  sh.clear();
  const portal = portal_();

  const head = ['Лист', 'Строка', 'ФИО', 'Телефон', 'Сделка', 'Действие', 'Программа',
    'Поток / мероприятие', 'Сумма', 'Валюта', 'Скидка, %', 'Получатель', '№ договора', 'Дата договора',
    'Оплачено (таблица)', 'Уже есть счетов', 'Счёт «Оплата до переноса»', 'Остаток',
    'Стадия сейчас', 'Стадия станет', 'Ответственный (новая)', 'Вопросы к данным', 'Технические заметки'];
  const out = rows.map(r => [
    r.sheet, r.line, r.fio, r.phone,
    r.deal ? '=HYPERLINK("' + portal + '/crm/deal/details/' + r.deal.ID + '/";"' + r.deal.ID + '")'
      : (r.manyDeals ? 'несколько: ' + r.manyDeals.join(', ') : 'новая'),
    r.action, r.program, r.stream + (r.stream && !r.streamId ? ' (добавим значение)' : ''),
    r.sum || '', r.currency, r.discount, r.payee, r.contractNo, r.contractDate,
    r.paid || '', r.invoicedBefore || '', r.transfer > 0 ? r.transfer : '', r.balance,
    r.stageNow, r.stageNew, r.userName || '', r.data.join('; '), r.tech.join('; ')]);

  // Сводка: по листам и валютам — чтобы сверить с итогами в шапке листов.
  const sum = {};
  rows.forEach(r => {
    const k = r.sheet + ' · ' + r.currency;
    sum[k] = sum[k] || [k, 0, 0, 0, 0];
    sum[k][1] += 1; sum[k][2] += r.sum; sum[k][3] += r.paid; sum[k][4] += (r.balance || 0);
  });
  const summary = [['Сводка (лист · валюта)', 'Строк', 'Сумма договоров', 'Оплачено', 'Остаток']]
    .concat(Object.keys(sum).sort().map(k => sum[k]));
  const info = [['Проверено: ' + new Date().toLocaleString('ru-RU') +
    '. Строк: ' + rows.length +
    '. Новых сделок: ' + rows.filter(r => !r.deal).length +
    '. С вопросами к данным: ' + rows.filter(r => r.data.length).length +
    (meta.problems.length ? '. Проблемы настройки: ' + meta.problems.join('; ') : '') +
    (meta.notes.length ? '. Заметки: ' + meta.notes.join('; ') : '')]];

  sh.getRange(1, 1).setValue(info[0][0]).setFontWeight('bold');
  sh.getRange(3, 1, summary.length, 5).setValues(summary);
  sh.getRange(3, 1, 1, 5).setFontWeight('bold');
  const top = summary.length + 5;
  sh.getRange(top, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (out.length) sh.getRange(top + 1, 1, out.length, head.length).setValues(out);
  sh.setFrozenRows(top);
}

function writeChecklist_(rows) {
  const ss = SpreadsheetApp.openById(sheetId_());
  const sh = ss.getSheetByName('Чек-лист для Гулим') || ss.insertSheet('Чек-лист для Гулим');
  // Ответы Гулим не теряем при перезапуске: запоминаем их по листу и ФИО.
  const answers = {};
  sh.getDataRange().getDisplayValues().slice(1).forEach(x => { if (x[4]) answers[x[0] + '|' + x[2]] = x[4]; });
  sh.clear();
  sh.getRange(2, 5, Math.max(sh.getMaxRows() - 1, 1), 1).clearDataValidations();   // старые списки не копим
  const head = ['Лист', 'Строка', 'ФИО', 'Что не так', 'Ответ / что исправила'];
  const list = rows.filter(r => r.data.length);
  const out = list.map(r => [r.sheet, r.line, r.fio, r.data.join('\n'), answers[r.sheet + '|' + r.fio] || '']);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (out.length) {
    sh.getRange(2, 1, out.length, head.length).setValues(out).setWrap(true);
    // Колонка D — текст со ссылками: номера сделок-кандидатов ведут в Битрикс.
    sh.getRange(2, 4, out.length, 1).setRichTextValues(list.map(r => [checklistCell_(r)]));
    // Колонка E — выпадающий список (вписать своё тоже можно).
    sh.getRange(2, 5, out.length, 1).setDataValidations(list.map(r => [answerRule_(r)]));
  }
  sh.setColumnWidth(4, 520);
  sh.setFrozenRows(1);
}

// Список для колонки E: у строки с вопросом про оплату семинара — четыре варианта, у остальных — только «пропустить».
// setAllowInvalid(true): список не «строгий» — номер сделки, «та же», «новая», «нет — создать», сумму можно вписать как раньше.
function answerRule_(row) {
  const options = row.data.indexOf(PAID_QUESTION) >= 0 ? PAID_ANSWERS : [ANSWER_SKIP];
  return SpreadsheetApp.newDataValidation().requireValueInList(options, true).setAllowInvalid(true)
    .setHelpText('Выбери из списка или впиши своё: номер сделки, «та же», «новая», «нет — создать», сумму.').build();
}

// Ячейка «Что не так»: все вопросы по строке, а в вопросе про несколько сделок номера — ссылки на сделки.
function checklistCell_(row) {
  const text = row.data.join('\n');
  const cell = SpreadsheetApp.newRichTextValue().setText(text);
  const at = row.dealLinks ? row.data.indexOf(row.dealQ) : -1;
  if (at >= 0) {
    const shift = row.data.slice(0, at).reduce((s, q) => s + q.length + 1, 0);   // +1 — перенос строки
    row.dealLinks.forEach(l => cell.setLinkUrl(shift + l.start, shift + l.end, l.url));
  }
  return cell.build();
}

// ===================== БОЕВОЙ ПЕРЕНОС =====================
//
// liveRun берёт тот же план, что dryRun, и ответы Гулим из «Чек-листа для Гулим» (колонка E):
//   число — номер сделки; «та же» — найденная сделка; «новая» — старую не трогать, создать новую;
//   «нет — создать» — создать сделку (и контакт, если его нет);
//   «Не знаю — пропустить», «не помню», «спросить у СБ» и т. п. (см. SKIP_WORDS), а на вопрос про оплату ещё
//   «Не пришёл» и «Не пришёл, сделали возврат» — пропуск: строка не переносится и лимит не тратит;
//   «Оплатил на месте» и любой другой текст — ждёт ручного разбора.
// Всё, что сделано, пишется в лист «Журнал переноса». Успешные строки второй раз не обрабатываются.

const LIVE_DRY = true;    // true — в Битриксе НИЧЕГО не меняется, в журнале только «ПРОБНО: было бы сделано…»
const LIVE_LIMIT = 3;     // сколько строк обрабатывать за один запуск
const JOURNAL_SHEET = 'Журнал переноса';
const INVOICE_TITLE = 'Оплата до переноса';

function liveRun() {
  const answers = readAnswers_();
  const journal = readJournal_();
  const plan = buildPlan_();
  const meta = plan.meta;
  if (meta.problems.length) {
    journal_(null, '', 'Остановлено, ничего не записано', 'Проблемы настройки Битрикса: ' + meta.problems.join('; '), 'ошибка');
    Logger.log('Остановлено: ' + meta.problems.join('; '));
    return;
  }

  const count = {};
  plan.rows.forEach(r => count[key_(r)] = (count[key_(r)] || 0) + 1);

  // Одна сделка — одна строка. Какую сделку возьмёт строка: из прошлого запуска,
  // номер из ответа Гулим или найденную («та же» / без ответа).
  const dealOf = r => {
    const k = key_(r), a = norm_(answers[k]);
    if ((journal[k] || {}).dealId) return String(journal[k].dealId);
    if (/^\d+$/.test(a)) return a;
    if (r.deal && (!a || a === norm_('та же'))) return String(r.deal.ID);
    return '';
  };
  const usedBy = {};
  plan.rows.forEach(r => { const d = dealOf(r); if (d) (usedBy[d] = usedBy[d] || []).push(r); });
  const clash_ = r => {
    const d = dealOf(r);
    if (!d || usedBy[d].length < 2) return '';
    return 'сделка ' + d + ' указана и у других строк: ' + usedBy[d].filter(x => x !== r)
      .map(x => '«' + x.sheet + '», строка ' + x.line + ' (' + x.fio + ')').join('; ');
  };
  // Успешные пропускаем. Упавшие в прошлый раз — в конец очереди, чтобы не занимали весь лимит.
  const rows = plan.rows.filter(r => !(journal[key_(r)] || {}).success);
  const failed = r => (journal[key_(r)] || {}).error ? 1 : 0;
  rows.sort((a, b) => failed(a) - failed(b));

  const stat = { done: 0, errors: 0, wait: 0, manual: 0, skip: 0 };
  for (let i = 0; i < rows.length && stat.done < LIVE_LIMIT; i++) {
    const row = rows[i], k = key_(row), past = journal[k] || {};
    let p;
    const clash = clash_(row);
    if (clash) p = { manual: clash };
    else {
      try { p = prepare_(row, meta, answers[k], count[k], past); }
      catch (e) { p = { manual: 'не удалось проверить строку: ' + e.message }; }
    }

    if (p.wait) { stat.wait++; continue; }
    if (p.skip) {   // Гулим велела пропустить: ничего не пишем, лимит не тратим, в журнал — один раз на причину
      stat.skip++;
      if (past.last !== 'пропущено по ответу: ' + p.skip + '|') journal_(row, '', 'пропущено по ответу: ' + p.skip, '', 'пропуск');
      continue;
    }
    if (p.manual) {
      stat.manual++;
      if (past.last !== 'ждёт ручного разбора|' + p.manual) journal_(row, '', 'ждёт ручного разбора', p.manual, 'пропуск');
      continue;
    }

    stat.done++;
    const log = [], ctx = { dealId: p.dealId || '' };
    const prefix = LIVE_DRY ? 'ПРОБНО: было бы сделано — ' : '';
    try {
      processRow_(row, p, meta, log, ctx);
      journal_(row, ctx.dealId, prefix + log.join('; '), '', LIVE_DRY ? 'пробно' : 'успех');
    } catch (e) {
      stat.errors++;
      journal_(row, ctx.dealId, prefix + log.join('; '), e.message, 'ошибка');
    }
  }
  Logger.log((LIVE_DRY ? 'ПРОБНЫЙ режим. ' : '') + 'Обработано строк: ' + stat.done + ' (с ошибкой: ' + stat.errors +
    '). Ждут ответа Гулим: ' + stat.wait + '. Пропущено по ответу: ' + stat.skip +
    '. Ждут ручного разбора: ' + stat.manual + '. Смотри «' + JOURNAL_SHEET + '».');
}

// Решает, что делать со строкой. Только читает Битрикс.
// Возвращает { wait } — нет ответа Гулим; { skip: причина } — Гулим велела пропустить, не переносим;
// { manual: причина } — ждёт ручного разбора; или готовый план записи.
function prepare_(row, meta, ans, dupCount, past) {
  if (dupCount > 1) return { manual: 'в листе несколько строк с этим ФИО — ответ нельзя отнести к одной из них' };
  const a = norm_(ans);
  let mode, dealId = '';
  if (past.dealId) { mode = 'update'; dealId = past.dealId; }   // сделку уже создал прошлый запуск
  else if (!ans) {
    if (row.data.length) return { wait: true };
    mode = 'update'; dealId = row.deal.ID;
  }
  else if (isSkip_(ans)) return { skip: 'ответ «' + ans + '» — пропуск, не переносим' };
  else if (ANSWER_NO_SHOW.some(x => a === norm_(x))) {
    if (row.data.indexOf(PAID_QUESTION) < 0) return { manual: 'ответ «' + ans + '», но вопроса про оплату у строки нет' };
    return { skip: 'ответ «' + ans + '» — денег нет, переносить нечего' };
  }
  else if (a === norm_(ANSWER_PAID)) {
    return { manual: 'оплатил на месте: впиши сумму в колонку «Оплачено» исходной таблицы и запусти dryRun заново' };
  }
  else if (/^\d+$/.test(a)) { mode = 'update'; dealId = a; }
  else if (a === norm_('та же')) {
    if (!row.deal) return { manual: 'ответ «та же», но сделка не найдена' };
    mode = 'update'; dealId = row.deal.ID;
  }
  else if (a === norm_('нет — создать')) mode = 'create';
  else if (a === norm_('новая')) {
    if (!row.deal) return { manual: 'ответ «новая», но старой сделки нет — нужен номер или «нет — создать»' };
    mode = 'new';
  }
  else return { manual: 'ответ «' + ans + '»' };

  // Ответ Гулим снимает только вопрос про сделку. Остальные вопросы — сначала исправить в таблице.
  const otherQ = row.data.filter(q => q !== row.dealQ);
  if (otherQ.length) return { manual: 'остались вопросы к данным: ' + otherQ.join('; ') };

  const p = { mode: mode, dealId: dealId, contactId: '', userId: '', hasInvoice: false };
  if (mode === 'update') {
    const deal = call_('crm.deal.get', { id: dealId }).result;
    if (String(deal.CATEGORY_ID) !== String(DEAL_CATEGORY_ID)) return { manual: 'сделка ' + dealId + ' не в воронке PSP' };
    if (!row.deal || String(row.deal.ID) !== String(deal.ID)) replan_(row, meta, deal);
    p.contactId = deal.CONTACT_ID || '';
    p.hasInvoice = hasInvoice_(deal.ID);
  } else {
    if (mode === 'new') p.contactId = call_('crm.deal.get', { id: row.deal.ID }).result.CONTACT_ID || '';
    else if (row.contactIds.length > 1) return { manual: 'найдено несколько контактов (' + row.contactIds.join(', ') + ') — какой взять?' };
    else p.contactId = row.contactIds[0] || '';
    replan_(row, meta, null);
    const user = meta.users.find(u => u.name === row.userName);
    if (!user) return { manual: 'не нашёл ответственного в Битриксе' };
    p.userId = user.id;
  }

  if (!row.progId) return { manual: 'программы «' + row.program + '» нет в списке Битрикса' };
  if (row.stageNew && !meta.stageId[norm_(row.stageNew)]) return { manual: 'в Битриксе нет стадии «' + row.stageNew + '»' };
  p.needInvoice = row.transfer > 0 && !p.hasInvoice;
  p.invoiceDate = row.contractDate || (row.program === SEMINAR_PROGRAM ? eventStart_(row.stream) : '');
  if (p.needInvoice && !p.invoiceDate) return { manual: 'нет даты договора' };
  try { dealFields_(row, meta); } catch (e) { return { manual: e.message }; }
  return p;
}

// Пересчитать план строки для другой сделки (или для новой, если deal = null).
function replan_(row, meta, deal) {
  row.deal = deal;
  row.manyDeals = null;   // Гулим уже ответила, какая сделка — вопрос «несколько сделок» снят
  row.data = [];
  row.tech = [];
  planRow_(row, meta, deal ? paidInvoices_([deal.ID]) : {});
}

// Все записи в Битрикс по одной строке. Порядок: поток → контакт → сделка → счёт → стадия.
function processRow_(row, p, meta, log, ctx) {
  if (row.stream && !row.streamId) row.streamId = ensureStream_(meta, row.stream, log);
  const d = dealFields_(row, meta);
  let dealId = p.dealId;

  if (p.mode === 'update') {
    write_('crm.deal.update', { id: dealId, fields: d.fields }, 'сделка ' + dealId + ': ' + d.text, log);
  } else {
    let contactId = p.contactId;
    if (!contactId) {
      const w = row.fio.replace(/\(.*?\)/g, ' ').replace(/\+/g, ' ').trim().split(/\s+/);
      const cf = { LAST_NAME: w[0], NAME: w[1] || '', SECOND_NAME: w.slice(2).join(' '), ASSIGNED_BY_ID: p.userId };
      if (row.phone) cf.PHONE = [{ VALUE: '+' + row.phone, VALUE_TYPE: 'WORK' }];
      contactId = write_('crm.contact.add', { fields: cf },
        'создан контакт «' + row.fio + '»' + (row.phone ? ', тел. +' + row.phone : ''), log);
    } else {
      log.push('контакт ' + contactId);
    }
    const fields = Object.assign({ TITLE: row.fio + ' · ' + (row.stream || row.program), CATEGORY_ID: DEAL_CATEGORY_ID,
      CONTACT_ID: contactId, ASSIGNED_BY_ID: p.userId }, d.fields);
    dealId = write_('crm.deal.add', { fields: fields }, 'создана сделка (ответственный ' + row.userName + '): ' + d.text, log);
    p.contactId = contactId;
    // Номер новой сделки — в журнал сразу, чтобы при повторе после ошибки не создать вторую.
    if (!LIVE_DRY) journal_(row, dealId, 'создана сделка ' + dealId, '', 'создана');
  }
  ctx.dealId = dealId;

  if (p.needInvoice) {
    const inv = { title: INVOICE_TITLE, opportunity: row.transfer, currencyId: row.currency, parentId2: dealId,
      categoryId: meta.invoiceCategory, stageId: meta.invoicePaidStage, begindate: p.invoiceDate };
    if (p.contactId && !LIVE_DRY) inv.contactId = p.contactId;
    write_('crm.item.add', { entityTypeId: INVOICE_TYPE_ID, fields: inv },
      'счёт «' + INVOICE_TITLE + '» ' + row.transfer + ' ' + row.currency + ' от ' + p.invoiceDate + ' (оплачен)', log);
  }
  if (row.stageNew) {
    write_('crm.deal.update', { id: dealId, fields: { STAGE_ID: meta.stageId[norm_(row.stageNew)] } },
      'стадия «' + row.stageNew + '»', log);
  }
}

// Единственное место, где liveRun пишет в Битрикс. В пробном режиме — только запись в лог.
function write_(method, params, what, log) {
  if (LIVE_DRY) { log.push(what); return 'пробно'; }
  const res = call_(method, params).result;
  log.push(what);
  return (res && res.item) ? res.item.id : res;
}

// Поля сделки из плана. Пустые значения не передаём — чтобы не стереть то, что уже есть в Битриксе.
function dealFields_(row, meta) {
  const f = { OPPORTUNITY: row.sum, CURRENCY_ID: row.currency, IS_MANUAL_OPPORTUNITY: 'Y' };
  const text = ['сумма ' + row.sum + ' ' + row.currency];
  const put = (key, value, shown) => {
    if (value === '' || value === null || value === undefined) return;
    const m = meta.fields[key];
    let v = value;
    if (key !== 'program' && key !== 'stream') {   // у программы и потока уже ID значения списка
      if (m.type === 'enumeration') {
        v = itemId_(m, String(value));
        if (!v) throw new Error('в списке «' + FIELD_LABELS[key] + '» нет значения «' + value + '»');
      } else if (m.type === 'money') v = value + '|' + row.currency;
      else if (m.type === 'double' || m.type === 'integer') v = Number(value);
    }
    f[m.code] = m.multiple ? [v] : v;
    text.push(FIELD_LABELS[key] + ': ' + (shown !== undefined ? shown : value));
  };
  put('program', row.progId, row.program);
  put('stream', row.streamId, row.stream);
  put('discount', row.discount);
  put('payee', row.payee);
  put('contractNo', row.contractNo);
  put('contractDate', row.contractDate);
  put('paidTotal', row.paid, row.paid + ' ' + row.currency);
  put('balance', row.balance, row.balance + ' ' + row.currency);
  return { fields: f, text: text.join(', ') };
}

// Добавить значение в список «Поток / мероприятие», не удаляя существующие.
function ensureStream_(meta, value, log) {
  const f = meta.fields.stream;
  const found = itemId_(f, value);
  if (found) return found;
  if (LIVE_DRY) {
    log.push('добавить в список «' + FIELD_LABELS.stream + '» значение «' + value + '»');
    f.items.push({ ID: 'пробно', VALUE: value });
    return 'пробно';
  }
  const uf = (call_('crm.deal.userfield.list', { filter: { FIELD_NAME: f.code } }).result || [])[0];
  if (!uf) throw new Error('не нашёл настройки поля ' + f.code);
  const before = call_('crm.deal.userfield.get', { id: uf.ID }).result.LIST || [];
  const list = before.map(it => ({ ID: it.ID, VALUE: it.VALUE, SORT: it.SORT, DEF: it.DEF }));
  const maxSort = before.reduce((s, it) => Math.max(s, Number(it.SORT) || 0), 0);
  list.push({ VALUE: value, SORT: maxSort + 10 });
  call_('crm.deal.userfield.update', { id: uf.ID, fields: { LIST: list } });
  const after = call_('crm.deal.userfield.get', { id: uf.ID }).result.LIST || [];
  if (after.length <= before.length) throw new Error('значение «' + value + '» не добавилось в список потока');
  const added = after.find(it => norm_(it.VALUE) === norm_(value));
  if (!added) throw new Error('не нашёл добавленное значение «' + value + '» в списке потока');
  f.items = after.map(it => ({ ID: it.ID, VALUE: it.VALUE }));
  log.push('в список «' + FIELD_LABELS.stream + '» добавлено «' + value + '»');
  return added.ID;
}

function hasInvoice_(dealId) {
  const res = call_('crm.item.list', { entityTypeId: INVOICE_TYPE_ID, filter: { parentId2: dealId },
    select: ['id', 'title'] }).result;
  return ((res && res.items) || []).some(it => norm_(it.title) === norm_(INVOICE_TITLE));
}

function key_(row) {
  return row.sheet + '|' + row.fio;
}

// Ответы Гулим: лист|ФИО → текст из колонки E.
function readAnswers_() {
  const sh = SpreadsheetApp.openById(sheetId_()).getSheetByName('Чек-лист для Гулим');
  const out = {};
  if (!sh) return out;
  sh.getDataRange().getDisplayValues().slice(1).forEach(x => {
    const a = String(x[4] || '').trim();
    if (a) out[x[0] + '|' + x[2]] = a;
  });
  return out;
}

function journalSheet_() {
  const ss = SpreadsheetApp.openById(sheetId_());
  let sh = ss.getSheetByName(JOURNAL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(JOURNAL_SHEET);
    sh.appendRow(['Время', 'Лист', 'ФИО', 'Сделка', 'Что сделано', 'Ошибка', 'Итог']);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Журнал прошлых запусков: лист|ФИО → { success, error (последний итог — ошибка),
// dealId (сделка, созданная liveRun), last (последняя запись) }.
function readJournal_() {
  const out = {};
  journalSheet_().getDataRange().getDisplayValues().slice(1).forEach(x => {
    const o = out[x[1] + '|' + x[2]] = out[x[1] + '|' + x[2]] || {};
    if (x[6] === 'успех') o.success = true;
    if (x[6] === 'успех' || x[6] === 'ошибка' || x[6] === 'пробно') o.error = (x[6] === 'ошибка');
    if (x[6] === 'создана' && /^\d+$/.test(x[3])) o.dealId = x[3];   // сделку создал сам liveRun
    o.last = x[4] + '|' + x[5];
  });
  return out;
}

function journal_(row, dealId, what, error, result) {
  journalSheet_().appendRow([Utilities.formatDate(new Date(), 'Asia/Almaty', 'dd.MM.yyyy HH:mm:ss'),
    row ? row.sheet : '', row ? row.fio : '', dealId || '', what, error || '', result]);
}

// Дата начала семинара из «… · 19–23.10.2026» → 2026-10-19 (и «30.09–02.10.2026» → 2026-09-30).
function eventStart_(event) {
  const s = String(event || '');
  const pad = n => ('0' + n).slice(-2);
  let m = s.match(/(\d{1,2})(?:\.(\d{1,2}))?\s*[–—-]\s*\d{1,2}\.(\d{1,2})\.(\d{4})/);
  if (m) return m[4] + '-' + pad(m[2] || m[3]) + '-' + pad(m[1]);
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : '';
}

// ===================== ПОМОЩНИКИ =====================

// Лист по имени без учёта лишних пробелов в названии.
function sheet_(ss, name) {
  const sh = ss.getSheets().find(s => s.getName().trim() === name.trim());
  if (!sh) throw new Error('Нет листа «' + name + '»');
  return sh;
}

// Адрес портала Битрикса (https://…) — берём из вебхука, сам вебхук никуда не пишем.
function portal_() {
  return webhook_().match(/^https:\/\/[^/]+/)[0];
}

// Ссылка на сделку в Битриксе.
function dealUrl_(id) {
  return portal_() + '/crm/deal/details/' + id + '/';
}

// Вопрос «какая из сделок настоящая» списком: по строке на сделку — номер, стадия, дата создания, сумма.
// links — где в тексте стоят номера (начало, конец, адрес сделки в Битриксе): из них в чек-листе делаются ссылки.
function manyDealsQuestion_(deals, meta) {
  let text = 'Несколько сделок — какая настоящая? Впиши её номер (или «нет — создать»):';
  const links = [];
  deals.forEach(d => {
    const id = String(d.ID);
    text += '\n• ';
    links.push({ start: text.length, end: text.length + id.length, url: dealUrl_(id) });
    text += id + ' — ' + dealInfo_(d, meta);
  });
  return { text: text, links: links };
}

// Коротко про сделку: стадия, дата создания, сумма.
function dealInfo_(deal, meta) {
  const stage = meta.stageName[deal.STAGE_ID] || deal.STAGE_ID;
  const created = String(deal.DATE_CREATE || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const sum = Number(deal.OPPORTUNITY);
  return 'стадия «' + stage + '», ' +
    (created ? 'создана ' + created[3] + '.' + created[2] + '.' + created[1] : 'дата создания неизвестна') + ', ' +
    (sum ? 'сумма ' + sumText_(sum) + (deal.CURRENCY_ID ? ' ' + deal.CURRENCY_ID : '') : 'сумма не указана');
}

// 450000 → «450 000», 1234.5 → «1 234,50» (пробел неразрывный, чтобы сумма не рвалась на две строки).
function sumText_(n) {
  const parts = n.toFixed(2).split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (parts[1] === '00' ? '' : ',' + parts[1]);
}

function header_(v) {
  for (let r = 0; r < Math.min(v.length, 10); r++) {
    if (v[r].some(c => String(c).trim() === 'ФИО')) {
      const map = {};
      v[r].forEach((c, i) => { const k = String(c).trim(); if (k && !(k in map)) map[k] = i; });
      return { row: r, map: map };
    }
  }
  throw new Error('Не нашёл строку заголовков (с «ФИО»)');
}

function cell_(x, h, names) {
  for (let i = 0; i < names.length; i++) {
    if (names[i] in h.map) return String(x[h.map[names[i]]] || '').trim();
  }
  return '';
}

function money_(text, defCur) {
  const t = String(text || '').trim();
  if (!t) return { text: '', amount: 0, currency: null, ok: true };
  let currency = null;
  if (/руб|р\.|₽/i.test(t)) currency = 'RUB';
  else if (/\$|usd/i.test(t)) currency = 'USD';
  else if (/сом/i.test(t)) currency = 'KGS';
  const rest = t.replace(/руб\.?|р\.|₽|\$|usd|kzt|тенге|тг|сом/gi, '');
  const num = rest.replace(/[\s\u00a0]/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(num)) return { text: t, amount: 0, currency: currency, ok: false };
  return { text: t, amount: parseFloat(num), currency: currency || defCur || null, ok: true };
}

function percent_(text) {
  const m = String(text || '').match(/^(\d{1,3})\s*%$/);
  return m ? Number(m[1]) : '';
}

function phone_(text) {
  let d = String(text || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length >= 10 && d.length <= 13 ? d : '';
}

function date_(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}

function eventEnd_(event) {
  const m = String(event || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s*$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
}

function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyy-MM-dd');
}

function norm_(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s\-–—·.,()]/g, '');
}

// Ответ Гулим — пропуск («Не знаю — пропустить», «не помню», «спросить у СБ»)? Такую строку не переносим.
function isSkip_(ans) {
  const a = norm_(ans);
  return !!a && SKIP_WORDS.some(w => a.indexOf(norm_(w)) >= 0);
}

// Значение списка Битрикса по тексту: точное совпадение, иначе единственное «содержит».
function itemId_(field, value) {
  if (!value || !field) return null;
  const v = norm_(value);
  const exact = field.items.filter(it => norm_(it.VALUE) === v);
  if (exact.length === 1) return exact[0].ID;
  const part = field.items.filter(it => norm_(it.VALUE).indexOf(v) >= 0 || v.indexOf(norm_(it.VALUE)) >= 0);
  return part.length === 1 ? part[0].ID : null;
}

// ===================== REST =====================

function webhook_() {
  const url = PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK');
  if (!url) throw new Error('Добавь свойство скрипта BITRIX_WEBHOOK (адрес вебхука Битрикса)');
  return url.replace(/\/?$/, '/');
}

function call_(method, params) {
  const resp = UrlFetchApp.fetch(webhook_() + method + '.json', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(params || {}), muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());
  if (data.error) throw new Error(method + ': ' + data.error + ' ' + (data.error_description || ''));
  return data;
}

function callAll_(method, params) {
  let start = 0, all = [];
  while (true) {
    const data = call_(method, Object.assign({}, params, { start: start }));
    all = all.concat(data.result || []);
    if (data.next === undefined) break;
    start = data.next;
    Utilities.sleep(300);
  }
  return all;
}

function batch_(cmds) {
  const keys = Object.keys(cmds), result = {}, errors = {};
  for (let i = 0; i < keys.length; i += 50) {
    const cmd = {};
    keys.slice(i, i + 50).forEach(k => cmd[k] = cmds[k]);
    const data = call_('batch', { halt: 0, cmd: cmd });
    Object.assign(result, data.result.result || {});
    Object.assign(errors, data.result.result_error || {});
    Utilities.sleep(500);
  }
  const errKeys = Object.keys(errors);
  if (errKeys.length) Logger.log('Ошибки batch (' + errKeys.length + '): ' + JSON.stringify(errors).slice(0, 1000));
  return { result: result, errors: errors };
}

function q_(obj, prefix) {
  return Object.keys(obj).map(k => {
    const v = obj[k];
    const key = prefix ? prefix + '[' + k + ']' : k;
    return (v !== null && typeof v === 'object') ? q_(v, key)
      : encodeURIComponent(key) + '=' + encodeURIComponent(v);
  }).filter(String).join('&');
}

// ===================== ДОБАВЛЕНО В v2 =====================

// Телефоны для строк без телефона — из листа «ПП в РФ», по фамилии и имени.
function fillPhones_(rows) {
  const need = rows.filter(r => !r.phone);
  if (!need.length) return;
  const sh = SpreadsheetApp.openById(sheetId_()).getSheets().find(s => s.getName().trim() === PHONEBOOK_SHEET);
  if (!sh) return;
  const v = sh.getDataRange().getDisplayValues();
  const h = header_(v);
  const book = {};
  for (let r = h.row + 1; r < v.length; r++) {
    const fio = cell_(v[r], h, ['ФИО']);
    const ph = phoneIn_(cell_(v[r], h, ['Эл.почта/Телефон']));
    if (fio && ph) book[nameKey_(fio)] = ph;
  }
  need.forEach(r => {
    const ph = book[nameKey_(r.fio)];
    if (ph) { r.phone = ph; r.tech.push('Телефон взят из «' + PHONEBOOK_SHEET + '»'); }
  });
}

// Ищем контакт по фамилии и имени ВСЕГДА, даже если по телефону уже нашли:
// у клиента бывает второй контакт без телефона (пришёл из открытой линии / Instagram).
function findContactsByName_(rows) {
  const sel = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'];
  const cmds = {};
  rows.forEach((row, i) => {
    const words = nameKey_(row.fio).split(/[\s\-]+/).filter(Boolean);
    if (words.length < 2) return;
    cmds['l' + i] = 'crm.contact.list?' + q_({ filter: { '%LAST_NAME': words[0] }, select: sel });
    cmds['n' + i] = 'crm.contact.list?' + q_({ filter: { '%NAME': words[0] }, select: sel });
  });
  const res = batch_(cmds);
  rows.forEach((row, i) => {
    if (!cmds['l' + i]) return;
    const words = nameKey_(row.fio).split(/[\s\-]+/).filter(Boolean);
    // Добавляем к найденным по телефону, не заменяя их.
    [].concat(res.result['l' + i] || [], res.result['n' + i] || []).forEach(c => {
      // Сравниваем целые слова: «пак» не должен совпасть с «Пакизат», «денис» — с «Денисов».
      // Дефис тоже разделитель: «Иванова-Петрова» находится и по «Иванова», и по «Петрова».
      const full = [c.LAST_NAME, c.NAME, c.SECOND_NAME].join(' ').toLowerCase().replace(/ё/g, 'е')
        .split(/[\s\-]+/).filter(Boolean);
      const id = String(c.ID);
      if (words.every(w => full.indexOf(w) >= 0) && row.contactIds.indexOf(id) < 0) {
        row.contactIds.push(id);
        row.contactSrc[id] = 'name';
      }
    });
  });
}

// «Фамилия Имя (ММА)» → «фамилия имя»: фамилия и имя без пометок.
function nameKey_(fio) {
  return String(fio || '').replace(/\(.*?\)/g, ' ').replace(/\+/g, ' ')
    .toLowerCase().replace(/ё/g, 'е').split(/[\s\/]+/).filter(Boolean).slice(0, 2).join(' ');
}

// Телефон из ячейки, где он перемешан с почтой: «8-900-000-00-00 / name@example.com».
function phoneIn_(text) {
  const runs = String(text || '').match(/\+?\d[\d \t()\-]{8,}\d/g) || [];
  for (let i = 0; i < runs.length; i++) { const p = phone_(runs[i]); if (p) return p; }
  return '';
}
// ===================== ДИАГНОСТИКА =====================

// Только чтение: показывает в листе «Диагностика», как устроены сделки и их контакты.
const DIAG_DEALS = [21630, 24672, 21688];

function diagnoseDeals() {
  const out = [['Сделка', 'Что', 'Значение']];
  let cats = {};
  try {
    (call_('crm.category.list', { entityTypeId: 2 }).result.categories || [])
      .forEach(c => cats[String(c.id)] = c.name);
  } catch (e) { out.push(['', 'Воронки', 'не удалось получить: ' + e.message]); }
  cats['0'] = cats['0'] || 'Общая (ID 0)';

  DIAG_DEALS.forEach(id => {
    let d;
    try { d = call_('crm.deal.get', { id: id }).result; }
    catch (e) { out.push([id, 'ОШИБКА', e.message]); return; }
    out.push([id, 'TITLE', d.TITLE]);
    out.push([id, 'CATEGORY_ID', d.CATEGORY_ID + ' — ' + (cats[String(d.CATEGORY_ID)] || '?')]);
    out.push([id, 'STAGE_ID', d.STAGE_ID]);
    out.push([id, 'CLOSED', d.CLOSED]);
    out.push([id, 'DATE_CREATE', d.DATE_CREATE]);
    out.push([id, 'OPPORTUNITY', d.OPPORTUNITY + ' ' + d.CURRENCY_ID]);
    out.push([id, 'CONTACT_ID (основной)', d.CONTACT_ID]);

    const links = call_('crm.deal.contact.items.get', { id: id }).result || [];
    out.push([id, 'Привязанные контакты', links.map(l => l.CONTACT_ID + (l.IS_PRIMARY === 'Y' ? ' (основной)' : '')).join(', ') || '— нет —']);

    links.forEach(l => {
      const cid = l.CONTACT_ID;
      const c = call_('crm.contact.get', { id: cid }).result;
      const phones = (c.PHONE || []).map(p => p.VALUE);
      out.push([id, '  контакт ' + cid + ': имя', [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ')]);
      out.push([id, '  контакт ' + cid + ': телефоны', phones.join(', ') || '— нет —']);

      // Все сделки этого контакта во всех воронках.
      const deals = callAll_('crm.deal.list', { filter: { CONTACT_ID: cid },
        select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY'], order: { ID: 'ASC' } });
      out.push([id, '  контакт ' + cid + ': сделки (все воронки)', deals.map(x =>
        x.ID + ' [воронка ' + x.CATEGORY_ID + ', ' + x.STAGE_ID + ', ' + x.OPPORTUNITY + '] ' + x.TITLE).join('\n') || '— нет —']);

      // Что находит по телефону тот же поиск, что у скрипта.
      phones.forEach(ph => {
        const digits = String(ph).replace(/\D/g, '');
        let found = [];
        try {
          const r = call_('crm.duplicate.findbycomm', { type: 'PHONE', values: ['+' + digits, digits], entity_type: 'CONTACT' }).result;
          found = (r && r.CONTACT) || [];
        } catch (e) { found = ['ошибка: ' + e.message]; }
        out.push([id, '  поиск по телефону ' + ph, found.join(', ') || '— ничего —']);
      });
    });
    out.push(['', '', '']);
  });

  const ss = SpreadsheetApp.openById(sheetId_());
  const sh = ss.getSheetByName('Диагностика') || ss.insertSheet('Диагностика');
  sh.clear();
  sh.getRange(1, 1, out.length, 3).setValues(out).setVerticalAlignment('top');
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 600);
  sh.getRange(1, 3, out.length, 1).setWrap(true);
}

// Только чтение: какие поля Битрикса подходят под названия из FIELD_LABELS и какое из них реально заполняют.
function diagnoseFields() {
  const fields = call_('crm.deal.fields').result;
  const out = [['Название в скрипте', 'Код поля', 'Тип / множ.', 'Подписи (форма | список | фильтр)',
                'Варианты списка', 'Заполнено в последних 200 сделках PSP', 'Значения в сделках ' + DIAG_DEALS.join(', ')]];

  const found = [];   // { key, label, code }
  Object.keys(FIELD_LABELS).forEach(key => {
    const label = norm_(FIELD_LABELS[key]);
    const codes = Object.keys(fields).filter(code => code.indexOf('UF_CRM_') === 0 &&
      [fields[code].formLabel, fields[code].listLabel, fields[code].filterLabel].some(l => norm_(l) === label));
    if (!codes.length) found.push({ key: key, code: '' });
    codes.forEach(code => found.push({ key: key, code: code }));
  });
  const codes = found.filter(f => f.code).map(f => f.code);

  // Последние 200 сделок воронки PSP — сколько заполнено в каждом поле.
  let recent = [];
  for (let start = 0; start < 200; start += 50) {
    const data = call_('crm.deal.list', { filter: { CATEGORY_ID: DEAL_CATEGORY_ID },
      select: ['ID'].concat(codes), order: { ID: 'DESC' }, start: start });
    recent = recent.concat(data.result || []);
    if (data.next === undefined) break;
  }
  const filled = v => v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && !v.length);

  const diag = DIAG_DEALS.map(id => { try { return call_('crm.deal.get', { id: id }).result; } catch (e) { return { ID: id }; } });

  found.forEach(f => {
    if (!f.code) { out.push([FIELD_LABELS[f.key], '— не найдено —', '', '', '', '', '']); return; }
    const fd = fields[f.code];
    const items = (fd.items || []).map(it => it.ID + ': ' + it.VALUE).join('\n');
    const n = recent.filter(d => filled(d[f.code])).length;
    const vals = diag.map(d => d.ID + ' → ' + (filled(d[f.code]) ? JSON.stringify(d[f.code]) : '—')).join('\n');
    out.push([FIELD_LABELS[f.key], f.code, fd.type + (fd.isMultiple ? ' / да' : ' / нет'),
      [fd.formLabel, fd.listLabel, fd.filterLabel].join(' | '), items, n + ' из ' + recent.length, vals]);
  });

  const ss = SpreadsheetApp.openById(sheetId_());
  const sh = ss.getSheetByName('Диагностика полей') || ss.insertSheet('Диагностика полей');
  sh.clear();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out).setVerticalAlignment('top').setWrap(true);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

// Только чтение: в каких сделках (все воронки) заполнено поле-двойник «Программа PSP».
// Настоящее поле считается тем же запросом — чтобы убедиться, что фильтр вообще работает.
function checkDuplicateField() {
  const check = [['двойник', 'UF_CRM_6AF61DDE7C017'], ['настоящее (для проверки фильтра)', FIELD_CODES.program]];
  const out = [['Поле', 'Код', 'Сделок с заполненным полем', 'По воронкам', 'Первые 50 сделок']];
  check.forEach(c => {
    const f = {}; f['>' + c[1]] = 0;   // значения списка — числа > 0, пустое поле не попадёт
    const deals = callAll_('crm.deal.list', { filter: f, select: ['ID', 'CATEGORY_ID', c[1]], order: { ID: 'ASC' } });
    const byCat = {};
    deals.forEach(d => byCat[d.CATEGORY_ID] = (byCat[d.CATEGORY_ID] || 0) + 1);
    out.push([c[0], c[1], deals.length,
      Object.keys(byCat).map(k => 'воронка ' + k + ': ' + byCat[k]).join('\n') || '—',
      deals.slice(0, 50).map(d => d.ID).join(', ') || '—']);
  });
  const ss = SpreadsheetApp.openById(sheetId_());
  const sh = ss.getSheetByName('Проверка двойника') || ss.insertSheet('Проверка двойника');
  sh.clear();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out).setVerticalAlignment('top').setWrap(true);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
}
