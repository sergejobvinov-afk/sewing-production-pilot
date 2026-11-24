(function (root, factory) {
  'use strict';
  var api = factory(root, typeof module === 'object' && module.exports ? require('./payroll-statement.js') : root.PayrollStatement,
    typeof module === 'object' && module.exports ? require('./payroll-history.js') : root.PayrollHistory);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PayrollRecovery = api;
    root.openPayrollRecovery = api.open;
    root.loadPayrollRecovery = api.load;
    root.clearPayrollRecovery = api.clear;
    root.filterPayrollRecovery = api.filter;
    root.selectAllPayrollRecovery = api.selectAll;
    root.recordPayrollRecovery = api.record;
    root.exportPayrollRecovery = api.exportExcel;
    root.exportRecordedPayrollRecovery = api.exportRecorded;
  }
})(typeof window === 'object' ? window : globalThis, function (root, payroll, history) {
  'use strict';
  function quantity(value) {
    if (value === null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error('Некорректное количество в сверке');
    return Number(value);
  }
  function safe(value) { if (!Number.isSafeInteger(value)) throw new Error('Сумма превышает допустимое значение'); return value; }
  function signedCents(value) { var s=String(value);return s[0]==='-'?-payroll.cents(s.slice(1)):payroll.cents(value); }
  function html(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function money(value) { return (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }
  function date(value) { return value.slice(8,10) + '.' + value.slice(5,7) + '.' + value.slice(0,4); }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parsed=new Date(value+'T12:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  }
  function today() { return new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date()); }
  function build(data, options) {
    options = options || {};
    if (!data || !data.success || !validDate(data.paymentDate) || !Array.isArray(data.operations)) throw new Error('Не удалось загрузить сверку');
    var seen = new Set(), rows = [], groups = new Map();
    data.operations.forEach(function (op) {
      var id = String(op.operationId);
      if (!/^[0-9]+$/.test(id) || seen.has(id)) throw new Error('Неоднозначная операция в сверке');
      seen.add(id);
      if (!op.packId || !op.operationName || !op.sewerName || !op.model || !/^[a-f0-9]{32}$/.test(op.fingerprint)) throw new Error('Неполные данные операции');
      var accepted = quantity(op.acceptedNow), paid = quantity(op.paidQty), price = payroll.cents(op.price);
      if (paid > accepted) throw new Error('Оплаченное количество превышает принятое');
      var review = op.acceptedBefore === null;
      if (review !== op.needsReview) throw new Error('Не подтверждена история приёмки');
      var before = review ? null : quantity(op.acceptedBefore), add = review ? null : Math.max(0, before - paid);
      if (!review && (before > accepted || add !== quantity(op.recoveryQty) || quantity(op.remainingAfter) !== accepted - Math.max(before,paid))) throw new Error('Расчёт изменился. Обновите сверку');
      if (options.sewer && op.sewerName !== options.sewer || options.model && op.model !== options.model) return;
      if (!review && before === 0) return;
      var group = groups.get(op.sewerName);
      if (!group) { group = { name:op.sewerName,beforeQty:0,coveredQty:0,addQty:0,amountCents:0,reviewCount:0,operationCount:0 }; groups.set(op.sewerName,group); }
      if (review) group.reviewCount++;
      else {
        group.beforeQty = safe(group.beforeQty + before); group.coveredQty = safe(group.coveredQty + Math.min(paid,before));
        group.addQty = safe(group.addQty + add); group.amountCents = safe(group.amountCents + safe(add * price));
        if (add > 0) group.operationCount++;
      }
      if (!review && !add && options.mode !== 'all') return;
      rows.push(Object.assign({},op,{ id:id,priceCents:price,amountCents:review?0:safe(add*price),addQty:add }));
    });
    var summary = Array.from(groups.values()).filter(function (group) { return options.mode==='all'||group.operationCount>0||group.reviewCount>0; }), total = { amountCents:0,operationCount:0,reviewCount:0 };
    summary.forEach(function (group) { Object.keys(total).forEach(function (key) { total[key] = safe(total[key]+group[key]); }); });
    return { paymentDate:data.paymentDate,generatedAt:data.generatedAt,rows:rows,groups:summary,totals:total };
  }
  function selection(report, ids) {
    var items = [], amount = 0, groups = new Map();
    report.rows.forEach(function (row) {
      if (!ids.has(row.id)) return;
      if (row.needsReview || !row.addQty) throw new Error('Выбрана неподтверждённая операция');
      items.push({ operationId:row.id,fingerprint:row.fingerprint });
      amount = safe(amount+row.amountCents); groups.set(row.sewerName,safe((groups.get(row.sewerName)||0)+row.amountCents));
    });
    if (items.length !== ids.size) throw new Error('Выбранные операции изменились. Обновите сверку');
    return { items:items,amountCents:amount,groups:Array.from(groups,function (entry) { return { name:entry[0],amountCents:entry[1] }; }) };
  }
  function csv(report) {
    var rows = [['Сверка прошлой выплаты',report.paymentDate],['Часовой пояс','Europe/Moscow'],
      ['К восстановлению в учёте, ₽',report.totals.amountCents/100],
      ['Это сверка текущего учёта. Сохранение файла не отмечает оплату. Уже учтённые оплаты засчитываются в раннюю работу.'],[],
      ['Швея','Модель','Дата кроя','Пачка ID','Паспорт','Операция','Принято к дате выплаты','Сейчас принято','Учтено оплаченных сейчас','Добавить в оплату','Расценка, ₽','Сумма, ₽','Проверка']];
    report.rows.forEach(function (r) { rows.push([r.sewerName,r.model,r.cutDate||'',r.packId,r.passport||'',r.operationName,r.acceptedBefore,r.acceptedNow,r.paidQty,r.addQty,r.priceCents/100,r.amountCents/100,r.needsReview?'Требуется проверка истории':'История подтверждена']); });
    return rows.map(function (row) { return row.map(function (value) {
      if (typeof value === 'number') return String(value).replace('.',',');
      var text = String(value==null?'':value).replace(/[\r\n\t]/g,' '); if (/^[=+\-@]/.test(text.trimStart())) text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    }).join(';'); }).join('\r\n');
  }

  function receipts(data,options) {
    options=options||{};var entries=[],groups=new Map(),models=new Map(),seen=new Set(),amount=0,paidAmount=0,reversedAmount=0;
    var journal=history.build(data);
    (data.payments||[]).concat(journal.payments).forEach(function(batch){
      if(batch.paymentDate!==data.paymentDate||!Array.isArray(batch.entries)||batch.entries.length!==Number(batch.count))throw new Error('Неполная сохранённая ведомость');
      var batchAmount=0;
      batch.entries.forEach(function(entry){
        if(!entry.eventId||seen.has(entry.eventId))throw new Error('Повторная строка сохранённой выплаты');seen.add(entry.eventId);
        var direction=batch.source==='payment_history'&&entry.direction===-1?-1:1;
        var price=payroll.cents(entry.price),qty=direction*quantity(entry.qty),lineAmount=safe(price*qty);
        if(lineAmount!==direction*payroll.cents(entry.amount))throw new Error('Не сходится сумма сохранённой выплаты');batchAmount=safe(batchAmount+lineAmount);
        if(options.sewer&&entry.sewerName!==options.sewer||options.model&&entry.model!==options.model)return;
        var row=Object.assign({},entry,{qty:qty,paymentDate:batch.paymentDate,recordedAt:entry.recordedAt||batch.recordedAt,batchId:batch.batchId,priceCents:price,amountCents:lineAmount});
        entries.push(row);amount=safe(amount+lineAmount);groups.set(entry.sewerName,safe((groups.get(entry.sewerName)||0)+lineAmount));
        if(direction<0)reversedAmount=safe(reversedAmount-lineAmount);else paidAmount=safe(paidAmount+lineAmount);
        var key=JSON.stringify([entry.sewerName,entry.model]),model=models.get(key);
        if(!model){model={sewerName:entry.sewerName,model:entry.model,qty:0,amountCents:0,packs:new Set(),calculations:new Map()};models.set(key,model);}
        model.qty=safe(model.qty+qty);model.amountCents=safe(model.amountCents+lineAmount);model.packs.add(entry.packId);
        var calculationKey=JSON.stringify([entry.cutDate||'',entry.operationName,price,direction]),calculation=model.calculations.get(calculationKey);
        if(!calculation){calculation={cutDate:entry.cutDate||'',operationName:entry.operationName,priceCents:price,qty:0,amountCents:0};model.calculations.set(calculationKey,calculation);}
        if(direction<0)calculation.reversal=true;
        calculation.qty=safe(calculation.qty+qty);calculation.amountCents=safe(calculation.amountCents+lineAmount);
      });
      if(batchAmount!==signedCents(batch.amount))throw new Error('Не сходится итог сохранённой выплаты');
    });
    var summaries=Array.from(models.values(),function(model){
      return {sewerName:model.sewerName,model:model.model,qty:model.qty,amountCents:model.amountCents,passportCount:model.packs.size,
        calculations:Array.from(model.calculations.values()).sort(function(a,b){return a.cutDate.localeCompare(b.cutDate)||a.operationName.localeCompare(b.operationName,'ru')||a.priceCents-b.priceCents;})};
    }).sort(function(a,b){return a.sewerName.localeCompare(b.sewerName,'ru')||a.model.localeCompare(b.model,'ru');});
    return {entries:entries,amountCents:amount,paidAmountCents:paidAmount,reversedAmountCents:reversedAmount,
      issues:journal.issues.filter(function(issue){return(!options.sewer||issue.sewerName===options.sewer)&&(!options.model||issue.model===options.model);}),
      models:summaries,groups:Array.from(groups,function(x){return{name:x[0],amountCents:x[1]};}).sort(function(a,b){return a.name.localeCompare(b.name,'ru');})};
  }
  function receiptSummaryHtml(receipt,expand) {
    return receipt.groups.map(function(group){
      var models=receipt.models.filter(function(model){return model.sewerName===group.name;});
      var h='<section><h4>'+html(group.name)+' — '+money(group.amountCents)+' ₽</h4><div class="payroll-scroll"><table class="payroll-table recovery-models"><caption>Сводная по моделям · '+html(group.name)+'</caption><thead><tr><th scope="col">Модель</th><th scope="col">Паспорта</th><th scope="col">Оплачено по операциям, шт.</th><th scope="col">Выплачено, ₽</th></tr></thead><tbody>';
      models.forEach(function(model){h+='<tr><th scope="row">'+html(model.model)+'</th><td>'+model.passportCount+'</td><td>'+model.qty+'</td><td><strong>'+money(model.amountCents)+'</strong></td></tr>';});
      h+='</tbody><tfoot><tr><th scope="row" colspan="3">Итого · '+html(group.name)+'</th><td><strong>'+money(group.amountCents)+'</strong></td></tr></tfoot></table></div>';
      h+='<details'+(expand?' open':'')+'><summary>Расчёт по моделям, дате кроя и операциям · '+html(group.name)+'</summary><p class="payroll-note recovery-scroll-note">Таблицу расчёта можно прокрутить вправо →</p><div class="payroll-scroll"><table class="payroll-table"><caption>Оплаченное количество × сохранённая расценка</caption><thead><tr><th scope="col">Модель</th><th scope="col">Дата кроя</th><th scope="col">Операция</th><th scope="col">Оплачено, шт.</th><th scope="col">Расценка, ₽</th><th scope="col">Расчёт, ₽</th><th scope="col">Выплачено, ₽</th></tr></thead><tbody>';
      models.forEach(function(model){model.calculations.forEach(function(row){
        h+='<tr><th scope="row">'+html(model.model)+'</th><td>'+html(row.cutDate?date(row.cutDate):'Не указана')+'</td><td>'+html(row.operationName)+(row.reversal?'<br><strong>Отмена отметки оплаты</strong>':'')+'</td><td>'+row.qty+'</td><td>'+money(row.priceCents)+'</td><td>'+row.qty+' × '+money(row.priceCents)+'</td><td>'+money(row.amountCents)+'</td></tr>';
      });h+='<tr><th scope="row" colspan="6">Итого · '+html(model.model)+'</th><td><strong>'+money(model.amountCents)+'</strong></td></tr>';});
      return h+'</tbody><tfoot><tr><th scope="row" colspan="6">Всего выплачено · '+html(group.name)+'</th><td><strong>'+money(group.amountCents)+'</strong></td></tr></tfoot></table></div></details></section>';
    }).join('');
  }
  function receiptCsv(receipt) {
    var rows=[['Сохранённая выплата','Дата внесения в учёт','Швея','Модель','Дата кроя','Пачка ID','Паспорт','Операция','Оплачено, шт.','Расценка, ₽','Сумма, ₽','Номер записи']];
    receipt.entries.forEach(function(r){rows.push([r.paymentDate,r.recordedAt,r.sewerName,r.model,r.cutDate,r.packId,r.passport,r.operationName,r.qty,r.priceCents/100,r.amountCents/100,r.batchId]);});
    rows.push(['ИТОГО','','','','','','','','','',receipt.amountCents/100]);
    return rows.map(function(row){return row.map(function(value){if(typeof value==='number')return String(value).replace('.',',');var s=String(value==null?'':value).replace(/[\r\n\t]/g,' ');if(/^[=+\-@]/.test(s.trimStart()))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(';');}).join('\r\n');
  }
  function filterChoices(data) {
    var rows=data.operations.filter(function(row){return row.needsReview||row.acceptedBefore>0;});
    rows=rows.concat(receipts(data).entries);
    function names(field){return Array.from(new Set(rows.map(function(row){return row[field];}).filter(function(value){return typeof value==='string'&&value.trim();}))).sort(function(a,b){return a.localeCompare(b,'ru');});}
    return {sewer:names('sewerName'),model:names('model')};
  }
  var state = { data:null,report:null,receipt:null,selected:new Set(),request:0,busy:false,pending:null };
  function el(id) { return root.document.getElementById('recovery-'+id); }
  function allowed() { return root.currentUser && ['admin','accountant'].indexOf(root.currentUser.role)>=0; }
  function filterStatus(loading,message) {
    el('sewer').disabled=loading;el('model').disabled=loading;el('filter-status').textContent=message||'';
  }
  function clear() {
    if (state.busy) return;
    state.request++;state.data=null;state.report=null;state.selected.clear();state.pending=null;
    state.receipt=null;el('history').innerHTML='';el('result').innerHTML='';el('actions').hidden=true;el('notice').innerHTML='';filterStatus(false,'');root.showLoading('payroll-recovery',false);
  }
  function open() {
    if (!allowed() || typeof root.API.getPayrollRecovery !== 'function') { root.showToast('Недостаточно прав для сверки выплаты',true); return; }
    if (state.busy) return;
    root.showScreen('payroll-recovery','🗓️ Прошлая выплата','Восстановление пропущенной отметки');clear();
    var requested = new URLSearchParams(root.location.search).get('payrollDate');
    el('date').value = requested && validDate(requested) && requested<=today() ? requested : today();
    el('sewer').innerHTML='<option value="">Все швеи</option>';el('model').innerHTML='<option value="">Все модели</option>';el('mode').value='due';
    return load();
  }
  function load() {
    if (!allowed() || state.busy) return;
    var paymentDate=el('date').value;
    clear();
    if (!validDate(paymentDate) || paymentDate>today()) { filterStatus(false,'Укажите корректную дату, чтобы загрузить список швей.');root.showToast('Укажите дату состоявшейся выплаты',true); return; }
    var request=++state.request;filterStatus(true,'Загружаю швей и модели за выбранную дату...');root.showLoading('payroll-recovery',true);
    return root.API.getPayrollRecovery(paymentDate).then(function (data) {
      if (request!==state.request || paymentDate!==el('date').value || !allowed()) return;
      build(data);receipts(data);var choices=filterChoices(data);state.data=data;
      ['sewer','model'].forEach(function (key) {
        var value=el(key).value;el(key).innerHTML='<option value="">'+(key==='sewer'?'Все швеи':'Все модели')+'</option>';
        choices[key].forEach(function (name) {
          var option=root.document.createElement('option');option.value=name;option.textContent=name;el(key).appendChild(option);
        });el(key).value=value;if (!el(key).value) el(key).value='';
      });filterStatus(false,choices.sewer.length?'Выберите швею — суммы и сохранённая ведомость отфильтруются автоматически.':'За эту дату нет принятой работы или сохранённых выплат.');render();
    }).catch(function (error) { if (request===state.request) {filterStatus(false,'Список швей не загружен. Нажмите «Обновить данные выплаты».');el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>';} })
      .finally(function () { if (request===state.request) {el('sewer').disabled=false;el('model').disabled=false;root.showLoading('payroll-recovery',false);} });
  }
  function filter() { if (!state.busy) { state.selected.clear();render(); } }
  function render() {
    if (!state.data) return;
    try {
      var report=build(state.data,{ sewer:el('sewer').value,model:el('model').value,mode:el('mode').value });state.report=report;
      state.receipt=receipts(state.data,{sewer:el('sewer').value,model:el('model').value});
      var saved=state.receipt,history='';
      if(saved.issues.length){
        history='<div class="card" role="alert"><h3>Состав выплаты требует проверки</h3><p>Не удалось подтвердить всю историю оплаты. Сумму выплаты не показываю как окончательную.</p>'+saved.issues.map(function(issue){return'<p>'+html(issue.message)+'</p>';}).join('')+'</div>';
      }else if(saved.entries.length){
        history='<div class="card"><h3>✅ Сохранённая выплата '+date(report.paymentDate)+'</h3><p><strong>Выплачено по ведомости: '+money(saved.amountCents)+' ₽ · Строк операций: '+saved.entries.length+'</strong></p>'+
          (saved.reversedAmountCents?'<p>Отметки оплаты: '+money(saved.paidAmountCents)+' ₽ · Отмены отметок: '+money(saved.reversedAmountCents)+' ₽ · Итог учёта: '+money(saved.amountCents)+' ₽. Отмена отметки не подтверждает возврат денег.</p>':'')+
          '<p class="payroll-note">Учитываются обычные отметки оплаты за выбранный день и восстановленные выплаты с этой датой. Ранее оплаченные количества повторно не входят в сумму. Для старых отметок расценка берётся из операции пачки, где она фиксируется при выдаче. Количество суммируется по операциям, а не по готовым изделиям.</p>'+
          receiptSummaryHtml(saved,!!el('sewer').value)+
          '<button class="action-btn btn-secondary" onclick="exportRecordedPayrollRecovery()">📥 Скачать состав сохранённой выплаты</button><p class="payroll-note">Эти суммы уже внесены в учёт. Выгрузка содержит каждый паспорт, операцию, оплаченное количество и расценку. Дата выплаты и дата внесения записи показаны отдельно.</p></div>';
      }else history='<div class="card"><h3>Отмеченная выплата '+date(report.paymentDate)+'</h3><p>По выбранным швее и модели записей оплаты за этот день нет. Это не подтверждает, что зарплату не выдавали.</p></div>';
      el('history').innerHTML=history;
      var h='<div class="card"><h3>Проверка пропущенных отметок на '+date(report.paymentDate)+'</h3><p><strong>Не отмечено в учёте: '+money(report.totals.amountCents)+' ₽</strong></p><p>Операций к восстановлению: '+report.totals.operationCount+'. Требуют отдельной проверки: '+report.totals.reviewCount+'.</p><p class="payroll-note">Это сумма пропущенных отметок, а не сумма выплаченной зарплаты. Сохранённая выплата показана выше. Количество учитывается по операциям.</p></div>';
      report.groups.forEach(function (g) {
        h+='<div class="card"><strong>'+html(g.name)+' — '+money(g.amountCents)+' ₽</strong><p>Принято к дате: '+g.beforeQty+' · Уже учтено: '+g.coveredQty+' · Добавить: '+g.addQty+'</p><p>Операций к отметке: '+g.operationCount+(g.reviewCount?' · Проверить: '+g.reviewCount:'')+'</p></div>';
      });
      if (report.rows.length) {
        h+='<details class="card"><summary>Паспорта и операции: '+report.rows.length+' — раскрыть для сверки</summary><div class="payroll-scroll"><table class="payroll-table"><caption>Состав прошлой выплаты</caption><thead><tr><th>Выбрать</th><th>Швея / модель / крой / паспорт</th><th>Операция</th><th>Принято к дате</th><th>Учтено</th><th>Добавить</th><th>Расценка, ₽</th><th>Сумма, ₽</th></tr></thead><tbody>';
        report.rows.forEach(function (r) {
          h+='<tr><td>'+(r.addQty>0&&!r.needsReview?'<input type="checkbox" data-recovery-id="'+r.id+'" aria-label="'+html(r.sewerName+', '+r.packId+', '+r.operationName)+'" style="width:24px;height:24px;"'+(state.selected.has(r.id)?' checked':'')+'>':'—')+'</td><td>'+html(r.sewerName)+'<br><strong>'+html(r.model)+'</strong><br>'+(r.cutDate?date(r.cutDate):'Крой не указан')+'<br>'+html(r.packId)+' · '+html(r.passport)+'</td><td>'+html(r.operationName)+'</td><td>'+(r.needsReview?'Проверить журнал':r.acceptedBefore)+'</td><td>'+(r.needsReview?'—':Math.min(r.paidQty,r.acceptedBefore))+'</td><td>'+(r.needsReview?'—':r.addQty)+'</td><td>'+money(r.priceCents)+'</td><td>'+money(r.amountCents)+'</td></tr>';
        });h+='</tbody></table></div></details>';
      } else h+='<div class="card">По выбранным фильтрам пропущенных отметок нет.</div>';
      el('result').innerHTML=h;el('actions').hidden=!report.rows.length;
      el('result').querySelectorAll('[data-recovery-id]').forEach(function (input) { input.addEventListener('change',function () {
        if (state.busy) return; var id=input.getAttribute('data-recovery-id');if (input.checked) state.selected.add(id);else state.selected.delete(id);updateSelection();
      }); });updateSelection();
    } catch (error) { state.report=null;el('actions').hidden=true;el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>'; }
  }
  function updateSelection() {
    if (!state.report) return;
    var selected=selection(state.report,state.selected),available=state.report.rows.filter(function (r) { return r.addQty>0&&!r.needsReview; }).length;
    el('selection').textContent='Выбрано операций: '+selected.items.length+' · К отметке: '+money(selected.amountCents)+' ₽';
    el('record').disabled=state.busy||!selected.items.length;el('select-all').checked=available>0&&selected.items.length===available;
  }
  function selectAll(checked) {
    if (state.busy || !state.report) return;
    state.selected.clear();if (checked) state.report.rows.forEach(function (r) { if (r.addQty>0&&!r.needsReview) state.selected.add(r.id); });render();
  }
  function setBusy(busy) {
    state.busy=busy;root.document.querySelectorAll('#screen-payroll-recovery input,#screen-payroll-recovery select,#screen-payroll-recovery button').forEach(function (input) { input.disabled=busy; });updateSelection();
  }
  function record() {
    if (!allowed() || state.busy || !state.report || !state.data || el('date').value!==state.report.paymentDate) return;
    var selected=selection(state.report,state.selected);if (!selected.items.length) return;
    var existing=root.document.getElementById('recovery-confirm');if (existing) return;
    var paymentDate=state.report.paymentDate,dialog=root.document.createElement('dialog');dialog.id='recovery-confirm';dialog.setAttribute('aria-label','Подтверждение прошлой выплаты');
    dialog.innerHTML='<style>#recovery-confirm{width:min(620px,94vw);max-width:94vw;max-height:85vh;margin:auto;padding:20px;border:0;border-radius:14px;overflow:auto;background:white;color:#222}#recovery-confirm::backdrop{background:rgba(0,0,0,.5)}#recovery-confirm .confirm-actions{position:sticky;bottom:-20px;background:white;padding:12px 0}</style>'+
      '<h3>Внести выплату '+date(paymentDate)+'?</h3><p>Подтвердите, что эти суммы зарплаты уже выданы:</p>'+selected.groups.map(function(g){return '<p><strong>'+html(g.name)+'</strong>: '+money(g.amountCents)+' ₽</p>';}).join('')+
      '<p><strong>Всего: '+money(selected.amountCents)+' ₽ · Операций: '+selected.items.length+'</strong></p><p class="payroll-note">Будут добавлены только выбранные отметки оплаты. Работа после даты выплаты останется к оплате. Деньги не переводятся.</p>'+
      '<div class="confirm-actions"><button class="action-btn btn-secondary" type="button" data-cancel>Отмена, сверить ещё раз</button><button class="action-btn btn-success" type="button" data-confirm>Да, зарплата выдана — внести в учёт</button></div>';
    dialog.querySelector('[data-cancel]').addEventListener('click',function(){dialog.close();});
    dialog.querySelector('[data-confirm]').addEventListener('click',function(){dialog.close();apply(paymentDate,selected);});
    dialog.addEventListener('close',function(){dialog.remove();});root.document.body.appendChild(dialog);dialog.showModal();
  }
  function apply(paymentDate,selected) {
    if (!allowed() || state.busy) return;
    var key=JSON.stringify([paymentDate,selected.items]);
    if (!state.pending || state.pending.key!==key) state.pending={ key:key,id:root.crypto.randomUUID() };
    setBusy(true);root.showLoading('payroll-recovery',true);
    return root.API.recordPayrollRecovery(paymentDate,selected.items,state.pending.id).then(function (result) {
      if (!result || !result.success) throw new Error(result&&result.message||'Не удалось внести выплату');
      state.pending=null;setBusy(false);
      return load().then(function () { el('notice').innerHTML='<div class="card" role="status">Выплата '+date(paymentDate)+' внесена в учёт. Операций: '+result.count+'. Сумма: '+html(result.amount)+' ₽. Номер записи: '+html(result.batchId)+'.</div>'; });
    }).catch(function (error) { el('notice').innerHTML='<div class="card" role="alert">'+html(error.message)+' При потере связи повторите подтверждение с тем же выбором: повторная запись не увеличит оплату.</div>'; })
      .finally(function () { setBusy(false);root.showLoading('payroll-recovery',false); });
  }
  function exportExcel() {
    if (!allowed() || !state.report) return;
    var blob=new Blob(['\uFEFF'+csv(state.report)],{type:'text/csv;charset=utf-8;'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');
    a.href=url;a.download='Сверка_выплаты_'+state.report.paymentDate+'.csv';root.document.body.appendChild(a);a.click();a.remove();root.setTimeout(function () { root.URL.revokeObjectURL(url); },1000);
  }
  function exportRecorded(){
    if(!allowed()||!state.receipt||!state.receipt.entries.length||state.receipt.issues.length)return;
    var blob=new Blob(['\uFEFF'+receiptCsv(state.receipt)],{type:'text/csv;charset=utf-8;'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');
    a.href=url;a.download='Сохранённая_выплата_'+state.data.paymentDate+'.csv';root.document.body.appendChild(a);a.click();a.remove();root.setTimeout(function(){root.URL.revokeObjectURL(url);},1000);
  }
  return { build:build,selection:selection,csv:csv,receipts:receipts,receiptCsv:receiptCsv,filterChoices:filterChoices,open:open,load:load,clear:clear,filter:filter,selectAll:selectAll,record:record,exportExcel:exportExcel,exportRecorded:exportRecorded };
});
