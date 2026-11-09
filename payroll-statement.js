(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PayrollStatement = api;
    root.openPayrollStatement = api.open;
    root.loadPayrollStatement = api.load;
    root.renderPayrollStatement = api.render;
    root.exportPayrollStatement = api.exportExcel;
    root.copyPayrollStatementSheets = api.copySheets;
    root.printPayrollStatement = api.print;
    root.clearPayrollStatement = api.clear;
  }
})(typeof window === 'object' ? window : globalThis, function (root) {
  'use strict';

  function qty(value) {
    var n = Number(value);
    if (value === null || value === '' || !Number.isSafeInteger(n) || n < 0) throw new Error('Некорректное количество в ведомости');
    return n;
  }
  function cents(value) {
    var match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) throw new Error('Некорректная расценка в ведомости');
    var n = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(n)) throw new Error('Сумма превышает допустимое значение');
    return n;
  }
  function safe(n) {
    if (!Number.isSafeInteger(n)) throw new Error('Сумма превышает допустимое значение');
    return n;
  }
  function money(n) { return (n / 100).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function html(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function date(value) { return value ? value.slice(8, 10) + '.' + value.slice(5, 7) + '.' + value.slice(0, 4) : 'Не указана'; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function compare(a, b) { return String(a).localeCompare(String(b), 'ru', { numeric: true }); }
  function compareDate(a, b) { return a && b ? compare(a, b) : a ? -1 : b ? 1 : 0; }

  // Group by the frozen rate as well: different historical rates must not merge.
  function build(operations, options) {
    options = options || {};
    if (options.cutFrom && options.cutTo && options.cutFrom > options.cutTo) throw new Error('Проверьте период кроя');
    var grouped = new Map(), seen = new Set();
    operations.forEach(function (op) {
      var id = JSON.stringify([op.packId, op.operationName]);
      if (seen.has(id)) throw new Error('Повторная операция: ' + op.packId + ' / ' + op.operationName);
      seen.add(id);
      if (!op.packId || !op.operationName || !op.model) throw new Error('Не заполнены данные паспорта или операции');
      var issued = qty(op.issuedQty), accepted = qty(op.acceptedQty), paid = qty(op.sewerPaidQty), price = cents(op.sewerPrice);
      if (paid > accepted) throw new Error('Оплаченное количество превышает принятое: ' + op.packId);
      var cut = op.cutDate ? String(op.cutDate).slice(0, 10) : '';
      if (cut && !/^\d{4}-\d{2}-\d{2}$/.test(cut)) throw new Error('Некорректная дата кроя: ' + op.packId);
      if (options.model && op.model !== options.model) return;
      if ((options.cutFrom && (!cut || cut < options.cutFrom)) || (options.cutTo && (!cut || cut > options.cutTo))) return;
      var key = JSON.stringify([op.model, cut, op.operationName, price]);
      var row = grouped.get(key);
      if (!row) {
        row = { model: op.model, cutDate: cut, operationName: op.operationName, priceCents: price,
          issuedQty: 0, acceptedQty: 0, paidQty: 0, unpaidQty: 0, amountCents: 0, details: [] };
        grouped.set(key, row);
      }
      row.issuedQty = safe(row.issuedQty + issued);
      row.acceptedQty = safe(row.acceptedQty + accepted);
      row.paidQty = safe(row.paidQty + paid);
      row.unpaidQty = safe(row.unpaidQty + accepted - paid);
      row.amountCents = safe(row.amountCents + safe((accepted - paid) * price));
      row.details.push({ packId: op.packId, passport: op.passport || '', issuedQty: issued, acceptedQty: accepted,
        paidQty: paid, unpaidQty: accepted - paid, amountCents: safe((accepted - paid) * price), packStatus: op.packStatus });
    });
    var rows = Array.from(grouped.values()).filter(function (row) { return options.mode === 'all' || row.unpaidQty > 0; });
    var sort = options.sort || 'cut_asc';
    rows.sort(function (a, b) {
      var primary = sort.indexOf('model') === 0 ? compare(a.model, b.model) : compareDate(a.cutDate, b.cutDate);
      // Missing dates stay at the bottom in both directions.
      if (sort.endsWith('desc') && (sort.indexOf('model') === 0 || (a.cutDate && b.cutDate))) primary = -primary;
      return primary || (sort.indexOf('model') === 0 ? compareDate(a.cutDate, b.cutDate) : compare(a.model, b.model)) ||
        compare(a.operationName, b.operationName) || a.priceCents - b.priceCents;
    });
    var totals = { issuedQty: 0, acceptedQty: 0, paidQty: 0, unpaidQty: 0, amountCents: 0 }, packs = new Set();
    rows.forEach(function (row) {
      row.details.sort(function (a, b) { return compare(a.packId, b.packId); });
      Object.keys(totals).forEach(function (key) { totals[key] = safe(totals[key] + row[key]); });
      row.details.forEach(function (op) { packs.add(op.packId); });
    });
    return { rows: rows, totals: totals, packCount: packs.size, options: Object.assign({}, options) };
  }

  function exportRows(statement) {
    var rows = [
      ['Расчётная ведомость: выплата ' + date(statement.statementDate)],
      ['Швея', statement.sewerName],
      ['Сформировано', statement.generatedAt ? new Date(statement.generatedAt).toLocaleString('ru-RU') : ''],
      ['Дата ведомости — реквизит документа. Данные отражают текущее состояние, а не историю на эту дату.'],
      ['Модель', statement.options.model || 'Все модели', 'Крой с', statement.options.cutFrom || 'Все даты', 'по', statement.options.cutTo || 'Все даты'],
      ['Итого к выплате, ₽', statement.totals.amountCents / 100],
      [],
      ['Модель', 'Дата кроя', 'Операция', 'Выдано, шт.', 'Принято, шт.', 'Уже оплачено, шт.', 'Осталось оплатить, шт.', 'Расценка, ₽', 'Итого к выплате, ₽']
    ];
    statement.rows.forEach(function (row) {
      rows.push([row.model, date(row.cutDate), row.operationName, row.issuedQty, row.acceptedQty, row.paidQty, row.unpaidQty, row.priceCents / 100, row.amountCents / 100]);
    });
    var t = statement.totals;
    rows.push(['ИТОГО по операциям', '', '', t.issuedQty, t.acceptedQty, t.paidQty, t.unpaidQty, '', t.amountCents / 100], [],
      ['Расшифровка по паспортам'],
      ['Пачка ID', 'Паспорт', 'Модель', 'Дата кроя', 'Операция', 'Выдано, шт.', 'Принято, шт.', 'Уже оплачено, шт.', 'Осталось оплатить, шт.', 'Расценка, ₽', 'Итого к выплате, ₽']);
    statement.rows.forEach(function (row) { row.details.forEach(function (op) {
      rows.push([op.packId, op.passport, row.model, date(row.cutDate), row.operationName, op.issuedQty, op.acceptedQty, op.paidQty, op.unpaidQty, row.priceCents / 100, op.amountCents / 100]);
    }); });
    return rows;
  }
  function cell(value, separator) {
    if (typeof value === 'number') return String(value).replace('.', ',');
    var text = String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ');
    if (/^[=+\-@]/.test(text.trimStart())) text = "'" + text;
    return separator === '\t' ? text : '"' + text.replace(/"/g, '""') + '"';
  }
  function delimited(statement, separator) {
    return exportRows(statement).map(function (row) { return row.map(function (value) { return cell(value, separator); }).join(separator); }).join('\r\n');
  }

  var state = { operations: null, sewerName: '', generatedAt: '', statement: null, requestId: 0 };
  function el(id) { return root.document.getElementById('payroll-' + id); }
  function allowed() { return root.currentUser && ['admin', 'accountant'].indexOf(root.currentUser.role) >= 0; }
  function clear() {
    state.requestId++;
    state.operations = null; state.statement = null;
    el('result').innerHTML = ''; el('exports').hidden = true;
    root.showLoading('payroll', false);
  }
  function open(selectedSewer) {
    if (!allowed()) { root.showToast('Недостаточно прав для просмотра выплат', true); return; }
    root.showScreen('payroll', '🧾 Ведомость выплаты', 'Сверка по моделям, крою и операциям');
    clear();
    el('date').value = today(); el('cut-from').value = ''; el('cut-to').value = '';
    el('model').innerHTML = '<option value="">Все модели</option>';
    el('mode').value = 'due'; el('sort').value = 'cut_asc';
    el('sewer').innerHTML = '<option value="">— Выберите швею —</option>';
    var requestId = ++state.requestId;
    root.showLoading('payroll', true);
    root.API.getPaymentOperations().then(function (r) {
      if (requestId !== state.requestId) return;
      if (!r || !r.success || !Array.isArray(r.operations)) throw new Error('Не удалось загрузить список швей');
      var names = Array.from(new Set(r.operations.map(function (op) { return op.sewerName; }).filter(Boolean))).sort(compare);
      names.forEach(function (name) {
        var option = root.document.createElement('option'); option.value = name; option.textContent = name; el('sewer').appendChild(option);
      });
      root.showLoading('payroll', false);
      if (selectedSewer && names.indexOf(selectedSewer) >= 0) { el('sewer').value = selectedSewer; return load(); }
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      root.showLoading('payroll', false); root.showToast(error.message, true);
    });
  }
  function load() {
    if (!allowed()) { root.showToast('Недостаточно прав для просмотра выплат', true); return; }
    var sewerName = el('sewer').value;
    clear();
    if (!sewerName) { root.showToast('Выберите швею', true); return; }
    var requestId = ++state.requestId;
    root.showLoading('payroll', true);
    return root.API.getPayrollStatementOperations(sewerName).then(function (r) {
      if (requestId !== state.requestId) return;
      if (!r || !r.success) throw new Error('Не удалось загрузить ведомость');
      state.operations = r.operations; state.sewerName = sewerName; state.generatedAt = r.generatedAt;
      var model = el('model').value;
      el('model').innerHTML = '<option value="">Все модели</option>';
      Array.from(new Set(r.operations.map(function (op) { return op.model; }))).sort(compare).forEach(function (name) {
        var option = root.document.createElement('option'); option.value = name; option.textContent = name; el('model').appendChild(option);
      });
      el('model').value = model; if (!el('model').value) el('model').value = '';
      root.showLoading('payroll', false); render();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      root.showLoading('payroll', false);
      el('result').innerHTML = '<div class="card" role="alert">' + html(error.message) + '</div>';
    });
  }
  function detailsTable(row) {
    var h = '<table class="payroll-table"><caption>Паспорта: ' + html(row.model) + ', ' + date(row.cutDate) + ', ' + html(row.operationName) + '</caption><thead><tr><th>Пачка / паспорт</th><th>Выдано</th><th>Принято</th><th>Оплачено</th><th>Осталось оплатить</th><th>Сумма, ₽</th></tr></thead><tbody>';
    row.details.forEach(function (op) {
      h += '<tr><td>' + html(op.packId) + (op.passport ? '<br>' + html(op.passport) : '') +
        (op.packStatus === 'annulled' ? '<br><strong>Аннулированная пачка</strong>' : '') + '</td><td>' + op.issuedQty + '</td><td>' + op.acceptedQty +
        '</td><td>' + op.paidQty + '</td><td>' + op.unpaidQty + '</td><td>' + money(op.amountCents) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  function statementTable(s, printable) {
    var h = '<table class="payroll-table"><caption>Расчёт по моделям, дате кроя и операциям</caption><thead><tr><th>Модель</th><th>Дата кроя</th><th>Операция</th><th>Выдано</th><th>Принято</th><th>Оплачено</th><th>Осталось оплатить</th><th>Расценка, ₽</th><th>Итого, ₽</th></tr></thead><tbody>';
    s.rows.forEach(function (row) {
      h += '<tr><th scope="row">' + html(row.model) + '</th><td>' + date(row.cutDate) + '</td><td>' + html(row.operationName) +
        '</td><td>' + row.issuedQty + '</td><td>' + row.acceptedQty + '</td><td>' + row.paidQty + '</td><td>' + row.unpaidQty +
        '</td><td>' + money(row.priceCents) + '</td><td><strong>' + money(row.amountCents) + '</strong></td></tr>';
      if (!printable) h += '<tr><td colspan="9"><details><summary>Паспорта (' + row.details.length + ')</summary>' + detailsTable(row) + '</details></td></tr>';
    });
    var t = s.totals;
    h += '</tbody><tfoot><tr><th colspan="3">Итого по операциям</th><td>' + t.issuedQty + '</td><td>' + t.acceptedQty + '</td><td>' + t.paidQty +
      '</td><td>' + t.unpaidQty + '</td><td></td><td><strong>' + money(t.amountCents) + '</strong></td></tr></tfoot></table>';
    return h;
  }
  function render() {
    state.statement = null; el('exports').hidden = true;
    if (!state.operations || state.sewerName !== el('sewer').value) { el('result').innerHTML = ''; return; }
    try {
      var statementDate = el('date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) throw new Error('Укажите дату ведомости');
      var s = build(state.operations, { model: el('model').value, cutFrom: el('cut-from').value, cutTo: el('cut-to').value,
        mode: el('mode').value, sort: el('sort').value });
      s.statementDate = statementDate; s.sewerName = state.sewerName; s.generatedAt = state.generatedAt;
      state.statement = s;
      var total = build(state.operations, { mode: 'all' }).totals.amountCents;
      var h = '<div class="card"><h3>Выплата ' + date(statementDate) + ' · ' + html(s.sewerName) + '</h3>' +
        '<p><strong>К выплате по ведомости: ' + money(s.totals.amountCents) + ' ₽</strong></p>' +
        '<p>Всего текущий долг швее: ' + money(total) + ' ₽. Паспортов в ведомости: ' + s.packCount + '.</p>' +
        '<p class="payroll-note">Сформировано: ' + html(new Date(s.generatedAt).toLocaleString('ru-RU')) +
        '. Выдано и принято показано по операциям выбранных строк. «Итого» = (принято − уже оплачено) × расценка. Количество операций не равно количеству готовых изделий.</p></div>';
      if (s.rows.length) h += '<div class="card payroll-scroll" role="region" aria-label="Ведомость по операциям" tabindex="0">' + statementTable(s, false) + '</div>';
      else h += '<div class="card">По выбранным фильтрам строк нет.</div>';
      el('result').innerHTML = h;
      el('exports').hidden = s.rows.length === 0;
    } catch (error) { el('result').innerHTML = '<div class="card" role="alert">' + html(error.message) + '</div>'; }
  }
  function exportExcel() {
    if (!allowed() || !state.statement) return;
    var s = state.statement, blob = new Blob(['\uFEFF' + delimited(s, ';')], { type: 'text/csv;charset=utf-8;' }), url = root.URL.createObjectURL(blob);
    var a = root.document.createElement('a'); a.href = url;
    a.download = ('Выплата_' + s.statementDate + '_' + s.sewerName).replace(/[^a-zа-яё0-9_.-]+/gi, '_') + '.csv';
    root.document.body.appendChild(a); a.click(); a.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000);
  }
  function copySheets() {
    if (!allowed() || !state.statement) return;
    var text = delimited(state.statement, '\t');
    if (root.navigator.clipboard && root.isSecureContext) root.navigator.clipboard.writeText(text).then(function () {
      root.showToast('Ведомость скопирована. Вставьте её в Google Таблицу');
    }).catch(function () { root.fallbackCopyReport(text, function () { root.showToast('Вставьте ведомость в Google Таблицу'); }); });
    else root.fallbackCopyReport(text, function () { root.showToast('Вставьте ведомость в Google Таблицу'); });
  }
  function print() {
    if (!allowed() || !state.statement) return;
    var w = root.open('', '_blank');
    if (!w) { root.showToast('Разрешите всплывающие окна для печати ведомости', true); return; }
    var s = state.statement;
    w.document.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Выплата ' + date(s.statementDate) + '</title>' +
      '<style>body{font:13px Arial,sans-serif;color:#222;margin:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:7px;text-align:right}th:first-child,td:first-child{text-align:left}caption{text-align:left;margin:12px 0}p{line-height:1.5}.toolbar button{padding:12px;font-size:16px}@page{size:A4 landscape;margin:12mm}@media print{.toolbar{display:none}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body>' +
      '<div class="toolbar"><button onclick="window.print()">Печать / Сохранить PDF</button></div><h1>Выплата ' + date(s.statementDate) + '</h1><h2>' + html(s.sewerName) + '</h2>' +
      '<p>Модель: ' + html(s.options.model || 'Все модели') + '. Дата кроя: ' + (s.options.cutFrom ? date(s.options.cutFrom) : 'Все даты') + ' — ' +
      (s.options.cutTo ? date(s.options.cutTo) : 'Все даты') + '. Сформировано: ' + html(new Date(s.generatedAt).toLocaleString('ru-RU')) + '.</p>' +
      '<p>Расчётная ведомость по текущим данным. Дата выплаты — реквизит документа. Формирование не отмечает операции оплаченными. Итого = (принято − оплачено) × расценка.</p>' +
      statementTable(s, true) + '<p>Количество указано по операциям. Разные расценки показаны отдельными строками.</p></body></html>');
    w.document.close();
  }
  return { build: build, cents: cents, delimited: delimited, exportRows: exportRows, open: open, load: load, render: render, clear: clear,
    exportExcel: exportExcel, copySheets: copySheets, print: print };
});
